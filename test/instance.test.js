import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compileStroke,
  makeSymmetrySnapshot,
  transformNibParams,
  posesCoincide,
  brushOrientationMode,
  groupFromSnapshot,
  transformPoint,
} from '../src/instance.js';
import { makeGroup } from '../src/group.js';
import { normalizeBrush } from '../src/brush.js';

const nibBrush = {
  shape: 'nib',
  size: 10,
  aspect: 3,
  skew: 0.5,
  tiltDeg: 20,
  opacity: 0.8,
  color: '#334455',
};

function compile(points, brush, symmetry, extra = {}) {
  return compileStroke({
    id: 'test',
    points,
    brush,
    symmetry,
    ...extra,
  });
}

const baseSymmetry = {
  rule: 'dihedral',
  divisions: 6,
  axisAngle: 0,
  center: { x: 200, y: 200 },
  reflection: 'mirror',
};

test('离轴的一般笔画：D6 生成 12 个实例，不做虚假合并', () => {
  const compiled = compile(
    [{ x: 260, y: 240 }, { x: 300, y: 270 }],
    nibBrush,
    baseSymmetry
  );
  assert.equal(compiled.group.order, 12);
  assert.equal(compiled.instances.length, 12);
  assert.equal(compiled.mergedSamples, 0);
  assert.equal(compiled.dedupePolicy, 'coverage-union');
  for (const instance of compiled.instances) {
    assert.ok(instance.coverCount > 0);
  }
});

test('圆形笔尖落在中心：所有变换姿态同余，合并为一次覆盖', () => {
  const compiled = compile(
    [{ x: 200, y: 200 }],
    { ...nibBrush, shape: 'round', aspect: 1, skew: 0 },
    baseSymmetry
  );
  assert.equal(compiled.orientationMode, 'isotropic');
  assert.equal(compiled.instances.length, 1);
  assert.equal(compiled.instances[0].sourceElementIds.length, 12);
  assert.equal(compiled.writeCount, 1);
  assert.equal(compiled.mergedSamples, 11);
});

test('无错切椭圆笔尖落在中心：方向按 π 折叠，6 个方向各由两个元素共享', () => {
  const compiled = compile(
    [{ x: 200, y: 200 }],
    { ...nibBrush, shape: 'round', aspect: 2.5, skew: 0 },
    baseSymmetry
  );
  assert.equal(compiled.orientationMode, 'bidirectional');
  // D6 有 6 个方向各出现两次（旋转 180° 后姿态等价）。
  assert.equal(compiled.instances.length, 6);
  for (const instance of compiled.instances) {
    assert.equal(instance.sourceElementIds.length, 2);
  }
});

test('错切椭圆不再有 180° 对称，必须按有向姿态处理', () => {
  const brush = normalizeBrush({ ...nibBrush, shape: 'round', aspect: 2.5, skew: 0.4 });
  assert.equal(brushOrientationMode(brush), 'directed');
  const compiled = compile([{ x: 200, y: 200 }], brush, baseSymmetry);
  assert.equal(compiled.instances.length, 12);
});

test('尖笔中心点：笔尖有向，12 个方向各自不同，不能合并', () => {
  const compiled = compile([{ x: 200, y: 200 }], nibBrush, baseSymmetry);
  assert.equal(compiled.orientationMode, 'directed');
  assert.equal(compiled.instances.length, 12);
});

test('沿对称轴的往返笔画：正反两段覆盖等价时被合并', () => {
  // 竖直穿过中心的笔画，在 D6（轴角 0，镜线含 90°）下，S3 把上下两半互换。
  const compiled = compile(
    [{ x: 200, y: 120 }, { x: 200, y: 280 }],
    nibBrush,
    baseSymmetry
  );
  // 每个样本的两个竖直方向在 90° 镜线两侧互为镜像。
  assert.equal(compiled.instances.length, 12);
  const total = compiled.instances.reduce((sum, instance) => sum + instance.coverCount, 0);
  assert.equal(total, compiled.writeCount);
});

test('反射语义 mirror 翻转手性，preserve-hand 保留手性', () => {
  const group = makeGroup({ rule: 'dihedral', divisions: 4, axisAngle: 0 });
  const sample = { theta: 0.3, skew: 0.5 };
  const mirrorElement = group.elements.find((element) => element.id === 'S0');
  const mirrored = transformNibParams(mirrorElement, sample, 'mirror');
  const preserved = transformNibParams(mirrorElement, sample, 'preserve-hand');
  assert.ok(Math.abs(mirrored.skew + 0.5) < 1e-12);
  assert.ok(Math.abs(preserved.skew - 0.5) < 1e-12);
  // 方向都按 2φ−θ 变化。
  assert.ok(Math.abs(mirrored.theta - preserved.theta) < 1e-12);
});

