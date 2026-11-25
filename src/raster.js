import { parseBackground } from './color.js';
import { brushLocalPolygon, placePolygon } from './brush.js';

/** 每像素 4x4 子采样；用位掩码对同一笔画内的所有实例取并集。 */
export const SUBSAMPLES = 4;
const SUB_BITS = SUBSAMPLES * SUBSAMPLES;

const POPCOUNT = (() => {
  const table = new Uint8Array(1 << 16);
  for (let i = 0; i < table.length; i += 1) {
    let v = i;
    let count = 0;
    while (v) {
      v &= v - 1;
      count += 1;
    }
    table[i] = count;
  }
  return table;
})();

export function popcount16(value) {
  return POPCOUNT[value & 0xffff];
}

export function coverageFromBits(bits) {
  return popcount16(bits) / SUB_BITS;
}

/**
 * 把一个多边形按 4x4 子采样写入位掩码。位 OR 让同一笔画的多个实例
 * 共享覆盖，绝不重复累加——这是“画布写入端只累计一次覆盖”的落点。
 */
export function rasterizePolygonBits(polygon, bits, width, height, originX = 0, originY = 0) {
  if (polygon.length < 3) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of polygon) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  const px0 = Math.max(0, Math.floor(minX - originX));
  const py0 = Math.max(0, Math.floor(minY - originY));
  const px1 = Math.min(width, Math.ceil(maxX - originX));
  const py1 = Math.min(height, Math.ceil(maxY - originY));
  if (px1 <= px0 || py1 <= py0) return null;

  const edges = [];
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[j];
    const b = polygon[i];
    if (a.y === b.y) continue;
    edges.push({
      x0: a.x,
      y0: a.y,
      x1: b.x,
      y1: b.y,
    });
  }

  const step = 1 / SUBSAMPLES;
  const xs = [];
  for (let py = py0; py < py1; py += 1) {
    for (let syi = 0; syi < SUBSAMPLES; syi += 1) {
      const y = originY + py + (syi + 0.5) * step;
      xs.length = 0;
      for (const edge of edges) {
        const { x0, y0, x1, y1 } = edge;
        if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
          xs.push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = xs[k];
        const xb = xs[k + 1];
        if (xb <= xa) continue;
        const startPx = Math.max(px0, Math.floor(xa - originX));
        const endPx = Math.min(px1 - 1, Math.floor(xb - originX - 1e-9));
        for (let px = startPx; px <= endPx; px += 1) {
          let mask = 0;
          for (let sxi = 0; sxi < SUBSAMPLES; sxi += 1) {
            const x = originX + px + (sxi + 0.5) * step;
            if (x >= xa && x < xb) mask |= 1 << (syi * SUBSAMPLES + sxi);
          }
          if (mask !== 0) {
            const index = py * width + px;
            bits[index] |= mask;
          }
        }
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

function stampLocalPolygon(brush, skew, cache) {
  const key = skew.toFixed(6);
  let local = cache.get(key);
  if (!local) {
    local = brushLocalPolygon({ ...brush, skew });
    cache.set(key, local);
  }
  return local;
}

/** Andrew 单调链凸包，输入/输出均为 {x,y}；用于把相邻笔尖连成连续扫掠。 */
export function convexHull(points) {
  if (points.length < 3) return points.slice();
  const sorted = points
    .slice()
    .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 1e-9) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const point = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 1e-9) {
      upper.pop();
    }
    upper.push(point);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/**
 * 把已编译笔画的所有实例取并集写入 bits。
 *
 * 每个群元素对应的笔尖序列按采样顺序连续扫掠：相邻笔尖取凸包再栅格化，
 * 消除离散盖章在曲线外侧留下的扇贝锯齿。凸包与等距变换可交换，因此可直接
 * 在世界坐标做。所有元素、所有扫掠段都通过位 OR 合并——同一像素只保留
 * 最大子采样覆盖，不会重复加深。
 */
export function rasterizeCompiledStroke(compiled, bits, width, height, originX = 0, originY = 0) {
  const brush = compiled.brush;
  const localCache = new Map();
  let touched = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const placeStamp = (stamp) =>
    placePolygon(stampLocalPolygon(brush, stamp.skew, localCache), stamp.theta, stamp.position.x, stamp.position.y);

  const accumulate = (polygon) => {
    const bounds = rasterizePolygonBits(polygon, bits, width, height, originX, originY);
    if (!bounds) return;
    if (bounds.minX < minX) minX = bounds.minX;
    if (bounds.minY < minY) minY = bounds.minY;
    if (bounds.maxX > maxX) maxX = bounds.maxX;
    if (bounds.maxY > maxY) maxY = bounds.maxY;
    touched += 1;
  };

  const byElement = new Map();
  for (const stamp of compiled.orbit) {
    let bucket = byElement.get(stamp.elementId);
    if (!bucket) {
      bucket = [];
      byElement.set(stamp.elementId, bucket);
    }
    bucket.push(stamp);
  }

  for (const stamps of byElement.values()) {
    stamps.sort((a, b) => a.sourceSampleIndex - b.sourceSampleIndex);
    for (const stamp of stamps) accumulate(placeStamp(stamp));
    for (let i = 1; i < stamps.length; i += 1) {
      const previous = stamps[i - 1];
      const current = stamps[i];
      if (current.sourceSampleIndex !== previous.sourceSampleIndex + 1) continue;
      const hull = convexHull([...placeStamp(previous), ...placeStamp(current)]);
      if (hull.length >= 3) accumulate(hull);
    }
  }

  let coveredPixels = 0;
  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i] !== 0) coveredPixels += 1;
  }
  return {
    stamps: touched,
    coveredPixels,
    bbox: touched ? { minX, minY, maxX, maxY } : null,
  };
}

