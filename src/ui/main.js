import { SketchDocument, DOCUMENT_VERSION } from '../document.js';
import { compileStroke, makeSymmetrySnapshot, strokeOrbitIdentity } from '../instance.js';
import { makeGroup, normalizeAxisAngle } from '../group.js';
import { normalizeBrush, brushLocalPolygon, placePolygon } from '../brush.js';
import { Surface } from '../raster.js';
import { provenanceColor } from '../color.js';

const CANVAS_WIDTH = 900;
const CANVAS_HEIGHT = 640;
const MAX_DPR = 2;

const state = {
  doc: new SketchDocument({
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    background: '#ffffff',
  }),
  tool: {
    rule: 'dihedral',
    divisions: 6,
    axisAngleDeg: 0,
    reflection: 'mirror',
    dedupe: 'coverage-union',
    shape: 'nib',
    size: 16,
    aspect: 2.4,
    skew: 0.55,
    tiltDeg: 24,
    opacity: 0.9,
    color: '#1f2d3d',
  },
  center: { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 },
  pendingCenter: false,
  drawing: null,
  selectedId: null,
  showAxes: true,
  showProvenance: false,
  undoStack: [],
  redoStack: [],
  baseSurface: null,
  liveCompiled: null,
  cachedSurface: null,
};

const el = {
  base: document.getElementById('base-canvas'),
  live: document.getElementById('live-canvas'),
  guide: document.getElementById('guide-canvas'),
  result: document.getElementById('result-canvas'),
  wrap: document.getElementById('canvas-wrap'),
  status: document.getElementById('draw-status'),
  cursor: document.getElementById('cursor-readout'),
  toast: document.getElementById('toast'),
  strokeList: document.getElementById('stroke-list'),
  instanceList: document.getElementById('instance-list'),
  axisList: document.getElementById('axis-list'),
  resultCaption: document.getElementById('result-caption'),
  reflectionReadout: document.getElementById('reflection-readout'),
  axisNote: document.getElementById('axis-note'),
  statGroup: document.getElementById('stat-group'),
  statStrokes: document.getElementById('stat-strokes'),
  statSelected: document.getElementById('stat-selected'),
  statSelectedGroup: document.getElementById('stat-selected-group'),
  statWrites: document.getElementById('stat-writes'),
  statMerged: document.getElementById('stat-merged'),
  diagnosticStatus: document.getElementById('diagnostic-status'),
  diagnosticList: document.getElementById('diagnostic-list'),
};

const ctx = {
  base: el.base.getContext('2d'),
  live: el.live.getContext('2d'),
  guide: el.guide.getContext('2d'),
  result: el.result.getContext('2d'),
};

function toast(message, { error = false } = {}) {
  el.toast.textContent = message;
  el.toast.classList.toggle('error', error);
  el.toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.toast.classList.remove('show'), 2600);
}

function currentSymmetry() {
  return {
    rule: state.tool.rule,
    divisions: state.tool.divisions,
    axisAngle: (state.tool.axisAngleDeg * Math.PI) / 180,
    center: { ...state.center },
    reflection: state.tool.reflection,
    dedupePolicy: state.tool.dedupe,
  };
}

function currentBrush() {
  return {
    shape: state.tool.shape,
    size: state.tool.size,
    aspect: state.tool.aspect,
    skew: state.tool.skew,
    tiltDeg: state.tool.tiltDeg,
    opacity: state.tool.opacity,
    color: state.tool.color,
  };
}

/* ---------- 画布尺寸与坐标 ---------- */

function setupCanvas() {
  const rect = el.wrap.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const displayWidth = Math.max(200, Math.floor(rect.width));
  const displayHeight = Math.max(200, Math.floor(rect.height));
  state.view = { width: displayWidth, height: displayHeight, dpr };
  for (const canvas of [el.base, el.live, el.guide]) {
    canvas.width = Math.round(displayWidth * dpr);
    canvas.height = Math.round(displayHeight * dpr);
    canvas.dataset.dpr = String(dpr);
  }
  const scale = Math.min(displayWidth / CANVAS_WIDTH, displayHeight / CANVAS_HEIGHT);
  state.view.scale = scale;
  state.view.offsetX = (displayWidth - CANVAS_WIDTH * scale) / 2;
  state.view.offsetY = (displayHeight - CANVAS_HEIGHT * scale) / 2;
  el.wrap.style.setProperty('--paper-x', `${state.view.offsetX}px`);
  el.wrap.style.setProperty('--paper-y', `${state.view.offsetY}px`);
  el.wrap.style.setProperty('--paper-w', `${CANVAS_WIDTH * scale}px`);
  el.wrap.style.setProperty('--paper-h', `${CANVAS_HEIGHT * scale}px`);

  el.result.width = CANVAS_WIDTH;
  el.result.height = CANVAS_HEIGHT;
  el.result.style.aspectRatio = `${CANVAS_WIDTH} / ${CANVAS_HEIGHT}`;
  el.wrap.style.setProperty(
    '--paper-color',
    state.doc.background === 'transparent' ? '#ffffff' : state.doc.background
  );

  redrawAll({ immediate: true });
}

function toCanvasPoint(event) {
  const rect = el.wrap.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const { scale, offsetX, offsetY } = state.view;
  return {
    x: (x - offsetX) / scale,
    y: (y - offsetY) / scale,
  };
}

