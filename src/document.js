import { compileStroke } from './instance.js';
import { makeSymmetrySnapshot, groupFromSnapshot } from './instance.js';
import { normalizeBrush } from './brush.js';
import { encodePNG } from './png.js';
import { Surface, renderDocument } from './raster.js';

export const DOCUMENT_VERSION = 1;
export const MIN_CANVAS = 64;
export const MAX_CANVAS = 4096;

function assertCanvas(width, height) {
  for (const [name, value] of [['width', width], ['height', height]]) {
    if (!Number.isInteger(value) || value < MIN_CANVAS || value > MAX_CANVAS) {
      throw new RangeError(`${name} must be an integer in [${MIN_CANVAS}, ${MAX_CANVAS}]`);
    }
  }
}

/**
 * 纯文档模型。笔画一旦加入即冻结其对称快照与笔刷参数；
 * 后续修改工具设置不会回溯改写既有笔画。
 */
export class SketchDocument {
  constructor({ width = 900, height = 640, background = '#ffffff', title = '对称笔迹' } = {}) {
    assertCanvas(width, height);
    this.width = width;
    this.height = height;
    this.background = background;
    this.title = title;
    this.strokes = [];
    this.nextId = 1;
    this.compiledCache = new Map();
  }

  get strokeCount() {
    return this.strokes.length;
  }

  addStroke({ points, brush, symmetry, dedupePolicy, eventId }) {
    if (!Array.isArray(points) || points.length === 0) {
      throw new RangeError('a stroke needs at least one point');
    }
    const stroke = {
      id: `s${this.nextId}`,
      // 稳定身份：一次落笔（pointerdown→up）对应一个原始笔事件。
      // 对称实例是这一个事件经群变换派生的副本，共享同一 eventId。
      eventId: typeof eventId === 'string' && eventId.length > 0 ? eventId : `s${this.nextId}`,
      points: points.map((point) => ({ x: Number(point.x), y: Number(point.y) })),
      brush: normalizeBrush(brush),
      symmetry: makeSymmetrySnapshot(symmetry ?? {}),
      dedupePolicy: dedupePolicy ?? symmetry?.dedupePolicy ?? 'coverage-union',
      createdAt: this.strokes.length,
    };
    this.nextId += 1;
    this.strokes.push(stroke);
    const compiled = compileStroke(stroke);
    this.compiledCache.set(stroke.id, compiled);
    return compiled;
  }

  removeStroke(id) {
    const index = this.strokes.findIndex((stroke) => stroke.id === id);
    if (index < 0) return null;
    const [removed] = this.strokes.splice(index, 1);
    this.compiledCache.delete(id);
    return removed;
  }

  /**
   * 按原始笔事件撤销：一次轴线落笔只撤去它自己生成的全部对称副本，
   * 不触碰其它笔事件（包括先前同色的交叉笔画）。返回被移除的笔画。
   */
  removeStrokeByEvent(eventId) {
    const index = this.strokes.findIndex((stroke) => stroke.eventId === eventId);
    if (index < 0) return null;
    const [removed] = this.strokes.splice(index, 1);
    this.compiledCache.delete(removed.id);
    return removed;
  }

  getCompiled(id) {
    let compiled = this.compiledCache.get(id);
    if (!compiled) {
      const stroke = this.strokes.find((item) => item.id === id);
      if (!stroke) return null;
      compiled = compileStroke(stroke);
      this.compiledCache.set(id, compiled);
    }
    return compiled;
  }

  compiledStrokes() {
    return this.strokes.map((stroke) => this.getCompiled(stroke.id));
  }

  /** 渲染到软件表面。参数可覆盖尺寸/背景（例如透明导出）。 */
  render({ width = this.width, height = this.height, background = this.background } = {}) {
    const surface = new Surface(width, height, background);
    return renderDocument(
      { width, height, background, compiledStrokes: this.compiledStrokes() },
      { width, height, background }
    ).surface ?? surface;
  }

  renderWithReport(options = {}) {
    return renderDocument({
      width: options.width ?? this.width,
      height: options.height ?? this.height,
      background: options.background ?? this.background,
      compiledStrokes: this.compiledStrokes(),
    });
  }

  toPNG({ width = this.width, height = this.height, background = this.background } = {}) {
    const { surface } = this.renderWithReport({ width, height, background });
    return encodePNG(width, height, surface.toRGBA8());
  }

  /** 可重放序列化：只存原始笔画 + 冻结快照，重放时重新编译。 */
  toJSON() {
    return {
      version: DOCUMENT_VERSION,
      width: this.width,
      height: this.height,
      background: this.background,
      title: this.title,
      nextId: this.nextId,
      strokes: this.strokes.map((stroke) => ({
        id: stroke.id,
        eventId: stroke.eventId,
        // 保存原始双精度坐标，重放才能逐字节复现；四舍五入会改变像素。
        points: stroke.points.map((point) => ({ x: point.x, y: point.y })),
        brush: stroke.brush,
        symmetry: stroke.symmetry,
        dedupePolicy: stroke.dedupePolicy,
      })),
    };
  }

  static fromJSON(raw) {
    if (!raw || typeof raw !== 'object') throw new TypeError('invalid document data');
    if (raw.version !== DOCUMENT_VERSION) {
      throw new RangeError(`unsupported document version: ${raw.version}`);
    }
    const doc = new SketchDocument({
      width: raw.width,
      height: raw.height,
      background: raw.background,
      title: raw.title,
    });
    let maxId = 0;
    for (const stroke of raw.strokes ?? []) {
      const idMatch = /^s(\d+)$/.exec(String(stroke.id));
      const parsed = idMatch ? Number(idMatch[1]) : 0;
      if (parsed > maxId) maxId = parsed;
      doc.addStroke({
        points: stroke.points ?? [],
        brush: stroke.brush,
        symmetry: stroke.symmetry,
        dedupePolicy: stroke.dedupePolicy,
        // 旧版 v1 文档没有 eventId 时回落到笔画 id，身份仍然稳定。
        eventId: typeof stroke.eventId === 'string' ? stroke.eventId : stroke.id,
      });
    }
    doc.nextId = Math.max(doc.nextId, maxId + 1, Number(raw.nextId) || 1);
    return doc;
  }

  /** 从快照恢复后可做的自检：每个笔画仍绑定创建时的群。 */
  verifyBindings() {
    const issues = [];
    for (const stroke of this.strokes) {
      const group = groupFromSnapshot(stroke.symmetry);
      if (group.divisions !== stroke.symmetry.divisions) {
        issues.push({ id: stroke.id, reason: 'divisions mismatch' });
      }
      if (group.rule !== stroke.symmetry.rule) {
        issues.push({ id: stroke.id, reason: 'rule mismatch' });
      }
    }
    return issues;
  }
}

export function replayDocument(raw) {
  return SketchDocument.fromJSON(raw);
}
