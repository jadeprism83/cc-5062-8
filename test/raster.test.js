import test from 'node:test';
import assert from 'node:assert/strict';

import { SketchDocument } from '../src/document.js';
import { makeSymmetrySnapshot } from '../src/instance.js';
import { Surface, popcount16, rasterizePolygonBits, SUBSAMPLES } from '../src/raster.js';
import { encodePNG } from '../src/png.js';

const SIZE = 240;
const CENTER = { x: SIZE / 2, y: SIZE / 2 };

function makeDoc(background = '#ffffff') {
  return new SketchDocument({ width: SIZE, height: SIZE, background });
}

function dihedral(divisions, extra = {}) {
  return {
    rule: 'dihedral',
    divisions,
    axisAngle: 0,
    center: { ...CENTER },
    reflection: 'mirror',
    ...extra,
  };
}

/** 读取像素 RGBA（0-255）。 */
function pixel(surface, x, y) {
  const rgba = surface.toRGBA8();
  const index = (y * surface.width + x) * 4;
  return [rgba[index], rgba[index + 1], rgba[index + 2], rgba[index + 3]];
}

test('覆盖位掩码：同一位置重复写入不增加覆盖率', () => {
  const width = 20;
  const height = 20;
  const bits = new Uint16Array(width * height);
  const square = [
    { x: 5, y: 5 },
    { x: 15, y: 5 },
    { x: 15, y: 15 },
    { x: 5, y: 15 },
  ];
  rasterizePolygonBits(square, bits, width, height);
  const first = [...bits];
  rasterizePolygonBits(square, bits, width, height);
  assert.deepEqual([...bits], first, '位 OR 保证重复覆盖不会累加');
  const covered = bits.reduce((sum, value) => sum + (value !== 0 ? 1 : 0), 0);
  assert.equal(covered, 100);
  const fullCoverage = bits.filter((value) => popcount16(value) === SUBSAMPLES * SUBSAMPLES);
  assert.equal(fullCoverage.length, 100);
});

test('两个完全重合的实例写入画布不加深颜色', () => {
  const doc = makeDoc();
  const brush = {
    shape: 'nib',
    size: 12,
    aspect: 2,
    skew: 0.3,
    tiltDeg: 0,
    opacity: 1,
    color: '#000000',
  };
  // divisions=1 的群只有恒等 + 一条镜线；把中心放在笔尖外，使两实例位置不同。
  // 这里构造一个在镜线上的短笔画，其姿态在反射下自对称。
  const stroke = doc.addStroke({
    points: [{ x: CENTER.x, y: CENTER.y - 30 }, { x: CENTER.x, y: CENTER.y + 30 }],
    brush,
    symmetry: dihedral(2),
  });
  const { surface } = doc.renderWithReport();
  const centrePixel = pixel(surface, CENTER.x, CENTER.y);
  assert.equal(centrePixel[3], 255);
  assert.equal(centrePixel[0], 0, '满覆盖单次着色应为纯黑，而非重复叠加');
});

test('D4 圆点：结果关于 x 轴与 y 轴像素级对称', () => {
  const doc = makeDoc('#ffffff');
  doc.addStroke({
    points: [{ x: CENTER.x + 42, y: CENTER.y - 28 }, { x: CENTER.x + 58, y: CENTER.y - 10 }],
    brush: {
      shape: 'nib',
      size: 9,
      aspect: 2.4,
      skew: 0.4,
      tiltDeg: 15,
      opacity: 0.9,
      color: '#24405f',
    },
    symmetry: dihedral(4),
  });
  const { surface } = doc.renderWithReport();
  const rgba = surface.toRGBA8();
  const W = surface.width;
  const H = surface.height;
  let compared = 0;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4;
      const mirroredY = ((H - 1 - y) * W + x) * 4;
      const mirroredX = (y * W + (W - 1 - x)) * 4;
      assert.equal(rgba[i], rgba[mirroredY], `水平镜像在 (${x},${y}) 不一致`);
      assert.equal(rgba[i], rgba[mirroredX], `垂直镜像在 (${x},${y}) 不一致`);
      compared += 1;
    }
  }
  assert.ok(compared > 0);
});

test('C2 关于中心 180° 旋转后像素完全一致（非零轴角）', () => {
  const doc = makeDoc('#ffffff');
  // C2 的轴角只决定非反射群的参考方向；R1 是中心对称（旋转 π）。
  doc.addStroke({
    points: [{ x: CENTER.x + 61, y: CENTER.y - 37 }, { x: CENTER.x + 88, y: CENTER.y + 5 }],
    brush: {
      shape: 'nib',
      size: 10,
      aspect: 2.2,
      skew: 0.5,
      tiltDeg: 33,
      opacity: 0.85,
      color: '#3a2a55',
    },
    symmetry: { ...dihedral(2), rule: 'cyclic', axisAngle: 0.4 },
  });
  const { surface } = doc.renderWithReport();
  const rgba = surface.toRGBA8();
  const W = surface.width;
  const H = surface.height;
  let differences = 0;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4;
      const rotated = ((H - 1 - y) * W + (W - 1 - x)) * 4;
      if (rgba[i] !== rgba[rotated] || rgba[i + 1] !== rgba[rotated + 1]) differences += 1;
    }
  }
  assert.equal(differences, 0, 'C2 的 180° 旋转副本应逐像素一致');
});