/* ---------- 软件表面 -> 浏览器绘制 ---------- */

function surfaceToImageData(surface) {
  const rgba = surface.toRGBA8();
  return new ImageData(new Uint8ClampedArray(rgba), surface.width, surface.height);
}

function drawSurfaceToContext(target, surface, dpr) {
  const offscreen = document.createElement('canvas');
  offscreen.width = surface.width;
  offscreen.height = surface.height;
  offscreen.getContext('2d').putImageData(surfaceToImageData(surface), 0, 0);
  target.save();
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.clearRect(0, 0, target.canvas.width, target.canvas.height);
  const { scale, offsetX, offsetY } = state.view;
  target.drawImage(
    offscreen,
    offsetX * dpr,
    offsetY * dpr,
    surface.width * scale * dpr,
    surface.height * scale * dpr
  );
  target.restore();
}

/* ---------- 渲染 ---------- */

function renderBaseSurface() {
  const { width, height, background } = state.doc;
  const surface = new Surface(width, height, background);
  for (const compiled of state.doc.compiledStrokes()) {
    surface.drawCompiledStroke(compiled);
  }
  state.baseSurface = surface;
}

function drawBase() {
  if (!state.view) return;
  if (!state.baseSurface) renderBaseSurface();
  drawSurfaceToContext(ctx.base, state.baseSurface, state.view.dpr);
}

function drawLivePreview() {
  const { dpr } = state.view;
  ctx.live.save();
  ctx.live.setTransform(1, 0, 0, 1, 0, 0);
  ctx.live.clearRect(0, 0, el.live.width, el.live.height);
  ctx.live.restore();
  if (state.liveCompiled && state.liveCompiled.orbit.length > 0) {
    const preview = new Surface(state.doc.width, state.doc.height, 'transparent');
    preview.drawCompiledStroke({ ...state.liveCompiled, dedupePolicy: 'coverage-union' });
    drawSurfaceToContext(ctx.live, preview, dpr);
  }
  if (state.drawing) drawInkPath(state.drawing.points);
}

/** 直接在显示坐标里画出用户原始笔迹（不被对称变换，用于显示“输入”）。 */
function drawInkPath(points) {
  if (points.length < 1) return;
  const { dpr, scale, offsetX, offsetY } = state.view;
  ctx.live.save();
  ctx.live.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.live.strokeStyle = 'rgba(47, 111, 237, 0.55)';
  ctx.live.lineWidth = 1.5;
  ctx.live.setLineDash([4, 4]);
  ctx.live.beginPath();
  points.forEach((point, index) => {
    const x = offsetX + point.x * scale;
    const y = offsetY + point.y * scale;
    if (index === 0) ctx.live.moveTo(x, y);
    else ctx.live.lineTo(x, y);
  });
  ctx.live.stroke();
  ctx.live.restore();
}

function drawGuides() {
  const { dpr, scale, offsetX, offsetY } = state.view;
  ctx.guide.save();
  ctx.guide.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.guide.clearRect(0, 0, el.guide.width, el.guide.height);
  el.guide.style.opacity = '1';
  // 轴线只画在纸张范围内。
  ctx.guide.beginPath();
  ctx.guide.rect(
    offsetX,
    offsetY,
    state.doc.width * scale,
    state.doc.height * scale
  );
  ctx.guide.clip();
  const symmetry = state.selectedCompiled?.snapshot ?? makeSymmetrySnapshot(currentSymmetry());
  const previewGroup = makeGroup({
    rule: symmetry.rule,
    divisions: symmetry.divisions,
    axisAngle: symmetry.axisAngle,
  });
  const cx = offsetX + symmetry.center.x * scale;
  const cy = offsetY + symmetry.center.y * scale;
  const reach = Math.max(el.guide.width, el.guide.height) * 2;

  ctx.guide.strokeStyle = 'rgba(47, 111, 237, 0.22)';
  ctx.guide.lineWidth = 1;
  for (const mirror of previewGroup.mirrorAxes) {
    drawGuideLine(cx, cy, mirror.angle, reach);
  }
  if (state.tool.rule === 'cyclic') {
    ctx.guide.strokeStyle = 'rgba(47, 111, 237, 0.12)';
    for (const ray of previewGroup.rotationRays) {
      drawGuideRay(cx, cy, ray.angle, reach);
    }
  }

  ctx.guide.fillStyle = 'rgba(47, 111, 237, 0.9)';
  ctx.guide.beginPath();
  ctx.guide.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.guide.fill();
  ctx.guide.strokeStyle = 'rgba(47, 111, 237, 0.5)';
  ctx.guide.beginPath();
  ctx.guide.arc(cx, cy, 10, 0, Math.PI * 2);
  ctx.guide.stroke();
  ctx.guide.restore();
}

function drawGuideLine(cx, cy, angle, reach) {
  const dx = Math.cos(angle) * reach;
  const dy = Math.sin(angle) * reach;
  ctx.guide.beginPath();
  ctx.guide.moveTo(cx - dx, cy - dy);
  ctx.guide.lineTo(cx + dx, cy + dy);
  ctx.guide.stroke();
}

