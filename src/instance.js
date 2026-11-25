import {
  makeGroup,
  normalizeAxisAngle,
  normalizeSignedAngle,
  axisDelta,
} from './group.js';
import {
  normalizeBrush,
  sampleStroke,
  brushLocalPolygon,
  isCircularBrush,
} from './brush.js';
import { pointDistance } from './geometry.js';

export const REFLECTION_MODES = ['mirror', 'preserve-hand'];
export const DEDUPE_POLICIES = ['coverage-union', 'keep-all'];

/**
 * 笔画创建时冻结的对称快照。之后调整工具设置不会改写已有笔画，
 * 因此作品与“当前工具设置”的绑定关系是显式且稳定的。
 */
export function makeSymmetrySnapshot({
  rule = 'dihedral',
  divisions = 6,
  axisAngle = 0,
  center = { x: 0, y: 0 },
  reflection = 'mirror',
  dedupePolicy = 'coverage-union',
} = {}) {
  if (!REFLECTION_MODES.includes(reflection)) {
    throw new RangeError(`unsupported reflection mode: ${reflection}`);
  }
  if (!DEDUPE_POLICIES.includes(dedupePolicy)) {
    throw new RangeError(`unsupported dedupe policy: ${dedupePolicy}`);
  }
  return {
    rule,
    divisions: Math.trunc(Number(divisions)),
    axisAngle: normalizeAxisAngle(Number(axisAngle) || 0),
    center: {
      x: Number.isFinite(center?.x) ? center.x : 0,
      y: Number.isFinite(center?.y) ? center.y : 0,
    },
    reflection,
    dedupePolicy,
  };
}

export function groupFromSnapshot(snapshot) {
  return makeGroup({
    rule: snapshot.rule,
    divisions: snapshot.divisions,
    axisAngle: snapshot.axisAngle,
  });
}

/** 把点绕 center 应用群元素的线性部分。 */
export function transformPoint(element, center, x, y) {
  const dx = x - center.x;
  const dy = y - center.y;
  return {
    x: center.x + element.matrix.a * dx + element.matrix.b * dy,
    y: center.y + element.matrix.c * dx + element.matrix.d * dy,
  };
}

/**
 * 变换笔尖姿态。
 *
 * 旋转 R_α：位置绕中心旋转，笔尖方向 θ → θ + α，手性 skew 不变。
 * 反射 F_φ：位置镜像，笔尖方向 θ → 2φ − θ。
 *   reflection='mirror'        时 skew → −skew，得到严格几何镜像（手性翻转）；
 *   reflection='preserve-hand' 时 skew 不变，只镜像方向与位置（保留笔尖手性）。
 *
 * 笔尖局部形状关于长轴对称，因此 (θ, skew) 这组参数在反射下仍然闭合。
 */
export function transformNibParams(element, sample, reflectionMode) {
  if (element.determinant > 0) {
    const alpha = Math.atan2(element.matrix.c, element.matrix.a);
    return {
      theta: normalizeSignedAngle(sample.theta + alpha),
      skew: sample.skew,
    };
  }
  const phi = 0.5 * Math.atan2(element.matrix.c, element.matrix.a);
  return {
    theta: normalizeSignedAngle(2 * phi - sample.theta),
    skew: reflectionMode === 'mirror' ? -sample.skew : sample.skew,
  };
}

/**
 * 姿态方向等价模式：
 *   directed      nib 笔尖前后不对称、错切破坏轴向对称，θ 按 2π 比较；
 *   bidirectional 未错切的椭圆关于长轴 180° 对称，θ 按 π 比较；
 *   isotropic     圆头，方向无关。
 * 错切（skew）会让椭圆关于长轴的镜像不再成立，因此必须回落到 directed。
 */
export function brushOrientationMode(brush) {
  if (isCircularBrush(brush)) return 'isotropic';
  if (brush.shape === 'round' && Math.abs(brush.skew) <= 1e-9) return 'bidirectional';
  return 'directed';
}