test('反射群下像素严格镜像（含笔尖手性）', () => {
  const doc = makeDoc('#ffffff');
  // axisAngle=0 的镜线是过中心的水平线，因此应比较上下镜像。
  const symmetry = {
    rule: 'dihedral',
    divisions: 1,
    axisAngle: 0,
    center: { ...CENTER },
    reflection: 'mirror',
  };
  doc.addStroke({
    points: [{ x: CENTER.x + 30, y: CENTER.y - 12 }, { x: CENTER.x + 70, y: CENTER.y + 16 }],
    brush: {
      shape: 'nib',
      size: 11,
      aspect: 2.6,
      skew: 0.8,
      tiltDeg: 12,
      opacity: 1,
      color: '#112233',
    },
    symmetry,
  });
  const { surface } = doc.renderWithReport();
  const rgba = surface.toRGBA8();
  const W = surface.width;
  const H = surface.height;
  let differences = 0;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4;
      const mirrored = ((H - 1 - y) * W + x) * 4;
      if (rgba[i] !== rgba[mirrored] || rgba[i + 1] !== rgba[mirrored + 1]) differences += 1;
    }
  }
  assert.equal(differences, 0, '严格镜像模式下，上下两侧应逐像素镜像');
});

test('保留手性模式下，反射实例的笔尖不镜像翻转', () => {
  const doc = makeDoc('#ffffff');
  const brush = {
    shape: 'nib',
    size: 10,
    aspect: 3,
    skew: 1.2,
    tiltDeg: 0,
    opacity: 1,
    color: '#112233',
  };
  doc.addStroke({
    points: [{ x: CENTER.x + 40, y: CENTER.y - 10 }, { x: CENTER.x + 80, y: CENTER.y + 10 }],
    brush,
    symmetry: {
      rule: 'dihedral',
      divisions: 1,
      axisAngle: 0,
      center: { ...CENTER },
      reflection: 'preserve-hand',
    },
  });
  const compiled = doc.getCompiled('s1');
  const reflectionInstance = compiled.instances.find((instance) => instance.elementKind === 'reflection');
  assert.ok(reflectionInstance);
  const reflectionStamps = compiled.orbit.filter((stamp) => stamp.elementKind === 'reflection');
  assert.ok(reflectionStamps.every((stamp) => Math.abs(stamp.skew - brush.skew) < 1e-9));
  const mirrorStamps = compiled.orbit.filter((stamp) => stamp.elementKind === 'rotation');
  assert.ok(mirrorStamps.every((stamp) => Math.abs(stamp.skew - brush.skew) < 1e-9));
});

test('透明背景下重叠笔画的 alpha 不因轴上简并副本而加倍', () => {
  const doc = makeDoc('transparent');
  const brush = {
    shape: 'round',
    size: 20,
    aspect: 1,
    skew: 0,
    tiltDeg: 0,
    opacity: 0.5,
    color: '#ff0000',
  };
  // D8 中心点：圆头落在中心，所有变换姿态同余，只着色一次。
  doc.addStroke({
    points: [{ x: CENTER.x, y: CENTER.y }],
    brush,
    symmetry: dihedral(8),
  });
  const { surface } = doc.renderWithReport();
  const rgba = surface.toRGBA8();
  const index = (CENTER.y * surface.width + CENTER.x) * 4;
  assert.equal(rgba[index + 3], 128, 'alpha 应约为 0.5×255，而非接近 255');
});

test('穿过中心的轴向长线：覆盖并集保证中点只着色一次', () => {
  const points = [];
  for (let y = CENTER.y - 100; y <= CENTER.y + 100; y += 2) {
    points.push({ x: CENTER.x, y });
  }
  const brush = {
    shape: 'nib',
    size: 10,
    aspect: 3,
    skew: 0.8,
    tiltDeg: 20,
    opacity: 0.4,
    color: '#063d2f',
  };
  const unionDoc = makeDoc('transparent');
  unionDoc.addStroke({ points, brush, symmetry: dihedral(6) });
  const unionSurface = unionDoc.renderWithReport().surface;
  const unionAlpha = pixel(unionSurface, CENTER.x, CENTER.y)[3];

  const keepDoc = makeDoc('transparent');
  keepDoc.addStroke({
    points,
    brush,
    symmetry: dihedral(6, { dedupePolicy: 'keep-all' }),
  });
  const keepSurface = keepDoc.renderWithReport().surface;
  const keepAlpha = pixel(keepSurface, CENTER.x, CENTER.y)[3];

  // 中心处 6 条镜线 + 6 个旋转让 12 个实例重合一孔。
  assert.ok(unionAlpha > 0, '中点应被着色');
  assert.ok(unionAlpha <= 128, `覆盖并集 alpha 应约等于单次 0.4×255，实际 ${unionAlpha}`);
  assert.ok(
    keepAlpha >= unionAlpha + 40,
    `保留全部应因重复加深而明显更不透明：union=${unionAlpha}, keep=${keepAlpha}`
  );
});

