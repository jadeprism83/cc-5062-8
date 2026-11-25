/**
 * 对称群 D_n / C_n 的显式表示。
 *
 * 坐标系：画布像素坐标，y 轴向下。因此数学上的正角在屏幕上表现为顺时针。
 * 反射轴的角度从 +x 轴量起，取值归一化到 [0, π)；直线没有方向。
 *
 * 元素：
 *   R_k = R(2πk/n)                        （旋转，det = +1）
 *   S_k = R(2πk/n) · F(θ)                 （反射，det = -1）
 * 其中 F(θ) 是关于过原点、方向角 θ 的直线的反射。
 * S_k 的镜线角度是 θ + kπ/n（因为 R(α)F(θ) = F(θ + α/2)）。
 */

export const TAU = Math.PI * 2;

export function normalizeAngle(angle) {
  if (!Number.isFinite(angle)) throw new TypeError('angle must be a finite number');
  let a = angle % TAU;
  if (a < 0) a += TAU;
  return a;
}

/** 归一化到 (-π, π]。 */
export function normalizeSignedAngle(angle) {
  let a = normalizeAngle(angle);
  if (a > Math.PI) a -= TAU;
  return a;
}

/** 把直线方向归一化到 [0, π)。 */
export function normalizeAxisAngle(angle) {
  let a = normalizeAngle(angle);
  if (a >= Math.PI) a -= Math.PI;
  return a;
}

/** 两条无向直线的最小夹角，范围 [0, π/2]。 */
export function axisDelta(a, b) {
  const d = Math.abs(normalizeSignedAngle(a - b));
  return Math.min(d, Math.PI - d);
}

export function identityMatrix() {
  return { a: 1, b: 0, c: 0, d: 1 };
}

export function rotationMatrix(angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { a: c, b: -s, c: s, d: c };
}

/** 关于过原点、方向角为 axisAngle 的直线的反射。 */
export function reflectionMatrix(axisAngle) {
  const c = Math.cos(2 * axisAngle);
  const s = Math.sin(2 * axisAngle);
  return { a: c, b: s, c: s, d: -c };
}

/** 先应用 m1，再应用 m2。 */
export function composeMatrices(m2, m1) {
  return {
    a: m2.a * m1.a + m2.b * m1.c,
    b: m2.a * m1.b + m2.b * m1.d,
    c: m2.c * m1.a + m2.d * m1.c,
    d: m2.c * m1.b + m2.d * m1.d,
  };
}

export function matrixDeterminant(m) {
  return m.a * m.d - m.b * m.c;
}

export function applyMatrixToPoint(m, x, y) {
  return { x: m.a * x + m.b * y, y: m.c * x + m.d * y };
}

export function applyMatrixToVector(m, x, y) {
  return { x: m.a * x + m.b * y, y: m.c * x + m.d * y };
}

export function matricesApproximatelyEqual(m1, m2, epsilon = 1e-9) {
  return (
    Math.abs(m1.a - m2.a) <= epsilon &&
    Math.abs(m1.b - m2.b) <= epsilon &&
    Math.abs(m1.c - m2.c) <= epsilon &&
    Math.abs(m1.d - m2.d) <= epsilon
  );
}

export function matrixToArray(m) {
  return [m.a, m.b, m.c, m.d];
}

/**
 * 构造群。divisions 是旋转分区数 n。
 * rule = 'dihedral' 时阶为 2n，'cyclic' 时阶为 n。
 */
export function makeGroup({ rule = 'dihedral', divisions = 6, axisAngle = 0 } = {}) {
  if (rule !== 'dihedral' && rule !== 'cyclic') {
    throw new RangeError(`unsupported symmetry rule: ${rule}`);
  }
  const n = Math.trunc(Number(divisions));
  if (!Number.isFinite(n) || n < 1 || n > 128) {
    throw new RangeError('divisions must be an integer in [1, 128]');
  }
  const axis = normalizeAxisAngle(axisAngle);
  const elements = [];

  for (let k = 0; k < n; k += 1) {
    elements.push({
      id: `R${k}`,
      kind: 'rotation',
      k,
      angle: (TAU * k) / n,
      matrix: rotationMatrix((TAU * k) / n),
      determinant: 1,
    });
  }

  if (rule === 'dihedral') {
    const base = reflectionMatrix(axis);
    for (let k = 0; k < n; k += 1) {
      const r = rotationMatrix((TAU * k) / n);
      elements.push({
        id: `S${k}`,
        kind: 'reflection',
        k,
        matrix: composeMatrices(r, base),
        mirrorAngle: normalizeAxisAngle(axis + (Math.PI * k) / n),
        determinant: -1,
      });
    }
  }

  const mirrorAxes = elements
    .filter((element) => element.kind === 'reflection')
    .map((element) => ({ k: element.k, angle: element.mirrorAngle }));

  // C_n 的 n 条射线（不是直线）用来在界面上表达旋转阶数。
  const rotationRays = [];
  if (rule === 'cyclic') {
    for (let k = 0; k < n; k += 1) {
      rotationRays.push({
        k,
        angle: normalizeAngle(axis + (TAU * k) / n),
      });
    }
  }

  return {
    rule,
    divisions: n,
    axisAngle: axis,
    order: elements.length,
    elements,
    mirrorAxes,
    rotationRays,
  };
}

export function groupElement(group, id) {
  return group.elements.find((element) => element.id === id) ?? null;
}

export function findElementByMatrix(group, matrix, epsilon = 1e-9) {
  return (
    group.elements.find((element) =>
      matricesApproximatelyEqual(element.matrix, matrix, epsilon)
    ) ?? null
  );
}

export function groupSummary(group) {
  return {
    rule: group.rule,
    divisions: group.divisions,
    axisAngle: group.axisAngle,
    axisAngleDeg: (group.axisAngle * 180) / Math.PI,
    order: group.order,
    mirrorAxisCount: group.mirrorAxes.length,
    mirrorAxes: group.mirrorAxes.map((mirror) => ({
      k: mirror.k,
      angle: mirror.angle,
      angleDeg: (mirror.angle * 180) / Math.PI,
    })),
    rotationRayCount: group.rotationRays.length,
    rotationRays: group.rotationRays.map((ray) => ({
      k: ray.k,
      angle: ray.angle,
      angleDeg: (ray.angle * 180) / Math.PI,
    })),
    label:
      group.rule === 'dihedral'
        ? `D${group.divisions}（${group.order} 个变换）`
        : `C${group.divisions}（${group.order} 个变换）`,
  };
}