/**
 * 预乘 alpha 的浮点表面。像素坐标为像素中心 x+0.5 / y+0.5。
 * 同一笔画的所有实例先取覆盖并集，再整体合成一次，避免轴/中心处重复加深。
 */
export class Surface {
  constructor(width, height, background = '#ffffff') {
    const w = Math.trunc(width);
    const h = Math.trunc(height);
    if (!(w > 0 && h > 0)) throw new RangeError('surface dimensions must be positive');
    this.width = w;
    this.height = h;
    this.data = new Float32Array(w * h * 4);
    this.background = parseBackground(background);
    const { r, g, b, a } = this.background;
    for (let i = 0; i < w * h; i += 1) {
      this.data[i * 4] = r * a;
      this.data[i * 4 + 1] = g * a;
      this.data[i * 4 + 2] = b * a;
      this.data[i * 4 + 3] = a;
    }
  }

  clone() {
    const copy = Object.create(Surface.prototype);
    copy.width = this.width;
    copy.height = this.height;
    copy.background = { ...this.background };
    copy.data = new Float32Array(this.data);
    return copy;
  }

  /**
   * 把一条已编译笔画按覆盖并集合成一次。
   * dedupePolicy='keep-all' 时按每个实例叠加 Alpha，用于对照重复加深。
   */
  drawCompiledStroke(compiled, { tint = null } = {}) {
    const brush = compiled.brush;
    const rgb = tint ?? hexToRgb(brush.color);
    const opacity = brush.opacity;

    if (compiled.dedupePolicy === 'keep-all') {
      return this.#drawKeepAll(compiled, rgb, opacity);
    }

    if (!this._bits || this._bits.length !== this.width * this.height) {
      this._bits = new Uint16Array(this.width * this.height);
    }
    const bits = this._bits;
    bits.fill(0);
    const report = rasterizeCompiledStroke(compiled, bits, this.width, this.height);
    let coveredPixels = 0;
    const data = this.data;
    for (let i = 0; i < bits.length; i += 1) {
      const mask = bits[i];
      if (mask === 0) continue;
      const coverage = POPCOUNT[mask] / SUB_BITS;
      if (coverage <= 0) continue;
      coveredPixels += 1;
      compositePixel(data, i * 4, rgb.r, rgb.g, rgb.b, opacity * coverage);
    }
    return { coveredPixels, bbox: report.bbox, stamps: report.stamps };
  }

  #drawKeepAll(compiled, rgb, opacity) {
    const localCache = new Map();
    const { width, height, data } = this;
    let coveredPixels = 0;
    const seen = new Uint8Array(width * height);
    for (const stamp of compiled.orbit) {
      const local = stampLocalPolygon(compiled.brush, stamp.skew, localCache);
      const polygon = placePolygon(local, stamp.theta, stamp.position.x, stamp.position.y);
      const bits = new Uint16Array(width * height);
      rasterizePolygonBits(polygon, bits, width, height);
      for (let i = 0; i < bits.length; i += 1) {
        const mask = bits[i];
        if (mask === 0) continue;
        const coverage = POPCOUNT[mask] / SUB_BITS;
        compositePixel(data, i * 4, rgb.r, rgb.g, rgb.b, opacity * coverage);
        if (!seen[i]) {
          seen[i] = 1;
          coveredPixels += 1;
        }
      }
    }
    return { coveredPixels, bbox: null, stamps: compiled.orbit.length };
  }

  toRGBA8() {
    const out = new Uint8ClampedArray(this.width * this.height * 4);
    const data = this.data;
    for (let i = 0; i < out.length; i += 4) {
      const a = data[i + 3];
      if (a <= 0) continue;
      const scale = 1 / a;
      out[i] = data[i] * scale;
      out[i + 1] = data[i + 1] * scale;
      out[i + 2] = data[i + 2] * scale;
      out[i + 3] = a * 255;
    }
    return out;
  }
}

function hexToRgb(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

function compositePixel(data, index, r, g, b, srcAlpha) {
  if (srcAlpha <= 0) return;
  const inv = 1 - srcAlpha;
  data[index] = r * srcAlpha + data[index] * inv;
  data[index + 1] = g * srcAlpha + data[index + 1] * inv;
  data[index + 2] = b * srcAlpha + data[index + 2] * inv;
  data[index + 3] = srcAlpha + data[index + 3] * inv;
}

/** 渲染整份文档。 */
export function renderDocument(document, { width, height, background } = {}) {
  const surface = new Surface(
    width ?? document.width,
    height ?? document.height,
    background ?? document.background ?? '#ffffff'
  );
  const strokeReports = [];
  const compiledStrokes = document.compiledStrokes ?? [];
  for (const compiled of compiledStrokes) {
    const report = surface.drawCompiledStroke(compiled);
    strokeReports.push({
      id: compiled.stroke.id,
      coveredPixels: report.coveredPixels,
      bbox: report.bbox,
    });
  }
  return { surface, strokes: strokeReports };
}
