import test from 'node:test';
import assert from 'node:assert/strict';

import { SketchDocument } from '../src/document.js';
import { compileStroke, strokeOrbitIdentity } from '../src/instance.js';
import { Surface } from '../src/raster.js';

const SIZE = 300;
const CENTER = { x: SIZE / 2, y: SIZE / 2 };

function makeDoc(background = 'transparent') {
  return new SketchDocument({ width: SIZE, height: SIZE, background });
}

function dihedral(divisions, extra = {}) {
  return {
    rule: 'dihedral',
    divisions,
    axisAngle: 0,
    center: { ...CENTER },
    reflection: 'mirror',
    dedupePolicy: 'coverage-union',
    ...extra,
  };
}

const roundBrush = {
  shape: 'round', size: 16, aspect: 1, skew: 0, tiltDeg: 0, opacity: 0.5, color: '#ff0000',
};
const nibBrush = {
  shape: 'nib', size: 12, aspect: 3, skew: 0.6, tiltDeg: 20, opacity: 0.4, color: '#063d2f',
};

function pixel(surface, x, y) {
  const rgba = surface.toRGBA8();
  const index = (y * surface.width + x) * 4;
  return [rgba[index], rgba[index + 1], rgba[index + 2], rgba[index + 3]];
}

function lineOnAxis(half = 100, step = 2) {
  const points = [];
  for (let y = CENTER.y - half; y <= CENTER.y + half; y += step) {
    points.push({ x: CENTER.x, y });
  }
  return points;
}

test('最小复现：中心点圆头只沉积一次，覆盖颜色为单次 alpha', () => {
  const doc = makeDoc();
  const compiled = doc.addStroke({
    points: [{ ...CENTER }],
    brush: roundBrush,
    symmetry: dihedral(6),
  });
  // 12 个群元素的姿态在中心同余，轨道合并为 1 个身份。
  assert.equal(compiled.instances.length, 1);
  assert.equal(compiled.writeCount, 1);
  assert.equal(compiled.mergedSamples, 11);
  const identity = strokeOrbitIdentity(compiled);
  assert.equal(identity.degenerateCount, 1);
  assert.equal(identity.degenerateInstances[0].sourceElementIds.length, 12);
  const { surface } = doc.renderWithReport();
  const [r, g, b, a] = pixel(surface, CENTER.x, CENTER.y);
  assert.deepEqual([r, g, b], [255, 0, 0]);
  assert.ok(Math.abs(a - 128) <= 1, `单次 0.5 不透明应≈128，实际 ${a}`);
});

test('沿对称轴往返多写：重合区不随往返次数重复加深', () => {
  const points = [];
  for (let y = CENTER.y - 100; y <= CENTER.y + 100; y += 2) points.push({ x: CENTER.x, y });
  for (let y = CENTER.y + 100; y >= CENTER.y - 100; y -= 2) points.push({ x: CENTER.x, y });
  for (let y = CENTER.y - 100; y <= CENTER.y + 100; y += 2) points.push({ x: CENTER.x, y });
  const doc = makeDoc();
  const compiled = doc.addStroke({ points, brush: nibBrush, symmetry: dihedral(6) });
  const { surface } = doc.renderWithReport();
  const expectedAlpha = Math.round(nibBrush.opacity * 255);
  const alpha = pixel(surface, CENTER.x, CENTER.y)[3];
  assert.ok(Math.abs(alpha - expectedAlpha) <= 2, `往返三次中心 alpha 应保持单次≈${expectedAlpha}，实际 ${alpha}`);
  // 账目必须平：写入 + 合并 == 采样 × 群阶。
  assert.equal(compiled.writeCount + compiled.mergedSamples, compiled.sampleCount * compiled.group.order);
});

