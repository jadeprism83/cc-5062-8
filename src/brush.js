import { normalizeSignedAngle } from './group.js';
import { clamp, distance } from './geometry.js';

export const TIP_RATIO = 0.42;
export const ROUND_SEGMENTS = 20;

export const BRUSH_LIMITS = {
  size: { min: 1, max: 120 },
  aspect: { min: 1, max: 6 },
  skew: { min: -1.5, max: 1.5 },
  tiltDeg: { min: -180, max: 180 },
  opacity: { min: 0.02, max: 1 },
};

export const DEFAULT_BRUSH = {
  shape: 'nib',
  size: 16,
  aspect: 2.4,
  skew: 0.55,
  tiltDeg: 24,
  opacity: 0.9,
  color: '#1f2d3d',
};

export function normalizeBrush(input = {}) {
  const brush = { ...DEFAULT_BRUSH, ...input };
  const numeric = (key, min, max, fallback) => {
    const value = Number(brush[key]);
    if (!Number.isFinite(value)) return fallback;
    return clamp(value, min, max);
  };
  brush.shape = brush.shape === 'round' ? 'round' : 'nib';
  brush.size = numeric('size', BRUSH_LIMITS.size.min, BRUSH_LIMITS.size.max, DEFAULT_BRUSH.size);
  brush.aspect = numeric('aspect', BRUSH_LIMITS.aspect.min, BRUSH_LIMITS.aspect.max, DEFAULT_BRUSH.aspect);
  brush.skew = numeric('skew', BRUSH_LIMITS.skew.min, BRUSH_LIMITS.skew.max, DEFAULT_BRUSH.skew);
  brush.tiltDeg = numeric('tiltDeg', -180, 180, DEFAULT_BRUSH.tiltDeg);
  brush.opacity = numeric('opacity', 0.02, 1, DEFAULT_BRUSH.opacity);
  brush.color = typeof brush.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(brush.color)
    ? brush.color.toLowerCase()
    : DEFAULT_BRUSH.color;
  return brush;
}

/** 笔尖是否为旋转不变的圆。 */
export function isCircularBrush(brush) {
  return brush.shape === 'round' && Math.abs(brush.aspect - 1) <= 1e-9 && Math.abs(brush.skew) <= 1e-9;
}

/**
 * 笔尖局部多边形（未旋转、未平移）。x 为长轴，y 为短轴。
 *
 * nib：前端圆钝收窄、后端平口的楔形笔尖；skew 沿长轴错切短轴，
 *      使笔尖左右不对称（手性）。错切对前端与后端施加同向位移，
 *      因此沿运动方向连续铺展时不会产生锯齿。
 * round：椭圆/圆头，skew 施加同样的错切。
 */
export function brushLocalPolygon(brush) {
  const halfWidth = brush.size / 2;
  const halfLength = (brush.size * brush.aspect) / 2;
  if (brush.shape === 'round') {
    const polygon = [];
    for (let i = 0; i < ROUND_SEGMENTS; i += 1) {
      const angle = (Math.PI * 2 * i) / ROUND_SEGMENTS;
      const x = halfLength * Math.cos(angle);
      const y = halfWidth * Math.sin(angle);
      polygon.push({ x: x + brush.skew * y, y });
    }
    return polygon;
  }
  const shoulder = halfLength * 0.55;
  const raw = [
    [-halfLength, -halfWidth],
    [-halfLength, halfWidth],
    [shoulder, halfWidth],
    [halfLength, halfWidth * TIP_RATIO],
    [halfLength, -halfWidth * TIP_RATIO],
    [shoulder, -halfWidth],
  ];
  return raw.map(([x, y]) => ({ x: x + brush.skew * y, y }));
}

export function placePolygon(local, theta, x, y) {
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return local.map((point) => ({
    x: x + cos * point.x - sin * point.y,
    y: y + sin * point.x + cos * point.y,
  }));
}

/**
 * 沿折线重采样出笔尖样本。theta 是“运动切线 + 倾斜”得到的世界笔尖方向，
 * skew 是笔尖手性。二者连同位置构成轨道去重的姿态描述。
 */
export function sampleStroke(points, brushInput, { spacingScale = 1 } = {}) {
  const brush = normalizeBrush(brushInput);
  const spacing = clamp(brush.size * 0.08 * spacingScale, 0.4 * spacingScale, 3 * spacingScale);
  const clean = [];
  for (const point of points) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const last = clean[clean.length - 1];
    if (!last || distance(last.x, last.y, point.x, point.y) > 1e-9) {
      clean.push({ x: point.x, y: point.y });
    }
  }

  const tilt = (brush.tiltDeg * Math.PI) / 180;
  const samples = [];
  if (clean.length === 0) return { samples, length: 0, spacing, brush };
  if (clean.length === 1) {
    samples.push({ x: clean[0].x, y: clean[0].y, tangent: 0, theta: normalizeSignedAngle(tilt), skew: brush.skew });
    return { samples, length: 0, spacing, brush };
  }

  const segments = [];
  let totalLength = 0;
  for (let i = 1; i < clean.length; i += 1) {
    const p0 = clean[i - 1];
    const p1 = clean[i];
    const length = distance(p0.x, p0.y, p1.x, p1.y);
    if (length <= 1e-9) continue;
    segments.push({
      p0,
      p1,
      length,
      start: totalLength,
      tangent: Math.atan2(p1.y - p0.y, p1.x - p0.x),
    });
    totalLength += length;
  }
  if (segments.length === 0) {
    samples.push({ x: clean[0].x, y: clean[0].y, tangent: 0, theta: normalizeSignedAngle(tilt), skew: brush.skew });
    return { samples, length: 0, spacing, brush };
  }

  let nextDistance = 0;
  let segmentIndex = 0;
  const maxSamples = 20000;
  while (nextDistance <= totalLength + 1e-9 && samples.length < maxSamples) {
    while (
      segmentIndex < segments.length - 1 &&
      nextDistance > segments[segmentIndex].start + segments[segmentIndex].length
    ) {
      segmentIndex += 1;
    }
    const segment = segments[segmentIndex];
    const localT = clamp((nextDistance - segment.start) / segment.length, 0, 1);
    samples.push({
      x: segment.p0.x + (segment.p1.x - segment.p0.x) * localT,
      y: segment.p0.y + (segment.p1.y - segment.p0.y) * localT,
      tangent: segment.tangent,
      theta: normalizeSignedAngle(segment.tangent + tilt),
      skew: brush.skew,
    });
    nextDistance += spacing;
  }

  const lastSegment = segments[segments.length - 1];
  const lastPoint = lastSegment.p1;
  const lastSample = samples[samples.length - 1];
  if (!lastSample || distance(lastSample.x, lastSample.y, lastPoint.x, lastPoint.y) > spacing * 0.35) {
    samples.push({
      x: lastPoint.x,
      y: lastPoint.y,
      tangent: lastSegment.tangent,
      theta: normalizeSignedAngle(lastSegment.tangent + tilt),
      skew: brush.skew,
    });
  }

  return { samples, length: totalLength, spacing, brush };
}