function drawGuideRay(cx, cy, angle, reach) {
  ctx.guide.beginPath();
  ctx.guide.moveTo(cx, cy);
  ctx.guide.lineTo(cx + Math.cos(angle) * reach, cy + Math.sin(angle) * reach);
  ctx.guide.stroke();
}

function redrawAll({ immediate = false } = {}) {
  if (!state.view) return;
  drawBase();
  drawLivePreview();
  drawGuides();
  renderResult();
  updateReadouts();
  if (!immediate) el.status.textContent = `已同步 · ${state.doc.strokeCount} 笔`;
}

/* ---------- 结果区 ---------- */

function renderResult() {
  const width = CANVAS_WIDTH;
  const height = CANVAS_HEIGHT;
  const surface = new Surface(width, height, state.doc.background === 'transparent' ? 'transparent' : state.doc.background);
  const compiled = state.selectedCompiled ?? null;

  for (const item of state.doc.compiledStrokes()) surface.drawCompiledStroke(item);

  const rgba = surface.toRGBA8();
  const image = new ImageData(new Uint8ClampedArray(rgba), width, height);
  ctx.result.putImageData(image, 0, 0);

  if (state.showProvenance && compiled) {
    drawProvenanceOverlay(compiled);
  }
  if (compiled) {
    drawResultAxes(compiled.snapshot);
  } else {
    for (const item of state.doc.compiledStrokes()) {
      if (state.showAxes) drawResultAxes(item.snapshot);
    }
    if (state.doc.strokeCount === 0 && state.showAxes) drawResultAxes(currentSymmetry());
  }
}

function drawProvenanceOverlay(compiled) {
  ctx.result.save();
  ctx.result.globalCompositeOperation = 'source-over';
  const orderIds = compiled.group.elements.map((element) => element.id);
  for (const stamp of compiled.orbit) {
    const index = orderIds.indexOf(stamp.elementId);
    ctx.result.fillStyle = provenanceColor(index);
    ctx.result.globalAlpha = 0.55;
    const local = brushLocalPolygon({ ...compiled.brush, skew: stamp.skew });
    const polygon = placePolygon(local, stamp.theta, stamp.position.x, stamp.position.y);
    ctx.result.beginPath();
    polygon.forEach((point, i) => {
      if (i === 0) ctx.result.moveTo(point.x, point.y);
      else ctx.result.lineTo(point.x, point.y);
    });
    ctx.result.closePath();
    ctx.result.fill();
  }
  ctx.result.restore();
}

function drawResultAxes(snapshot) {
  const group = makeGroup({
    rule: snapshot.rule,
    divisions: snapshot.divisions,
    axisAngle: snapshot.axisAngle,
  });
  ctx.result.save();
  ctx.result.lineWidth = 1;
  const { x: cx, y: cy } = snapshot.center;
  const reach = CANVAS_WIDTH + CANVAS_HEIGHT;
  ctx.result.strokeStyle = 'rgba(47, 111, 237, 0.35)';
  ctx.result.setLineDash([6, 6]);
  for (const mirror of group.mirrorAxes) {
    const dx = Math.cos(mirror.angle) * reach;
    const dy = Math.sin(mirror.angle) * reach;
    ctx.result.beginPath();
    ctx.result.moveTo(cx - dx, cy - dy);
    ctx.result.lineTo(cx + dx, cy + dy);
    ctx.result.stroke();
  }
  if (group.rule === 'cyclic') {
    ctx.result.strokeStyle = 'rgba(47, 111, 237, 0.2)';
    for (const ray of group.rotationRays) {
      ctx.result.beginPath();
      ctx.result.moveTo(cx, cy);
      ctx.result.lineTo(cx + Math.cos(ray.angle) * reach, cy + Math.sin(ray.angle) * reach);
      ctx.result.stroke();
    }
  }
  ctx.result.setLineDash([]);
  ctx.result.fillStyle = 'rgba(47, 111, 237, 0.95)';
  ctx.result.beginPath();
  ctx.result.arc(cx, cy, 3.5, 0, Math.PI * 2);
  ctx.result.fill();
  ctx.result.restore();
}

/* ---------- 对称笔迹运行状态与异常标记 ---------- */

/**
 * 汇总当前作品的对称笔迹状态。anomalies 只标记真正异常的情况：
 *   - keep-all 政策会在轴/中心重复加深（用户显式选择的对照模式，给出提示级标记）；
 *   - 轨道写入数与“采样×群阶”不一致且无简并记录时，提示身份关系可能异常；
 *   - 简并实例的来源元素若在群中不存在，标记身份断裂。
 * 正常的 coverage-union 重合去重不会被当作异常（不允许伪报）。
 */