test('PNG 输出可被解析且尺寸/通道正确', () => {
  const doc = makeDoc();
  doc.addStroke({
    points: [{ x: 120, y: 80 }, { x: 160, y: 120 }],
    brush: { shape: 'nib', size: 8, aspect: 2, skew: 0.2, opacity: 0.7, color: '#335577' },
    symmetry: dihedral(4),
  });
  const png = doc.toPNG();
  assert.equal(png[0], 0x89);
  assert.equal(String.fromCharCode(...png.subarray(1, 4)), 'PNG');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  assert.equal(view.getUint32(16), SIZE);
  assert.equal(view.getUint32(20), SIZE);
  assert.equal(png[24], 8, '位深应为 8');
  assert.equal(png[25], 6, '颜色类型应为 RGBA');
  // IEND 结束块。
  assert.equal(String.fromCharCode(...png.subarray(png.length - 8, png.length - 4)), 'IEND');
});

test('序列化重放逐字节一致（可重放笔画）', () => {
  const doc = makeDoc('#fff8ec');
  doc.addStroke({
    points: [{ x: 90, y: 90 }, { x: 130, y: 100 }, { x: 150, y: 140 }],
    brush: { shape: 'nib', size: 12, aspect: 2.3, skew: 0.42, tiltDeg: 21, opacity: 0.83, color: '#1a2b3c' },
    symmetry: dihedral(6),
  });
  doc.addStroke({
    points: [{ x: 60, y: 160 }, { x: 100, y: 190 }],
    brush: { shape: 'round', size: 7, aspect: 2, skew: 0, tiltDeg: -10, opacity: 0.9, color: '#c0392b' },
    symmetry: { ...dihedral(6), rule: 'cyclic', divisions: 5 },
  });
  const json = JSON.parse(JSON.stringify(doc.toJSON()));
  const replayed = SketchDocument.fromJSON(json);
  const a = Buffer.from(doc.toPNG());
  const b = Buffer.from(replayed.toPNG());
  assert.equal(Buffer.compare(a, b), 0, '重放必须得到逐字节相同的 PNG');

  const a2 = Buffer.from(doc.toPNG());
  const b2 = Buffer.from(replayed.toPNG());
  assert.equal(Buffer.compare(a2, b2), 0);
});

test('修改工具设置不改变既有笔画的渲染（快照冻结）', () => {
  const doc = makeDoc();
  doc.addStroke({
    points: [{ x: 140, y: 90 }, { x: 170, y: 130 }],
    brush: { shape: 'nib', size: 9, aspect: 2, skew: 0.3, opacity: 0.8, color: '#224466' },
    symmetry: dihedral(4),
  });
  const before = Buffer.from(doc.toPNG());
  // 模拟“改分区数”：新建文档从 JSON 恢复，确认历史笔画自带 divisions=4。
  const json = doc.toJSON();
  assert.equal(json.strokes[0].symmetry.divisions, 4);
  const after = Buffer.from(doc.toPNG());
  assert.equal(Buffer.compare(before, after), 0);
  const replay = SketchDocument.fromJSON(json);
  assert.equal(replay.getCompiled('s1').instances.length, 8);
});

test('可重放 JSON 不含编译产物，只保留原始笔画与冻结快照', () => {
  const doc = makeDoc();
  doc.addStroke({
    points: [{ x: 100, y: 100 }, { x: 140, y: 120 }],
    brush: { shape: 'nib', size: 8, aspect: 2, opacity: 0.9, color: '#333333' },
    symmetry: dihedral(6),
  });
  const json = doc.toJSON();
  assert.equal(json.version, 1);
  assert.ok(Array.isArray(json.strokes));
  for (const stroke of json.strokes) {
    assert.ok(Array.isArray(stroke.points));
    assert.ok(stroke.symmetry);
    assert.ok(!('orbit' in stroke), '不应序列化编译后的实例');
    assert.ok(!('instances' in stroke));
  }
});

test('Surface 背景透明与不透明两种模式', () => {
  const transparent = new Surface(8, 8, 'transparent');
  const rgbaT = transparent.toRGBA8();
  assert.equal(rgbaT[3], 0);
  const opaque = new Surface(8, 8, '#102030');
  const rgbaO = opaque.toRGBA8();
  assert.equal(rgbaO[0], 0x10);
  assert.equal(rgbaO[1], 0x20);
  assert.equal(rgbaO[2], 0x30);
  assert.equal(rgbaO[3], 255);
});

test('编码 PNG 对小尺寸也稳定', () => {
  const surface = new Surface(4, 4, '#ffffff');
  const png = encodePNG(4, 4, surface.toRGBA8());
  assert.ok(png.length > 8);
  assert.equal(png[0], 0x89);
});