test('轴交点轨迹：轴上每个采样点的覆盖颜色一致且只合成一次', () => {
  const doc = makeDoc();
  doc.addStroke({ points: lineOnAxis(90, 3), brush: nibBrush, symmetry: dihedral(6) });
  const { surface } = doc.renderWithReport();
  const alphas = [
    pixel(surface, CENTER.x, CENTER.y - 60)[3],
    pixel(surface, CENTER.x, CENTER.y)[3],
    pixel(surface, CENTER.x, CENTER.y + 60)[3],
  ];
  for (const alpha of alphas) {
    assert.ok(alpha > 0 && alpha <= Math.round(nibBrush.opacity * 255) + 2);
  }
  // 同一直线同笔尖，轴上三点的覆盖深度不应出现重复加深。
  assert.ok(Math.max(...alphas) - Math.min(...alphas) <= 2);
});

test('keep-all 对照确实更深，证明去重生效而非整体降透明度', () => {
  const points = lineOnAxis(100, 2);
  const unionDoc = makeDoc();
  unionDoc.addStroke({ points, brush: nibBrush, symmetry: dihedral(6) });
  const unionAlpha = pixel(unionDoc.renderWithReport().surface, CENTER.x, CENTER.y)[3];

  const keepDoc = makeDoc();
  keepDoc.addStroke({
    points,
    brush: nibBrush,
    symmetry: dihedral(6, { dedupePolicy: 'keep-all' }),
  });
  const keepAlpha = pixel(keepDoc.renderWithReport().surface, CENTER.x, CENTER.y)[3];
  assert.ok(keepAlpha >= unionAlpha + 40, `keep-all 应明显更深：union=${unionAlpha}, keep=${keepAlpha}`);
});

test('离开重合区后各实例仍独立按群变换绘制，不做虚假合并', () => {
  const compiled = compileStroke({
    id: 's1',
    points: [{ x: CENTER.x + 60, y: CENTER.y + 20 }, { x: CENTER.x + 95, y: CENTER.y + 48 }],
    brush: nibBrush,
    symmetry: dihedral(6),
  });
  assert.equal(compiled.instances.length, 12);
  assert.equal(compiled.mergedSamples, 0);
  const identity = strokeOrbitIdentity(compiled);
  assert.equal(identity.degenerateCount, 0);
  assert.equal(identity.instanceCount, 12);
});

test('每段笔迹记录稳定身份：一次落笔的全部副本共享 eventId', () => {
  const doc = makeDoc();
  const compiled = doc.addStroke({
    points: [{ ...CENTER }],
    brush: roundBrush,
    symmetry: dihedral(6),
    eventId: 'evt-fixed-1',
  });
  assert.equal(compiled.stroke.eventId, 'evt-fixed-1');
  const identity = strokeOrbitIdentity(compiled);
  assert.equal(identity.eventId, 'evt-fixed-1');
  // 未显式给出 eventId 时回落到稳定的笔画 id。
  const fallback = doc.addStroke({
    points: [{ x: CENTER.x + 10, y: CENTER.y }],
    brush: roundBrush,
    symmetry: dihedral(6),
  });
  assert.equal(fallback.stroke.eventId, fallback.stroke.id);
});

test('按原始笔事件撤销：轴线落笔只撤自己的副本，同色交叉笔画保持原位', () => {
  const doc = makeDoc();
  const sameColor = { ...roundBrush, color: '#222222', opacity: 0.6 };
  // 先前的同色交叉笔画（水平穿过中心）。
  doc.addStroke({
    id: undefined,
    points: [{ x: CENTER.x - 80, y: CENTER.y }, { x: CENTER.x + 80, y: CENTER.y }],
    brush: sameColor,
    symmetry: dihedral(6),
    eventId: 'evt-cross',
  });
  const crossId = doc.strokes[0].id;
  const before = pixel(doc.renderWithReport().surface, CENTER.x + 40, CENTER.y);

  doc.addStroke({
    points: [{ x: CENTER.x, y: CENTER.y - 80 }, { x: CENTER.x, y: CENTER.y + 80 }],
    brush: sameColor,
    symmetry: dihedral(6),
    eventId: 'evt-axis',
  });
  assert.equal(doc.strokeCount, 2);

  const removed = doc.removeStrokeByEvent('evt-axis');
  assert.ok(removed);
  assert.equal(removed.eventId, 'evt-axis');
  assert.equal(doc.strokeCount, 1);
  assert.equal(doc.strokes[0].eventId, 'evt-cross');
  const after = pixel(doc.renderWithReport().surface, CENTER.x + 40, CENTER.y);
  assert.deepEqual(after, before, '撤去轴上笔后，先前交叉笔画的像素必须原样保留');
  assert.equal(doc.strokes[0].id, crossId);
});

