import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SketchDocument } from '../src/document.js';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples');
const W = 900;
const H = 640;
const CENTER = { x: W / 2, y: H / 2 };

function arc(cx, cy, rx, ry, start, end, steps = 96) {
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const angle = start + (end - start) * t;
    points.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
  }
  return points;
}

function line(from, to, steps = 40) {
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    points.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  }
  return points;
}

function makeDocument(title, background) {
  return new SketchDocument({ width: W, height: H, background, title });
}

function baseSymmetry(overrides = {}) {
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

function flower() {
  const doc = makeDocument('对称花冠', '#fbf8f2');
  const brush = {
    shape: 'nib',
    size: 14,
    aspect: 2.8,
    skew: 0.62,
    tiltDeg: 18,
    opacity: 0.82,
    color: '#1d3557',
  };
  doc.addStroke({
    points: arc(CENTER.x, CENTER.y, 210, 60, -Math.PI * 0.62, Math.PI * 0.62),
    brush,
    symmetry: baseSymmetry({ divisions: 6 }),
  });
  doc.addStroke({
    points: arc(CENTER.x, CENTER.y, 130, 130, -Math.PI * 0.5, Math.PI * 0.5),
    brush: { ...brush, size: 9, opacity: 0.7, color: '#7b2d26' },
    symmetry: baseSymmetry({ divisions: 6, axisAngle: Math.PI / 12 }),
  });
  doc.addStroke({
    points: [{ x: CENTER.x, y: CENTER.y }],
    brush: { shape: 'round', size: 22, aspect: 1, skew: 0, tiltDeg: 0, opacity: 0.55, color: '#c98b2e' },
    symmetry: baseSymmetry({ divisions: 6 }),
  });
  return doc;
}

function axisStress() {
  // 中心点 + 沿对称轴的往返长线 + 斜向非对称笔尖，用于核对去重与闭合。
  const doc = makeDocument('轴向压力测试', '#ffffff');
  const nib = {
    shape: 'nib',
    size: 12,
    aspect: 3.2,
    skew: 0.9,
    tiltDeg: 25,
    opacity: 0.45,
    color: '#0b6e4f',
  };
  doc.addStroke({
    points: line({ x: CENTER.x, y: CENTER.y - 250 }, { x: CENTER.x, y: CENTER.y + 250 }),
    brush: nib,
    symmetry: baseSymmetry({ divisions: 6 }),
  });
  doc.addStroke({
    points: line({ x: CENTER.x - 250, y: CENTER.y }, { x: CENTER.x + 250, y: CENTER.y }),
    brush: { ...nib, color: '#b23a48', opacity: 0.5 },
    symmetry: baseSymmetry({ divisions: 6 }),
  });
  doc.addStroke({
    points: [{ x: CENTER.x, y: CENTER.y }],
    brush: { shape: 'round', size: 34, aspect: 1, skew: 0, tiltDeg: 0, opacity: 0.5, color: '#2b2d42' },
    symmetry: baseSymmetry({ divisions: 6 }),
  });
  doc.addStroke({
    points: line(
      { x: CENTER.x + 55, y: CENTER.y - 150 },
      { x: CENTER.x + 185, y: CENTER.y + 95 }
    ),
    brush: { ...nib, size: 16, skew: 1.25, tiltDeg: -12, opacity: 0.8, color: '#3d5a80' },
    symmetry: baseSymmetry({ divisions: 6 }),
  });
  return doc;
}

function cyclicMandala() {
  const doc = makeDocument('循环曼陀罗', '#f7f3ec');
  const brush = {
    shape: 'round',
    size: 10,
    aspect: 3.4,
    skew: 0,
    tiltDeg: 0,
    opacity: 0.62,
    color: '#540d6e',
  };
  doc.addStroke({
    points: arc(CENTER.x, CENTER.y, 230, 70, Math.PI, Math.PI * 1.9),
    brush,
    symmetry: {
      rule: 'cyclic',
      divisions: 9,
      axisAngle: 0,
      center: { ...CENTER },
      reflection: 'mirror',
      dedupePolicy: 'coverage-union',
    },
  });
  doc.addStroke({
    points: arc(CENTER.x, CENTER.y, 95, 95, -Math.PI, Math.PI),
    brush: { ...brush, shape: 'nib', size: 8, aspect: 2.2, skew: 0.55, opacity: 0.5, color: '#ee4266' },
    symmetry: {
      rule: 'cyclic',
      divisions: 9,
      axisAngle: 0,
      center: { ...CENTER },
      reflection: 'mirror',
      dedupePolicy: 'coverage-union',
    },
  });
  return doc;
}

function reflectionShowcase() {
  const doc = makeDocument('反射手性对照', '#ffffff');
  const brush = {
    shape: 'nib',
    size: 18,
    aspect: 3.6,
    skew: 1.4,
    tiltDeg: 30,
    opacity: 0.9,
    color: '#264653',
  };
  doc.addStroke({
    points: line({ x: CENTER.x + 40, y: CENTER.y - 60 }, { x: CENTER.x + 250, y: CENTER.y + 40 }),
    brush,
    symmetry: baseSymmetry({ divisions: 1, reflection: 'mirror' }),
  });
  doc.addStroke({
    points: line({ x: CENTER.x - 250, y: CENTER.y - 40 }, { x: CENTER.x - 40, y: CENTER.y + 60 }),
    brush: { ...brush, color: '#e76f51', skew: -1.4 },
    symmetry: baseSymmetry({ divisions: 1, reflection: 'preserve-hand' }),
  });
  return doc;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const documents = [
    ['flower', flower()],
    ['axis-stress', axisStress()],
    ['cyclic-mandala', cyclicMandala()],
    ['reflection-showcase', reflectionShowcase()],
  ];
  for (const [name, doc] of documents) {
    const json = doc.toJSON();
    const jsonPath = join(OUT_DIR, `${name}.json`);
    const pngPath = join(OUT_DIR, `${name}.png`);
    await writeFile(jsonPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
    await writeFile(pngPath, doc.toPNG());
    console.log(
      `${name}: ${doc.strokeCount} 笔, ${jsonPath.replace(process.cwd() + '/', '')} + PNG`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