function collectSymmetryDiagnostics() {
  const anomalies = [];
  const summaries = [];
  for (const stroke of state.doc.strokes) {
    const compiled = state.doc.getCompiled(stroke.id);
    const identity = strokeOrbitIdentity(compiled);
    const expectedRaw = identity.sampleCount * identity.groupOrder;
    const accounted = identity.writeCount + identity.mergedSamples;
    const item = {
      strokeId: stroke.id,
      eventId: stroke.eventId,
      group: identity.group,
      writeCount: identity.writeCount,
      mergedSamples: identity.mergedSamples,
      degenerateCount: identity.degenerateCount,
    };
    summaries.push(item);

    if (identity.dedupePolicy === 'keep-all') {
      anomalies.push({
        level: 'warning',
        strokeId: stroke.id,
        reason: 'keep-all 政策：轴/中心处会重复加深（对照模式，非去重失效）',
      });
    }
    if (accounted !== expectedRaw) {
      anomalies.push({
        level: 'error',
        strokeId: stroke.id,
        reason: `轨道账目不平：写入 ${identity.writeCount} + 合并 ${identity.mergedSamples} ≠ 采样×群阶 ${expectedRaw}`,
      });
    }
    const validIds = new Set(compiled.group.elements.map((element) => element.id));
    for (const degenerate of identity.degenerateInstances) {
      for (const sourceId of degenerate.sourceElementIds) {
        if (!validIds.has(sourceId)) {
          anomalies.push({
            level: 'error',
            strokeId: stroke.id,
            reason: `简并实例 ${degenerate.elementId} 引用了群外元素 ${sourceId}，身份关系断裂`,
          });
        }
      }
    }
  }
  return {
    strokeCount: state.doc.strokeCount,
    healthy: anomalies.every((entry) => entry.level !== 'error'),
    anomalies,
    strokes: summaries,
  };
}

function renderDiagnostics() {
  const diagnostics = collectSymmetryDiagnostics();
  el.diagnosticList.innerHTML = '';
  if (state.doc.strokeCount === 0) {
    el.diagnosticStatus.textContent = '暂无笔迹；落笔后在此显示对称运行状态。';
    el.diagnosticStatus.classList.remove('error', 'warning');
    return;
  }
  if (diagnostics.anomalies.length === 0) {
    el.diagnosticStatus.textContent =
      `对称笔迹正常：${diagnostics.strokeCount} 笔，轴/中心简并副本均按覆盖并集只沉积一次。`;
    el.diagnosticStatus.classList.remove('error', 'warning');
  } else {
    const hasError = diagnostics.anomalies.some((entry) => entry.level === 'error');
    el.diagnosticStatus.textContent = hasError
      ? `检测到 ${diagnostics.anomalies.length} 项对称/轴向异常，请排查。`
      : `覆盖政策提示：${diagnostics.anomalies.length} 项（keep-all 对照模式）。`;
    el.diagnosticStatus.classList.toggle('error', hasError);
    el.diagnosticStatus.classList.toggle('warning', !hasError);
    for (const anomaly of diagnostics.anomalies) {
      const row = document.createElement('div');
      row.className = `diagnostic-row ${anomaly.level}`;
      row.textContent = `${anomaly.strokeId} · ${anomaly.reason}`;
      el.diagnosticList.append(row);
    }
  }
}

/* ---------- 读数与列表 ---------- */

function updateReadouts() {
  const currentSym = makeSymmetrySnapshot(currentSymmetry());
  const currentGroup = makeGroup({
    rule: currentSym.rule,
    divisions: currentSym.divisions,
    axisAngle: currentSym.axisAngle,
  });
  el.statGroup.textContent = `${currentGroup.rule === 'dihedral' ? 'D' : 'C'}${currentGroup.divisions} · ${currentGroup.order} 变换`;
  el.statStrokes.textContent = String(state.doc.strokeCount);
  el.statSelected.textContent = state.selectedId ?? '—';
  const compiled = state.selectedCompiled;
  el.statSelectedGroup.textContent = compiled
    ? `${compiled.group.rule === 'dihedral' ? 'D' : 'C'}${compiled.group.divisions} · ${compiled.group.order} 变换`
    : '—';
  el.statWrites.textContent = compiled ? String(compiled.writeCount) : '0';
  el.statMerged.textContent = compiled ? String(compiled.mergedSamples) : '0';
  el.reflectionReadout.textContent = compiled
    ? `反射语义：${compiled.snapshot.reflection === 'mirror' ? '严格镜像（skew 取反）' : '保留手性'}；覆盖政策：${compiled.dedupePolicy === 'coverage-union' ? '覆盖并集' : '保留全部'}`
    : '选择一条笔画查看其冻结的对称快照与实例来源。';

  renderStrokeList();
  renderInstanceList();
  renderAxisList(compiled?.group ?? currentGroup, compiled?.snapshot ?? currentSym);
  renderDiagnostics();
  if (compiled) {
    el.resultCaption.textContent = `结果区显示完整作品；高亮的轴线来自所选笔画 ${compiled.stroke.id} 的冻结群快照。`;
  } else if (state.doc.strokeCount > 0) {
    el.resultCaption.textContent = `结果区显示完整作品；轴线逐笔来自各自冻结的群快照。`;
  } else {
    el.resultCaption.textContent = '结果区将显示完整作品；当前轴线来自工具设置。';
  }
}