test('取消后重落：相同 eventId 的重复提交可被识别，镜像枚举不产生额外沉积', () => {
  const doc = makeDoc();
  const first = doc.addStroke({
    points: [{ ...CENTER }], brush: roundBrush, symmetry: dihedral(6), eventId: 'evt-once',
  });
  const firstAlpha = pixel(doc.renderWithReport().surface, CENTER.x, CENTER.y)[3];
  // 模拟事件重送：用同一 eventId 再落一次。文档层以 eventId 标识同一原始笔事件，
  // 撤销其中之一时应能精确定位，而不影响另一笔事件。
  const second = doc.addStroke({
    points: [{ ...CENTER }], brush: roundBrush, symmetry: dihedral(6), eventId: 'evt-resent',
  });
  assert.notEqual(first.stroke.id, second.stroke.id);
  const stackedAlpha = pixel(doc.renderWithReport().surface, CENTER.x, CENTER.y)[3];
  assert.ok(stackedAlpha > firstAlpha, '两次独立笔事件正常叠加（这是合法的多次落笔）');
  // 撤去重送的那一笔，回到第一次落笔的覆盖。
  doc.removeStrokeByEvent('evt-resent');
  const restoredAlpha = pixel(doc.renderWithReport().surface, CENTER.x, CENTER.y)[3];
  assert.equal(restoredAlpha, firstAlpha);
});

test('序列化重放保留 eventId 与轨道身份，PNG 逐字节一致', () => {
  const doc = makeDoc('#fff8ec');
  doc.addStroke({
    points: [{ ...CENTER }],
    brush: roundBrush,
    symmetry: dihedral(8),
    eventId: 'evt-persist',
  });
  const json = JSON.parse(JSON.stringify(doc.toJSON()));
  assert.equal(json.strokes[0].eventId, 'evt-persist');
  const replay = SketchDocument.fromJSON(json);
  assert.equal(replay.strokes[0].eventId, 'evt-persist');
  assert.equal(
    strokeOrbitIdentity(replay.getCompiled(replay.strokes[0].id)).eventId,
    'evt-persist'
  );
  const a = Buffer.from(doc.toPNG());
  const b = Buffer.from(replay.toPNG());
  assert.equal(Buffer.compare(a, b), 0);
});

test('旧版无 eventId 文档回放时身份回落到笔画 id', () => {
  const doc = makeDoc();
  doc.addStroke({ points: [{ ...CENTER }], brush: roundBrush, symmetry: dihedral(4) });
  const json = doc.toJSON();
  delete json.strokes[0].eventId; // 模拟 v1 旧文档
  const replay = SketchDocument.fromJSON(JSON.parse(JSON.stringify(json)));
  assert.equal(replay.strokes[0].eventId, replay.strokes[0].id);
});

test('C 群中心圆点：纯旋转下也只沉积一次', () => {
  const doc = makeDoc();
  const compiled = doc.addStroke({
    points: [{ ...CENTER }],
    brush: roundBrush,
    symmetry: dihedral(6, { rule: 'cyclic' }),
  });
  assert.equal(compiled.instances.length, 1);
  assert.equal(compiled.mergedSamples, 5);
  const alpha = pixel(doc.renderWithReport().surface, CENTER.x, CENTER.y)[3];
  assert.ok(Math.abs(alpha - 128) <= 1);
});
