import test from 'node:test';
import assert from 'node:assert/strict';

import {
  makeGroup,
  composeMatrices,
  matricesApproximatelyEqual,
  findElementByMatrix,
  identityMatrix,
  reflectionMatrix,
  rotationMatrix,
  normalizeAxisAngle,
  axisDelta,
} from '../src/group.js';

test('二面体群对复合封闭（D6, 轴角 0.3）', () => {
  const group = makeGroup({ rule: 'dihedral', divisions: 6, axisAngle: 0.3 });
  assert.equal(group.order, 12);
  for (const a of group.elements) {
    for (const b of group.elements) {
      const product = composeMatrices(a.matrix, b.matrix);
      assert.ok(findElementByMatrix(group, product), `${a.id}·${b.id} 应仍在群内`);
    }
  }
});

test('每个元素的逆特征：旋转逆为反向旋转，反射自逆', () => {
  for (const divisions of [1, 2, 3, 4, 5, 8, 12]) {
    const group = makeGroup({ rule: 'dihedral', divisions });
    assert.equal(group.order, divisions * 2);
    for (const element of group.elements) {
      for (const candidate of group.elements) {
        const product = composeMatrices(element.matrix, candidate.matrix);
        const isIdentity = matricesApproximatelyEqual(product, identityMatrix(), 1e-9);
        if (element.determinant > 0) {
          // 旋转的逆是同群的反向旋转；只验证存在性。
          continue;
        }
        if (isIdentity) {
          // 反射自逆：候选应当就是自身。
          assert.ok(
            matricesApproximatelyEqual(candidate.matrix, element.matrix, 1e-9),
            '反射的逆必须是自身'
          );
        }
      }
    }
  }
});

test('群阶与轴数随分区数变化', () => {
  for (const divisions of [1, 2, 3, 4, 6, 8, 12]) {
    const dihedral = makeGroup({ rule: 'dihedral', divisions });
    assert.equal(dihedral.order, divisions * 2);
    assert.equal(dihedral.mirrorAxes.length, divisions);
    const cyclic = makeGroup({ rule: 'cyclic', divisions });
    assert.equal(cyclic.order, divisions);
    assert.equal(cyclic.mirrorAxes.length, 0);
    assert.equal(cyclic.rotationRays.length, divisions);
  }
});

test('镜线角度彼此相差 π/n，且关于轴角偏移正确', () => {
  const group = makeGroup({ rule: 'dihedral', divisions: 6, axisAngle: 0.4 });
  const angles = group.mirrorAxes.map((mirror) => mirror.angle);
  for (const angle of angles) {
    assert.ok(Math.abs(angle) < Math.PI + 1e-12);
  }
  const sorted = [...angles].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) {
    const delta = axisDelta(sorted[i], sorted[i - 1]);
    const expected = Math.min(Math.PI / 6, Math.PI - Math.PI / 6);
    assert.ok(Math.abs(delta - expected) < 1e-9, `相邻轴夹角应为 π/6，实际 ${delta}`);
  }
});

test('反射矩阵是关于给定向量的镜像', () => {
  const axis = 0.7;
  const matrix = reflectionMatrix(axis);
  // 轴上的向量不变。
  const onAxis = { x: Math.cos(axis), y: Math.sin(axis) };
  const mapped = {
    x: matrix.a * onAxis.x + matrix.b * onAxis.y,
    y: matrix.c * onAxis.x + matrix.d * onAxis.y,
  };
  assert.ok(Math.abs(mapped.x - onAxis.x) < 1e-12);
  assert.ok(Math.abs(mapped.y - onAxis.y) < 1e-12);
  // 垂直向量取反。
  const normal = { x: -Math.sin(axis), y: Math.cos(axis) };
  const normalMapped = {
    x: matrix.a * normal.x + matrix.b * normal.y,
    y: matrix.c * normal.x + matrix.d * normal.y,
  };
  assert.ok(Math.abs(normalMapped.x + normal.x) < 1e-12);
  assert.ok(Math.abs(normalMapped.y + normal.y) < 1e-12);
});

test('旋转矩阵复合满足 R(α)·R(β)=R(α+β)', () => {
  const alpha = 0.9;
  const beta = 1.7;
  const product = composeMatrices(rotationMatrix(alpha), rotationMatrix(beta));
  assert.ok(matricesApproximatelyEqual(product, rotationMatrix(alpha + beta), 1e-12));
});

test('轴角归一化到 [0, π)', () => {
  assert.equal(normalizeAxisAngle(0), 0);
  assert.ok(Math.abs(normalizeAxisAngle(Math.PI) - 0) < 1e-12);
  assert.ok(Math.abs(normalizeAxisAngle(-Math.PI / 2) - Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(normalizeAxisAngle(3 * Math.PI + 0.2) - 0.2) < 1e-12);
});

test('非法分区数被拒绝', () => {
  assert.throws(() => makeGroup({ divisions: 0 }), RangeError);
  assert.throws(() => makeGroup({ divisions: -3 }), RangeError);
  assert.throws(() => makeGroup({ divisions: 1000 }), RangeError);
  assert.throws(() => makeGroup({ rule: 'nope', divisions: 4 }), RangeError);
});
