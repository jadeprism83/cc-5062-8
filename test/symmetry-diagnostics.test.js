import test from 'node:test';
import assert from 'node:assert/strict';

import { SketchDocument } from '../src/document.js';
import { strokeOrbitIdentity } from '../src/instance.js';

const SIZE = 240;
const CENTER = { x: SIZE / 2, y: SIZE / 2 };

function makeDoc() {
  return new SketchDocument({ width: SIZE, height: SIZE, background: 'transparent' });
}

function symmetry(overrides = {}) {
  return {
    rule: 'dihedral',
    divisions: 6,
    axisAngle: 0,
    center: { ...CENTER },
    reflection: 'mirror',
    dedupePolicy: 'coverage-union',
    ...overrides,
  };
}

const brush = {
  shape: 'nib', size: 12, aspect: 3, skew: 0.6, tiltDeg: 20, opacity: 0.4, color: '#063d2f',
};

/** 与 ui/main.js 中 collectSymmetryDiagnostics 同一套判定规则的纯函数版，便于单测。 */
function evaluate(doc) {
  const anomalies = [];
  for (const stroke of doc.strokes) {
    const compiled = doc.getCompiled(stroke.id);
    const identity = strokeOrbitIdentity(compiled);
    const expectedRaw = identity.sampleCount * identity.groupOrder;
    if (identity.dedupePolicy === 'keep-all') {
      anomalies.push({ level: 'warning', strokeId: stroke.id });
    }
    if (identity.writeCount + identity.mergedSamples !== expectedRaw) {
      anomalies.push({ level: 'error', strokeId: stroke.id });
    }
    const validIds = new Set(compiled.group.elements.map((element) => element.id));
    for (const degenerate of identity.degenerateInstances) {
      for (const sourceId of degenerate.sourceElementIds) {
        if (!validIds.has(sourceId)) anomalies.push({ level: 'error', strokeId: stroke.id });
      }
    }
  }
  return anomalies;
}

test('正常 coverage-union 作品（含轴上简并）不产生任何异常：不允许伪报', () => {
  const doc = makeDoc();
  // 中心点（强简并）+ 轴向长线（轴交点简并）+ 离轴笔画（无简并）。
  doc.addStroke({
    points: [{ ...CENTER }],
    brush: { shape: 'round', size: 18, aspect: 1, skew: 0, tiltDeg: 0, opacity: 0.5, color: '#f00' },
    symmetry: symmetry(),
  });
  const axisPoints = [];
  for (let y = CENTER.y - 80; y <= CENTER.y + 80; y += 3) axisPoints.push({ x: CENTER.x, y });
  doc.addStroke({ points: axisPoints, brush, symmetry: symmetry() });
  doc.addStroke({
    points: [{ x: CENTER.x + 50, y: CENTER.y + 20 }, { x: CENTER.x + 90, y: CENTER.y + 50 }],
    brush,
    symmetry: symmetry(),
  });
  const anomalies = evaluate(doc);
  assert.deepEqual(anomalies, [], '重合区域的正确去重绝不能被标记为异常');
});

test('keep-all 只给 warning 级提示，不报 error', () => {
  const doc = makeDoc();
  doc.addStroke({
    points: [{ ...CENTER }],
    brush: { shape: 'round', size: 16, aspect: 1, skew: 0, tiltDeg: 0, opacity: 0.5, color: '#f00' },
    symmetry: symmetry({ dedupePolicy: 'keep-all' }),
  });
  const anomalies = evaluate(doc);
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].level, 'warning');
});

test('账目被人为破坏时给出 error 级异常', () => {
  const doc = makeDoc();
  const compiled = doc.addStroke({
    points: [{ ...CENTER }],
    brush: { shape: 'round', size: 16, aspect: 1, skew: 0, tiltDeg: 0, opacity: 0.5, color: '#f00' },
    symmetry: symmetry(),
  });
  // 篡改编译产物制造账目不平，验证错误级检测确实能触发（而非永远绿灯）。
  compiled.mergedSamples += 1;
  const anomalies = evaluate(doc);
  assert.ok(anomalies.some((entry) => entry.level === 'error'));
});