test('旋转保持手性，方向按 +α 累加', () => {
  const group = makeGroup({ rule: 'cyclic', divisions: 4, axisAngle: 0 });
  const rotation = group.elements.find((element) => element.id === 'R1');
  const result = transformNibParams(rotation, { theta: 0.2, skew: -0.7 }, 'mirror');
  assert.ok(Math.abs(result.skew + 0.7) < 1e-12);
  assert.ok(Math.abs(result.theta - (0.2 + Math.PI / 2)) < 1e-12);
});

test('群变换闭合：轨道中每个实例都可由某一元素还原', () => {
  const symmetry = makeSymmetrySnapshot({ ...baseSymmetry, divisions: 5 });
  const group = groupFromSnapshot(symmetry);
  const compiled = compile(
    [{ x: 240, y: 210 }, { x: 280, y: 250 }],
    nibBrush,
    symmetry
  );
  const sourcePoints = new Set(
    compiled.orbit.map((stamp) => `${stamp.sourceSampleIndex}`)
  );
  assert.ok(sourcePoints.size > 0);
  for (const stamp of compiled.orbit) {
    // 用群元素把原始样本点变换后应得到实例位置。
    const sample = compiled.samples[stamp.sourceSampleIndex];
    const expected = transformPoint(stamp.element, symmetry.center, sample.x, sample.y);
    assert.ok(
      Math.hypot(expected.x - stamp.position.x, expected.y - stamp.position.y) < 1e-9,
      '实例位置必须与群变换一致'
    );
  }
});

test('posesCoincide 对姿态用容差而非浮点全等', () => {
  const tolerance = { position: 0.05, angle: 0.01, skew: 1e-6 };
  const a = { position: { x: 10, y: 10 }, theta: 0.5, skew: 0.2 };
  const b = { position: { x: 10 + 1e-9, y: 10 + 1e-9 }, theta: 0.5 + 1e-9, skew: 0.2 };
  assert.equal(posesCoincide(a, b, tolerance, 'directed'), true);
  const c = { position: { x: 10.2, y: 10 }, theta: 0.5, skew: 0.2 };
  assert.equal(posesCoincide(a, c, tolerance, 'directed'), false);
});

test('keep-all 政策保留全部实例，不做合并', () => {
  const compiled = compile(
    [{ x: 200, y: 200 }],
    { ...nibBrush, shape: 'round', aspect: 1, skew: 0 },
    baseSymmetry,
    { dedupePolicy: 'keep-all' }
  );
  assert.equal(compiled.dedupePolicy, 'keep-all');
  assert.equal(compiled.instances.length, 12);
  assert.equal(compiled.writeCount, 12);
});

test('C_n 无反射实例', () => {
  const compiled = compile(
    [{ x: 250, y: 230 }, { x: 290, y: 250 }],
    nibBrush,
    { ...baseSymmetry, rule: 'cyclic', divisions: 5 }
  );
  assert.equal(compiled.group.order, 5);
  assert.ok(compiled.instances.every((instance) => instance.elementKind === 'rotation'));
});

test('分区数改变不回溯影响已编译笔画', () => {
  const first = compile(
    [{ x: 250, y: 220 }, { x: 280, y: 250 }],
    nibBrush,
    { ...baseSymmetry, divisions: 4 }
  );
  const second = compile(
    [{ x: 250, y: 220 }, { x: 280, y: 250 }],
    nibBrush,
    { ...baseSymmetry, divisions: 8 }
  );
  assert.equal(first.instances.length, 8);
  assert.equal(second.instances.length, 16);
  // 已经编译好的第一条不因第二次编译而改变。
  assert.equal(first.instances.length, 8);
  assert.deepEqual(first.snapshot, makeSymmetrySnapshot({ ...baseSymmetry, divisions: 4 }));
});

test('非法反射语义 / 覆盖政策被拒绝', () => {
  assert.throws(
    () => makeSymmetrySnapshot({ ...baseSymmetry, reflection: 'bogus' }),
    RangeError
  );
  assert.throws(
    () => makeSymmetrySnapshot({ ...baseSymmetry, dedupePolicy: 'bogus' }),
    RangeError
  );
});