function renderStrokeList() {
  el.strokeList.innerHTML = '';
  if (state.doc.strokes.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = '画布还是空的。拖动开始画第一条笔画。';
    el.strokeList.append(empty);
    return;
  }
  for (const stroke of state.doc.strokes) {
    const compiled = state.doc.getCompiled(stroke.id);
    const identity = strokeOrbitIdentity(compiled);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'stroke-item';
    button.setAttribute('role', 'listitem');
    button.setAttribute('aria-current', String(stroke.id === state.selectedId));
    button.dataset.strokeId = stroke.id;
    const swatch = document.createElement('span');
    swatch.className = 'stroke-swatch';
    swatch.style.background = stroke.brush.color;
    const label = document.createElement('span');
    label.className = 'stroke-label';
    const name = document.createElement('span');
    name.className = 'stroke-name';
    name.textContent = stroke.id;
    const meta = document.createElement('span');
    meta.className = 'stroke-meta';
    const groupLabel = `${stroke.symmetry.rule === 'dihedral' ? 'D' : 'C'}${stroke.symmetry.divisions}`;
    const mergeNote = identity.degenerateCount > 0 ? ` · 轴上简并 ${identity.degenerateCount}` : '';
    meta.textContent = `${groupLabel} · ${identity.instanceCount} 实例 · 事件 ${stroke.eventId}${mergeNote}`;
    label.append(name, meta);
    const undoOne = document.createElement('span');
    undoOne.className = 'stroke-undo';
    undoOne.role = 'button';
    undoOne.tabIndex = 0;
    undoOne.setAttribute('aria-label', `撤销原始笔事件 ${stroke.eventId}（仅移除 ${stroke.id} 自身的对称副本）`);
    undoOne.title = `按原始笔事件撤销：只移除 ${stroke.id} 自己的副本，不影响其它笔画`;
    undoOne.textContent = '撤';
    const undoStroke = (event) => {
      event.stopPropagation();
      undoStrokeEvent(stroke.eventId, stroke.id);
    };
    undoOne.addEventListener('click', undoStroke);
    undoOne.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        undoStroke(event);
      }
    });
    button.append(swatch, label, undoOne);
    button.addEventListener('click', () => {
      state.selectedId = state.selectedId === stroke.id ? null : stroke.id;
      state.selectedCompiled = state.selectedId ? state.doc.getCompiled(state.selectedId) : null;
      redrawAll();
    });
    el.strokeList.append(button);
  }
}

/**
 * 按原始笔事件撤销：一次轴线落笔只撤去它自己生成的全部对称副本，
 * 先前另一支同色交叉笔画仍在原处。整个文档快照进入撤销栈，可用顶栏重做恢复。
 */
function undoStrokeEvent(eventId, strokeId) {
  const target = state.doc.strokes.find((stroke) => stroke.eventId === eventId);
  if (!target) {
    toast('找不到该笔事件，无法撤销', { error: true });
    return;
  }
  // 与顶栏撤销同一套快照机制：压入撤销栈，并把当前态压入重做栈，
  // 这样按笔撤销后仍可用顶栏“重做”恢复这一笔。
  const current = snapshotForUndo();
  state.undoStack.push(current);
  state.redoStack.push(current);
  const removed = state.doc.removeStrokeByEvent(eventId);
  if (!removed) {
    state.undoStack.pop();
    state.redoStack.pop();
    toast('撤销失败：笔事件已不存在', { error: true });
    return;
  }
  if (state.selectedId === strokeId || state.selectedId === removed.id) {
    state.selectedId = null;
    state.selectedCompiled = null;
  }
  state.baseSurface = null;
  refreshAfterMutation();
  toast(`已按笔事件撤销 ${removed.id}（其余笔画保持原位）`);
}

function renderInstanceList() {
  el.instanceList.innerHTML = '';
  const compiled = state.selectedCompiled;
  if (!compiled) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = '在“笔画”列表里选择一条，查看它由哪些群元素生成。';
    el.instanceList.append(note);
    return;
  }
  for (const instance of compiled.instances) {
    const row = document.createElement('div');
    row.className = 'instance-row';
    const id = document.createElement('span');
    id.className = 'instance-id';
    id.textContent = instance.elementId;
    id.style.color = provenanceColor(compiled.group.elements.findIndex((element) => element.id === instance.elementId));
    const detail = document.createElement('span');
    detail.className = 'instance-detail';
    const kind = instance.elementKind === 'reflection' ? '反射' : '旋转';
    const angle = instance.elementKind === 'reflection'
      ? `镜线 ${((instance.mirrorAngle ?? 0) * 180 / Math.PI).toFixed(1)}°`
      : `旋转 ${((instance.rotationAngle ?? 0) * 180 / Math.PI).toFixed(1)}°`;
    const sources = instance.sourceElementIds.length > 1
      ? ` · 合并自 ${instance.sourceElementIds.join('+')}`
      : '';
    detail.textContent = `${kind} · ${angle}${sources}`;
    const count = document.createElement('span');
    count.className = 'instance-count';
    count.textContent = `${instance.coverCount} 覆盖`;
    row.append(id, detail, count);
    el.instanceList.append(row);
  }
}