function poseTolerances(brush) {
  const maxRadius =
    (brush.size * Math.max(brush.aspect, 1)) / 2 + brush.size * Math.abs(brush.skew) * 0.5 + 1;
  return {
    position: Math.max(0.03, brush.size * 0.002),
    angle: Math.max(0.0005, 0.05 / maxRadius),
    skew: 1e-6,
  };
}

/**
 * 判断两个实例姿态是否简并。
 *
 * 一个笔尖实例由 (位置, 笔尖方向, 手性) 描述。比较使用与笔刷尺寸相关的
 * 容差，而不是浮点坐标完全相等；轴上/中心处的副本经过旋转或反射后姿态
 * 不变时会重合。椭圆笔尖方向按 π 周期折叠；圆形笔尖只比较位置。
 */
export function posesCoincide(a, b, tolerances, orientationMode) {
  if (pointDistance(a.position, b.position) > tolerances.position) return false;
  if (orientationMode === 'isotropic') return true;
  if (Math.abs(a.skew - b.skew) > tolerances.skew) return false;
  if (orientationMode === 'bidirectional') {
    return axisDelta(a.theta, b.theta) <= tolerances.angle;
  }
  return Math.abs(normalizeSignedAngle(a.theta - b.theta)) <= tolerances.angle;
}

/**
 * 全局姿态空间哈希。把位置/角度/手性量化到桶，只与相邻桶比较，
 * 使“按轨道合并”接近线性；容差判定仍由 posesCoincide 完成。
 */
class PoseIndex {
  constructor(tolerances, orientationMode) {
    this.tolerances = tolerances;
    this.orientationMode = orientationMode;
    this.cell = Math.max(0.5, tolerances.position * 2);
    this.anglePeriod = orientationMode === 'bidirectional' ? Math.PI : Math.PI * 2;
    this.angleBin = Math.max(1e-4, tolerances.angle * 2);
    this.skewBin = 2e-5;
    this.buckets = new Map();
  }

  coords(position, theta, skew) {
    const ix = Math.floor(position.x / this.cell);
    const iy = Math.floor(position.y / this.cell);
    if (this.orientationMode === 'isotropic') return [ix, iy, 0, 0, 0];
    const angle = ((theta % this.anglePeriod) + this.anglePeriod) % this.anglePeriod;
    const ia = Math.floor(angle / this.angleBin);
    const maxBin = Math.ceil(this.anglePeriod / this.angleBin);
    const is = Math.floor(skew / this.skewBin);
    return [ix, iy, ((ia % maxBin) + maxBin) % maxBin, maxBin, is];
  }