function renderAxisList(group, snapshot) {
  el.axisList.innerHTML = '';
  const reach = CANVAS_WIDTH + CANVAS_HEIGHT;
  const axes = group.mirrorAxes.length > 0
    ? group.mirrorAxes.map((mirror) => ({ angle: mirror.angle, label: `镜线 S${mirror.k}` }))
    : group.rotationRays.map((ray) => ({ angle: ray.angle, label: `旋转射线 R${ray.k}` }));
  for (const axis of axes) {
    const row = document.createElement('div');
    row.className = 'axis-row';
    row.style.color = 'rgba(47, 111, 237, 0.9)';
    const line = document.createElement('span');
    line.className = 'axis-line';
    const mid = axis.angle;
    line.style.transform = `rotate(${mid}rad)`;
    const label = document.createElement('span');
    label.textContent = axis.label;
    const angle = document.createElement('span');
    angle.textContent = `${((normalizeAxisAngle(axis.angle) * 180) / Math.PI).toFixed(1)}°`;
    row.append(line, label, angle);
    el.axisList.append(row);
  }
  el.axisNote.textContent = group.mirrorAxes.length > 0
    ? `D${group.divisions}：轴线两两夹角 ${(180 / group.divisions).toFixed(1)}°，相邻轴相差 π/${group.divisions}。`
    : `C${group.divisions}：只有旋转，共 ${group.rotationRays.length} 条等分射线。`;
}

/* ---------- 交互 ---------- */

function updateToolButtons() {
  document.querySelectorAll('[data-rule]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.rule === state.tool.rule));
  });
  document.querySelectorAll('[data-reflection]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.reflection === state.tool.reflection));
  });
  document.querySelectorAll('[data-dedupe]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.dedupe === state.tool.dedupe));
  });
  document.querySelectorAll('[data-shape]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.shape === state.tool.shape));
  });
  document.getElementById('reflection-field').style.display =
    state.tool.rule === 'dihedral' ? '' : 'none';
  document.getElementById('dedupe-hint').textContent =
    state.tool.dedupe === 'coverage-union'
      ? '轴上与中心处的简并副本只写入一次覆盖，避免透明色重复加深。'
      : '保留全部实例：同一点会被多次着色，仅用于对照“重复加深”。';
  const divisions = document.getElementById('divisions');
  divisions.value = String(state.tool.divisions);
  document.getElementById('divisions-value').textContent = String(state.tool.divisions);
  document.getElementById('axis-value').textContent = `${state.tool.axisAngleDeg}°`;
}

function bindControls() {
  document.querySelectorAll('[data-rule]').forEach((button) => {
    button.addEventListener('click', () => {
      state.tool.rule = button.dataset.rule;
      updateToolButtons();
      drawGuides();
      renderResult();
      updateReadouts();
    });
  });
  document.querySelectorAll('[data-reflection]').forEach((button) => {
    button.addEventListener('click', () => {
      state.tool.reflection = button.dataset.reflection;
      updateToolButtons();
    });
  });
  document.querySelectorAll('[data-dedupe]').forEach((button) => {
    button.addEventListener('click', () => {
      state.tool.dedupe = button.dataset.dedupe;
      updateToolButtons();
    });
  });
  document.querySelectorAll('[data-shape]').forEach((button) => {
    button.addEventListener('click', () => {
      state.tool.shape = button.dataset.shape;
      updateToolButtons();
    });
  });

  const divisions = document.getElementById('divisions');
  divisions.addEventListener('input', () => {
    state.tool.divisions = Number(divisions.value);
    document.getElementById('divisions-value').textContent = divisions.value;
    recomputeToolPreview();
  });
  const axis = document.getElementById('axis-angle');
  axis.addEventListener('input', () => {
    state.tool.axisAngleDeg = Number(axis.value);
    document.getElementById('axis-value').textContent = `${axis.value}°`;
    recomputeToolPreview();
  });
  const size = document.getElementById('size');
  size.addEventListener('input', () => {
    state.tool.size = Number(size.value);
    document.getElementById('size-value').textContent = size.value;
  });
  const aspect = document.getElementById('aspect');
  aspect.addEventListener('input', () => {
    state.tool.aspect = Number(aspect.value);
    document.getElementById('aspect-value').textContent = Number(aspect.value).toFixed(1);
  });
  const skew = document.getElementById('skew');
  skew.addEventListener('input', () => {
    state.tool.skew = Number(skew.value);
    document.getElementById('skew-value').textContent = Number(skew.value).toFixed(2);
  });
  const tilt = document.getElementById('tilt');
  tilt.addEventListener('input', () => {
    state.tool.tiltDeg = Number(tilt.value);
    document.getElementById('tilt-value').textContent = `${tilt.value}°`;
  });
  const opacity = document.getElementById('opacity');
  opacity.addEventListener('input', () => {
    state.tool.opacity = Number(opacity.value);
    document.getElementById('opacity-value').textContent = Number(opacity.value).toFixed(2);
  });
  document.getElementById('color').addEventListener('input', (event) => {
    state.tool.color = event.target.value;
  });
  document.getElementById('background').addEventListener('change', (event) => {
    state.doc.background = event.target.value;
    state.baseSurface = null;
    redrawAll();
  });

  document.getElementById('toggle-axes').addEventListener('change', (event) => {
    state.showAxes = event.target.checked;
    renderResult();
  });
  document.getElementById('toggle-provenance').addEventListener('change', (event) => {
    state.showProvenance = event.target.checked;
    renderResult();
  });

  document.getElementById('set-center').addEventListener('click', (event) => {
    state.pendingCenter = !state.pendingCenter;
    event.currentTarget.setAttribute('aria-pressed', String(state.pendingCenter));
    event.currentTarget.textContent = state.pendingCenter ? '点击画布放置中心…' : '点击画布设置中心';
    el.wrap.classList.toggle('drawing', state.pendingCenter);
    el.status.textContent = state.pendingCenter ? '点击画布设置对称中心' : '就绪';
    el.guide.style.opacity = state.pendingCenter ? '1' : '1';
  });
  document.getElementById('reset-center').addEventListener('click', () => {
    state.center = { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 };
    document.getElementById('center-readout').textContent =
      `${state.center.x.toFixed(0)}, ${state.center.y.toFixed(0)}`;
    if (!state.selectedCompiled) drawGuides();
    redrawAll();
  });

  el.wrap.addEventListener('pointerdown', onPointerDown);
  el.wrap.addEventListener('pointermove', onPointerMove);
  el.wrap.addEventListener('pointerup', onPointerUp);
  el.wrap.addEventListener('pointercancel', onPointerUp);
  el.wrap.addEventListener('pointerleave', (event) => {
    el.cursor.textContent = '—';
    if (state.drawing) onPointerUp(event);
  });

  document.getElementById('undo').addEventListener('click', undo);
  document.getElementById('redo').addEventListener('click', redo);
  document.getElementById('clear').addEventListener('click', clearCanvas);
  document.getElementById('export-png').addEventListener('click', exportPNG);
  document.getElementById('save-json').addEventListener('click', saveJSON);
  document.getElementById('open-json').addEventListener('click', () => {
    document.getElementById('file-input').click();
  });
  document.getElementById('file-input').addEventListener('change', openJSON);
  document.getElementById('replay-check').addEventListener('click', replayCheck);

  window.addEventListener('resize', debounce(setupCanvas, 120));
  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    }
  });
}

function recomputeToolPreview() {
  drawGuides();
  if (!state.selectedCompiled) renderResult();
  updateReadouts();
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  const point = toCanvasPoint(event);
  if (state.pendingCenter) {
    state.center = { x: point.x, y: point.y };
    state.pendingCenter = false;
    const button = document.getElementById('set-center');
    button.setAttribute('aria-pressed', 'false');
    button.textContent = '点击画布设置中心';
    el.wrap.classList.remove('drawing');
    document.getElementById('center-readout').textContent =
      `${point.x.toFixed(0)}, ${point.y.toFixed(0)}`;
    drawGuides();
    if (!state.selectedCompiled) renderResult();
    return;
  }
  el.wrap.setPointerCapture?.(event.pointerId);
  // 一次 pointerdown 分配一个原始笔事件 id；同一次落笔的全部对称副本共享它。
  state.drawing = {
    points: [point],
    pointerId: event.pointerId,
    eventId: `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };
  el.status.textContent = '绘制中…';
  updateLiveFromPoints(state.drawing.points);
}

function onPointerMove(event) {
  const point = toCanvasPoint(event);
  el.cursor.textContent = `${point.x.toFixed(0)}, ${point.y.toFixed(0)}`;
  if (!state.drawing || state.drawing.pointerId !== event.pointerId) return;
  const last = state.drawing.points[state.drawing.points.length - 1];
  if (Math.hypot(point.x - last.x, point.y - last.y) < 0.75) return;
  state.drawing.points.push(point);
  updateLiveFromPoints(state.drawing.points);
}

function onPointerUp(event) {
  if (!state.drawing) return;
  const drawing = state.drawing;
  // pointerup 与 pointercancel 可能对同一次落笔先后到达；只提交一次，
  // 避免事件重送让同一原始笔事件沉积出重复笔画。
  if (event.pointerId !== undefined && drawing.pointerId !== event.pointerId) return;
  const points = drawing.points;
  state.drawing = null;
  state.liveCompiled = null;
  if (points.length === 0) {
    redrawAll();
    return;
  }
  const before = snapshotForUndo();
  const compiled = state.doc.addStroke({
    points,
    brush: currentBrush(),
    symmetry: currentSymmetry(),
    dedupePolicy: state.tool.dedupe,
    eventId: drawing.eventId,
  });
  state.undoStack.push(before);
  state.redoStack = [];
  state.selectedId = compiled.stroke.id;
  state.selectedCompiled = compiled;
  state.baseSurface = null;
  refreshAfterMutation();
  el.status.textContent = `已落笔 ${compiled.stroke.id} · 事件 ${compiled.stroke.eventId} · ${compiled.instances.length} 实例 · 写入 ${compiled.writeCount} 覆盖样本`;
}

function updateLiveFromPoints(points) {
  const brush = normalizeBrush(currentBrush());
  const symmetry = makeSymmetrySnapshot(currentSymmetry());
  const draft = {
    id: 'preview',
    points,
    brush,
    symmetry,
    dedupePolicy: 'coverage-union',
  };
  state.liveCompiled = compileStroke(draft);
  drawLivePreview();
}

function snapshotForUndo() {
  return JSON.stringify(state.doc.toJSON());
}

function restoreSnapshot(snapshot) {
  state.doc = SketchDocument.fromJSON(JSON.parse(snapshot));
  state.selectedId = null;
  state.selectedCompiled = null;
  state.baseSurface = null;
  refreshAfterMutation();
}

function undo() {
  if (state.undoStack.length === 0) {
    toast('没有可撤销的操作');
    return;
  }
  state.redoStack.push(snapshotForUndo());
  restoreSnapshot(state.undoStack.pop());
  toast('已撤销');
}

function redo() {
  if (state.redoStack.length === 0) {
    toast('没有可重做的操作');
    return;
  }
  state.undoStack.push(snapshotForUndo());
  restoreSnapshot(state.redoStack.pop());
  toast('已重做');
}

function clearCanvas() {
  if (state.doc.strokeCount === 0) return;
  state.undoStack.push(snapshotForUndo());
  state.redoStack = [];
  state.doc = new SketchDocument({
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    background: state.doc.background,
  });
  state.selectedId = null;
  state.selectedCompiled = null;
  state.baseSurface = null;
  refreshAfterMutation();
  toast('画布已清空');
}

function refreshAfterMutation() {
  renderBaseSurface();
  redrawAll();
}

/* ---------- 导出与重放 ---------- */

async function exportPNG() {
  const { width, height } = state.doc;
  const surface = new Surface(width, height, state.doc.background);
  for (const compiled of state.doc.compiledStrokes()) surface.drawCompiledStroke(compiled);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(surfaceToImageData(surface), 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  downloadBlob(blob, `symmetry-ink-${timestamp()}.png`);
  toast('已导出 PNG（真实渲染，非截图）');
}

function saveJSON() {
  const data = JSON.stringify(state.doc.toJSON(), null, 2);
  downloadBlob(new Blob([data], { type: 'application/json' }), `symmetry-ink-${timestamp()}.json`);
  toast('笔画已保存，可用“打开笔画”重放');
}

async function openJSON(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const doc = SketchDocument.fromJSON(parsed);
    state.undoStack.push(snapshotForUndo());
    state.redoStack = [];
    state.doc = doc;
    state.selectedId = null;
    state.selectedCompiled = null;
    state.center = doc.strokes.length > 0
      ? { ...doc.strokes[doc.strokes.length - 1].symmetry.center }
      : { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 };
    state.baseSurface = null;
    refreshAfterMutation();
    toast(`已重放 ${doc.strokeCount} 笔`);
  } catch (error) {
    toast(`打开失败：${error.message}`, { error: true });
  }
}

function replayCheck() {
  const json = state.doc.toJSON();
  const replay = SketchDocument.fromJSON(JSON.parse(JSON.stringify(json)));
  const original = state.doc.toPNG();
  const replayed = replay.toPNG();
  let identical = original.length === replayed.length;
  if (identical) {
    for (let i = 0; i < original.length; i += 1) {
      if (original[i] !== replayed[i]) {
        identical = false;
        break;
      }
    }
  }
  if (identical) {
    toast(`重放一致：${state.doc.strokeCount} 笔逐字节相同`);
  } else {
    toast('重放结果不一致，请检查笔画数据', { error: true });
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function debounce(fn, wait) {
  let handle = null;
  return (...args) => {
    clearTimeout(handle);
    handle = setTimeout(() => fn(...args), wait);
  };
}

/* ---------- 启动 ---------- */

function init() {
  bindControls();
  updateToolButtons();
  document.getElementById('center-readout').textContent =
    `${state.center.x.toFixed(0)}, ${state.center.y.toFixed(0)}`;
  setupCanvas();
  el.guide.style.opacity = '1';
  updateReadouts();
  window.__symmetryInk = {
    state,
    getDoc: () => state.doc,
    getSelected: () => state.selectedCompiled,
    getCenter: () => ({ ...state.center }),
    setTool: (patch) => {
      Object.assign(state.tool, patch);
      updateToolButtons();
      recomputeToolPreview();
    },
    addStrokeProgrammatically: (points, options = {}) => {
      if (options.center) state.center = { ...options.center };
      const compiled = state.doc.addStroke({
        points,
        brush: { ...currentBrush(), ...(options.brush ?? {}) },
        symmetry: { ...currentSymmetry(), ...(options.symmetry ?? {}) },
        dedupePolicy: options.dedupePolicy ?? state.tool.dedupe,
        eventId: options.eventId,
      });
      state.selectedId = compiled.stroke.id;
      state.selectedCompiled = compiled;
      state.baseSurface = null;
      refreshAfterMutation();
      return compiled;
    },
    /** 按原始笔事件撤销（与历史面板的“撤”按钮同一条路径）。 */
    undoStrokeEvent: (eventId) => {
      const target = state.doc.strokes.find((stroke) => stroke.eventId === eventId);
      if (!target) return null;
      undoStrokeEvent(eventId, target.id);
      return target.id;
    },
    /** 取出某笔的轨道与稳定身份（含轴上简并实例），供测试与排查。 */
    getStrokeIdentity: (strokeId) => {
      const compiled = state.doc.getCompiled(strokeId);
      return compiled ? strokeOrbitIdentity(compiled) : null;
    },
    /** 当前对称笔迹运行状态与轴向关系异常清单。 */
    getSymmetryDiagnostics: () => collectSymmetryDiagnostics(),
    renderBase: () => {
      renderBaseSurface();
      redrawAll();
    },
    encodeCurrentPNG: () => state.doc.toPNG(),
    docToJSON: () => state.doc.toJSON(),
    version: DOCUMENT_VERSION,
  };
  document.documentElement.dataset.ready = 'true';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