  findOrInsert(candidate, create) {
    const [ix, iy, ia, maxBin, is] = this.coords(
      candidate.position,
      candidate.theta,
      candidate.skew
    );
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let da = -1; da <= 1; da += 1) {
          for (let ds = -1; ds <= 1; ds += 1) {
            const a = maxBin > 0 ? ((ia + da) % maxBin + maxBin) % maxBin : 0;
            const s = this.orientationMode === 'isotropic' ? 0 : is + ds;
            const key = `${ix + dx},${iy + dy},${a},${s}`;
            const bucket = this.buckets.get(key);
            if (!bucket) continue;
            for (const entry of bucket) {
              if (posesCoincide(entry, candidate, this.tolerances, this.orientationMode)) {
                return entry;
              }
            }
          }
        }
      }
    }
    const key = `${ix},${iy},${ia},${is}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = [];
      this.buckets.set(key, bucket);
    }
    bucket.push(create());
    return null;
  }
}

/**
 * 为一组（带样本序号的）样本构造轨道：对每个样本应用群中每个元素，
 * 再把姿态简并的副本合并。这是“按对称群轨道合并样本”的落点。
 *
 * keepAll=true 时不做合并，保留群的全部实例（用于对照与诊断）。
 */
export function buildOrbit(samples, group, snapshot, brush, keepAll = false) {
  const orientationMode = brushOrientationMode(brush);
  const tolerances = poseTolerances(brush);
  const index = keepAll ? null : new PoseIndex(tolerances, orientationMode);
  const orbit = [];
  let merged = 0;

  for (const sample of samples) {
    for (const element of group.elements) {
      const position = transformPoint(element, snapshot.center, sample.x, sample.y);
      const nib = transformNibParams(element, sample, snapshot.reflection);
      const candidate = {
        x: sample.x,
        y: sample.y,
        sourceSampleIndex: sample.sourceSampleIndex,
        elementId: element.id,
        elementKind: element.kind,
        element,
        position,
        theta: nib.theta,
        skew: nib.skew,
        sourceElementIds: [element.id],
      };
      const existing = index
        ? index.findOrInsert(candidate, () => {
            orbit.push(candidate);
            return candidate;
          })
        : (orbit.push(candidate), null);
      if (existing) {
        merged += 1;
        if (!existing.sourceElementIds.includes(element.id)) {
          existing.sourceElementIds.push(element.id);
        }
      }
    }
  }
  return { orbit, merged, orientationMode };
}

export function polygonArea(polygon) {
  let area = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const p = polygon[i];
    const q = polygon[(i + 1) % polygon.length];
    area += p.x * q.y - q.x * p.y;
  }
  return area / 2;
}

/**
 * 编译一条笔画：重采样 → 全局轨道合并 → 汇总实例、来源与每元素归属。
 *
 * dedupePolicy:
 *   'coverage-union' 合并简并副本，同一着色样本只写入一次覆盖；
 *   'keep-all'       保留全部群元素实例（可能重复加深，仅供对照）。
 */
export function compileStroke(stroke) {
  const brush = normalizeBrush(stroke.brush);
  const snapshot = makeSymmetrySnapshot(stroke.symmetry ?? {});
  const group = groupFromSnapshot(snapshot);
  const sampled = sampleStroke(stroke.points ?? [], brush);
  const localPolygon = brushLocalPolygon(brush);
  const dedupe = stroke.dedupePolicy ?? snapshot.dedupePolicy ?? 'coverage-union';
  const keepAll = dedupe === 'keep-all';

  const indexed = sampled.samples.map((sample, index) => ({
    ...sample,
    sourceSampleIndex: index,
  }));
  const { orbit, merged, orientationMode } = buildOrbit(
    indexed,
    group,
    snapshot,
    brush,
    keepAll
  );

  const orderIndex = new Map(group.elements.map((element, order) => [element.id, order]));
  const instanceMap = new Map();
  const attribution = new Map(group.elements.map((element) => [element.id, 0]));

  for (const entry of orbit) {
    for (const sourceId of entry.sourceElementIds) {
      attribution.set(sourceId, (attribution.get(sourceId) ?? 0) + 1);
    }
    const record = instanceMap.get(entry.elementId) ?? {
      elementId: entry.elementId,
      elementKind: entry.elementKind,
      element: entry.element,
      coverCount: 0,
      sourceElementIds: new Set(),
      sampleIndex: entry.sourceSampleIndex,
      samplePosition: entry.position,
    };
    record.coverCount += 1;
    for (const id of entry.sourceElementIds) record.sourceElementIds.add(id);
    instanceMap.set(entry.elementId, record);
  }

  const instances = [...instanceMap.values()]
    .map((record) => ({
      elementId: record.elementId,
      elementKind: record.elementKind,
      coverCount: record.coverCount,
      sourceElementIds: [...record.sourceElementIds].sort(),
      mirrorAngle: record.element.mirrorAngle ?? null,
      rotationAngle: record.element.kind === 'rotation' ? record.element.angle : null,
      sampleIndex: record.sampleIndex,
      samplePosition: record.samplePosition,
    }))
    .sort((a, b) => (orderIndex.get(a.elementId) ?? 0) - (orderIndex.get(b.elementId) ?? 0));

  const attributionList = group.elements
    .map((element) => ({
      elementId: element.id,
      elementKind: element.kind,
      stampCount: attribution.get(element.id) ?? 0,
      mirrorAngle: element.mirrorAngle ?? null,
      rotationAngle: element.kind === 'rotation' ? element.angle : null,
    }))
    .filter((entry) => entry.stampCount > 0);

  return {
    stroke,
    brush,
    snapshot,
    group,
    samples: sampled.samples,
    length: sampled.length,
    spacing: sampled.spacing,
    localPolygon,
    orientationMode,
    orbit,
    instances,
    attribution: attributionList,
    sampleCount: sampled.samples.length,
    writeCount: orbit.length,
    mergedSamples: merged,
    dedupePolicy: dedupe,
  };
}

/** 供界面/报告使用：实例来源摘要。 */
export function instanceProvenance(compiled) {
  return {
    rule: compiled.group.rule,
    divisions: compiled.group.divisions,
    group: compiled.group.rule === 'dihedral'
      ? `D${compiled.group.divisions}`
      : `C${compiled.group.divisions}`,
    order: compiled.group.order,
    center: compiled.snapshot.center,
    axisAngleDeg: (compiled.snapshot.axisAngle * 180) / Math.PI,
    reflection: compiled.snapshot.reflection,
    dedupePolicy: compiled.dedupePolicy,
    sampleCount: compiled.sampleCount,
    writeCount: compiled.writeCount,
    mergedSamples: compiled.mergedSamples,
    instances: compiled.instances.map((instance) => ({
      elementId: instance.elementId,
      elementKind: instance.elementKind,
      coverCount: instance.coverCount,
      sourceElementIds: instance.sourceElementIds,
      mirrorAngleDeg: instance.mirrorAngle === null ? null : (instance.mirrorAngle * 180) / Math.PI,
      rotationAngleDeg: instance.rotationAngle === null ? null : (instance.rotationAngle * 180) / Math.PI,
    })),
    attribution: compiled.attribution.map((entry) => ({
      elementId: entry.elementId,
      elementKind: entry.elementKind,
      stampCount: entry.stampCount,
      mirrorAngleDeg: entry.mirrorAngle === null ? null : (entry.mirrorAngle * 180) / Math.PI,
      rotationAngleDeg: entry.rotationAngle === null ? null : (entry.rotationAngle * 180) / Math.PI,
    })),
  };
}

/**
 * 一段笔迹的轨道与稳定身份摘要。
 *
 * 一次落笔（一个原始笔事件 eventId）经群变换派生出整条轨道：
 *   - instances：轨道上的独立实例，每个实例记录它合并了哪些群元素的副本
 *     （sourceElementIds 长度 >1 表示轴/中心处的简并副本被并成一个身份）；
 *   - degenerateInstances：在轴或中心处发生简并的实例，是“重合区域多写”的落点；
 *   - deposition：写入次数与被合并的简并副本数，用于核对是否重复沉积。
 * 离开重合区后各实例仍以独立 elementId 身份按群变换绘制，不会被整体降透明度。
 */
export function strokeOrbitIdentity(compiled) {
  const degenerateInstances = compiled.instances
    .filter((instance) => instance.sourceElementIds.length > 1)
    .map((instance) => ({
      elementId: instance.elementId,
      sourceElementIds: instance.sourceElementIds,
      coverCount: instance.coverCount,
    }));

  return {
    strokeId: compiled.stroke.id,
    eventId: compiled.stroke.eventId ?? compiled.stroke.id,
    group: compiled.group.rule === 'dihedral'
      ? `D${compiled.group.divisions}`
      : `C${compiled.group.divisions}`,
    groupOrder: compiled.group.order,
    dedupePolicy: compiled.dedupePolicy,
    sampleCount: compiled.sampleCount,
    writeCount: compiled.writeCount,
    mergedSamples: compiled.mergedSamples,
    instanceCount: compiled.instances.length,
    degenerateCount: degenerateInstances.length,
    degenerateInstances,
    instances: compiled.instances.map((instance) => ({
      elementId: instance.elementId,
      elementKind: instance.elementKind,
      sourceElementIds: instance.sourceElementIds,
      coverCount: instance.coverCount,
    })),
  };
}
