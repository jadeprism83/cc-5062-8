import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:4173/';

async function openApp(page) {
  const problems = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(msg.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
  return problems;
}

/** 用真实指针事件画一条笔画；坐标是 900×640 文档空间。 */
async function drawStroke(page, points) {
  const box = await page.locator('#canvas-wrap').boundingBox();
  const view = await page.evaluate(() => {
    const v = window.__symmetryInk.state.view;
    return { scale: v.scale, offsetX: v.offsetX, offsetY: v.offsetY };
  });
  const client = (point) => ({
    x: box.x + view.offsetX + point.x * view.scale,
    y: box.y + view.offsetY + point.y * view.scale,
  });
  const first = client(points[0]);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (let i = 1; i < points.length; i += 1) {
    const next = client(points[i]);
    await page.mouse.move(next.x, next.y, { steps: 2 });
  }
  await page.mouse.up();
}

function arc(cx, cy, rx, ry, start, end, steps = 30) {
  const output = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const angle = start + (end - start) * t;
    output.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
  }
  return output;
}

test('页面加载无控制台错误，初始为 D6', async ({ page }) => {
  const problems = await openApp(page);
  expect(problems).toEqual([]);
  await expect(page.locator('#stat-group')).toHaveText('D6 · 12 变换');
  await expect(page.locator('#stat-strokes')).toHaveText('0');
});

test('真实绘制一笔生成 12 个对称实例，结果区与列表同步', async ({ page }) => {
  await openApp(page);
  await drawStroke(page, arc(450, 320, 200, 110, -Math.PI * 0.7, Math.PI * 0.2));
  await expect(page.locator('#stat-strokes')).toHaveText('1');
  const info = await page.evaluate(() => {
    const selected = window.__symmetryInk.getSelected();
    return {
      id: selected.stroke.id,
      instances: selected.instances.length,
      kinds: [...new Set(selected.instances.map((i) => i.elementKind))].sort(),
      status: document.getElementById('draw-status').textContent,
      rows: document.querySelectorAll('.instance-row').length,
    };
  });
  expect(info.id).toBe('s1');
  expect(info.instances).toBe(12);
  expect(info.kinds).toEqual(['reflection', 'rotation']);
  expect(info.rows).toBe(12);
  expect(info.status).toContain('12 实例');

  // 结果区真的画上了东西（不是空白）。
  const resultHasInk = await page.evaluate(() => {
    const canvas = document.getElementById('result-canvas');
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) ink += 1;
    }
    return ink;
  });
  expect(resultHasInk).toBeGreaterThan(2000);
});

test('切换对称规则后，新笔画使用新群，旧笔画保持不变', async ({ page }) => {
  await openApp(page);
  await drawStroke(page, arc(450, 320, 180, 90, -Math.PI * 0.6, Math.PI * 0.1));
  const firstCount = await page.evaluate(() => window.__symmetryInk.getSelected().instances.length);

  await page.click('[data-rule="cyclic"]');
  await page.fill('#divisions', '5');
  await page.dispatchEvent('#divisions', 'input');
  await expect(page.locator('#stat-group')).toHaveText('C5 · 5 变换');

  await drawStroke(page, arc(380, 280, 120, 80, Math.PI * 0.2, Math.PI * 0.9));
  const info = await page.evaluate(() => {
    const doc = window.__symmetryInk.getDoc();
    const history = doc.strokes.map((stroke) => ({
      id: stroke.id,
      rule: stroke.symmetry.rule,
      divisions: stroke.symmetry.divisions,
      instances: doc.getCompiled(stroke.id).instances.length,
    }));
    return { history, selected: window.__symmetryInk.getSelected().stroke.id };
  });
  expect(firstCount).toBe(12);
  expect(info.history[0].rule).toBe('dihedral');
  expect(info.history[0].divisions).toBe(6);
  expect(info.history[0].instances).toBe(12);
  expect(info.history[1].rule).toBe('cyclic');
  expect(info.history[1].divisions).toBe(5);
  expect(info.history[1].instances).toBe(5);
});

test('改变旋转分区数不会让先前笔画重新叠加', async ({ page }) => {
  await openApp(page);
  await drawStroke(page, [{ x: 450, y: 210 }, { x: 470, y: 230 }, { x: 500, y: 260 }]);
  const before = await page.evaluate(() => window.__symmetryInk.encodeCurrentPNG().length);
  const digestBefore = await page.evaluate(() => {
    const png = window.__symmetryInk.encodeCurrentPNG();
    let hash = 2166136261;
    for (let i = 0; i < png.length; i += 1) {
      hash ^= png[i];
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  });

  await page.click('[data-rule="dihedral"]');
  await page.fill('#divisions', '12');
  await page.dispatchEvent('#divisions', 'input');
  await page.waitForTimeout(150);

  const after = await page.evaluate(() => window.__symmetryInk.encodeCurrentPNG().length);
  const digestAfter = await page.evaluate(() => {
    const png = window.__symmetryInk.encodeCurrentPNG();
    let hash = 2166136261;
    for (let i = 0; i < png.length; i += 1) {
      hash ^= png[i];
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  });
  expect(after).toBe(before);
  expect(digestAfter).toBe(digestBefore);
});

test('撤销 / 重做恢复笔画', async ({ page }) => {
  await openApp(page);
  await drawStroke(page, [{ x: 420, y: 260 }, { x: 480, y: 300 }]);
  await expect(page.locator('#stat-strokes')).toHaveText('1');
  await page.click('#undo');
  await expect(page.locator('#stat-strokes')).toHaveText('0');
  await page.click('#redo');
  await expect(page.locator('#stat-strokes')).toHaveText('1');
});

test('重放自检报告逐字节一致', async ({ page }) => {
  await openApp(page);
  await drawStroke(page, arc(450, 320, 170, 100, Math.PI * 0.1, Math.PI * 0.8));
  await page.click('#replay-check');
  await expect(page.locator('#toast')).toContainText('重放一致');
});

test('导出 PNG 得到真实图片而非画布截图', async ({ page }) => {
  await openApp(page);
  await drawStroke(page, arc(430, 300, 150, 90, -Math.PI * 0.5, Math.PI * 0.4));
  const downloadPromise = page.waitForEvent('download');
  await page.click('#export-png');
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  expect(buffer.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  // 尺寸来自文档模型 900×640，而非当前显示器截图尺寸。
  expect(buffer.readUInt32BE(16)).toBe(900);
  expect(buffer.readUInt32BE(20)).toBe(640);
  expect(buffer.length).toBeGreaterThan(1000);
});

test('来源着色开关与实例列表展示群元素来源', async ({ page }) => {
  await openApp(page);
  await drawStroke(page, arc(450, 330, 160, 80, -Math.PI * 0.3, Math.PI * 0.5));
  await page.check('#toggle-provenance');
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll('.instance-row .instance-id')].map((el) => el.textContent)
  );
  expect(ids.length).toBe(12);
  expect(ids[0]).toBe('R0');
  expect(ids).toContain('S0');
});

test('点击画布设置对称中心后，轴线随之移动', async ({ page }) => {
  await openApp(page);
  await page.click('#set-center');
  const box = await page.locator('#canvas-wrap').boundingBox();
  const view = await page.evaluate(() => {
    const v = window.__symmetryInk.state.view;
    return { scale: v.scale, offsetX: v.offsetX, offsetY: v.offsetY };
  });
  const target = { x: 300, y: 200 };
  await page.mouse.click(
    box.x + view.offsetX + target.x * view.scale,
    box.y + view.offsetY + target.y * view.scale
  );
  const center = await page.evaluate(() => window.__symmetryInk.getCenter());
  expect(Math.abs(center.x - target.x)).toBeLessThan(3);
  expect(Math.abs(center.y - target.y)).toBeLessThan(3);
  await expect(page.locator('#center-readout')).not.toHaveText('450, 320');
});

test('保存的笔画 JSON 可重新打开并渲染出相同像素', async ({ page, browser }) => {
  await openApp(page);
  await drawStroke(page, arc(440, 310, 140, 90, -Math.PI * 0.4, Math.PI * 0.6));
  const saved = await page.evaluate(() => {
    const json = window.__symmetryInk.docToJSON();
    const doc = window.__symmetryInk.getDoc();
    const png = Array.from(window.__symmetryInk.encodeCurrentPNG());
    return { json, png };
  });

  const page2 = await browser.newPage();
  await page2.goto(BASE, { waitUntil: 'networkidle' });
  await page2.waitForFunction(() => document.documentElement.dataset.ready === 'true');
  const replayed = await page2.evaluate((payload) => {
    const original = payload.json;
    window.__symmetryInk.state.doc = window.__symmetryInk.state.doc.constructor.fromJSON(original);
    const png = Array.from(window.__symmetryInk.encodeCurrentPNG());
    return { count: window.__symmetryInk.getDoc().strokeCount, png };
  }, saved);
  expect(replayed.count).toBe(1);
  expect(replayed.png).toEqual(saved.png);
  await page2.close();
});

test('历史面板按原始笔事件撤销：只移除该笔自身副本，同色交叉笔画保持原位', async ({ page }) => {
  await openApp(page);
  const center = { x: 450, y: 320 };
  const sameColor = '#222222';

  // 先前的同色交叉笔画（水平）。
  await page.evaluate(({ center, sameColor }) => {
    const api = window.__symmetryInk;
    api.setTool({ color: sameColor, opacity: 0.6 });
    api.addStrokeProgrammatically(
      [
        { x: center.x - 120, y: center.y },
        { x: center.x + 120, y: center.y },
      ],
      { eventId: 'evt-cross' }
    );
  }, { center, sameColor });
  const crossPng = await page.evaluate(() => Array.from(window.__symmetryInk.encodeCurrentPNG()));

  // 轴上落笔（竖直，同色）。
  await page.evaluate(({ center, sameColor }) => {
    window.__symmetryInk.addStrokeProgrammatically(
      [
        { x: center.x, y: center.y - 120 },
        { x: center.x, y: center.y + 120 },
      ],
      { eventId: 'evt-axis', brush: { color: sameColor } }
    );
  }, { center, sameColor });
  await expect(page.locator('#stat-strokes')).toHaveText('2');

  // 历史面板出现两个笔事件条目，各带一个“撤”按钮。
  const undoButtons = page.locator('.stroke-item .stroke-undo');
  await expect(undoButtons).toHaveCount(2);

  // 点击轴上笔事件那一行的“撤”。
  const axisRow = page.locator('.stroke-item', { hasText: 'evt-axis' });
  await axisRow.locator('.stroke-undo').click();
  await expect(page.locator('#stat-strokes')).toHaveText('1');

  // 画布回到只有交叉笔画时的像素。
  const restoredPng = await page.evaluate(() => Array.from(window.__symmetryInk.encodeCurrentPNG()));
  expect(restoredPng).toEqual(crossPng);

  // 留下的仍是交叉笔事件，轴上笔事件已消失。
  const remaining = await page.evaluate(() =>
    window.__symmetryInk.getDoc().strokes.map((s) => s.eventId)
  );
  expect(remaining).toEqual(['evt-cross']);
  // 顶栏重做可恢复被撤的笔事件。
  await page.click('#redo');
  await expect(page.locator('#stat-strokes')).toHaveText('2');
});

test('每段笔迹暴露轨道与稳定身份，轴上简并实例记录全部来源元素', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    window.__symmetryInk.addStrokeProgrammatically(
      [{ x: 450, y: 320 }],
      {
        eventId: 'evt-center-dot',
        brush: { shape: 'round', size: 18, aspect: 1, skew: 0, tiltDeg: 0, opacity: 0.5, color: '#ff0000' },
        symmetry: { rule: 'dihedral', divisions: 6 },
      }
    );
  });
  const identity = await page.evaluate(() =>
    window.__symmetryInk.getStrokeIdentity(window.__symmetryInk.getDoc().strokes[0].id)
  );
  expect(identity.eventId).toBe('evt-center-dot');
  expect(identity.instanceCount).toBe(1);
  expect(identity.degenerateCount).toBe(1);
  expect(identity.degenerateInstances[0].sourceElementIds).toHaveLength(12);
  expect(identity.writeCount + identity.mergedSamples).toBe(identity.sampleCount * identity.groupOrder);
});

test('对称笔迹运行状态可见：正常去重无异常，keep-all 给提示级标记', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    const api = window.__symmetryInk;
    api.addStrokeProgrammatically([{ x: 450, y: 320 }], {
      eventId: 'evt-ok',
      brush: { shape: 'round', size: 16, aspect: 1, skew: 0, tiltDeg: 0, opacity: 0.5, color: '#ff0000' },
    });
  });
  const healthy = await page.evaluate(() => window.__symmetryInk.getSymmetryDiagnostics());
  expect(healthy.healthy).toBe(true);
  expect(healthy.anomalies).toEqual([]);
  await expect(page.locator('#diagnostic-status')).toContainText('对称笔迹正常');

  await page.evaluate(() => {
    window.__symmetryInk.addStrokeProgrammatically([{ x: 400, y: 300 }], {
      eventId: 'evt-keep',
      dedupePolicy: 'keep-all',
    });
  });
  const warned = await page.evaluate(() => window.__symmetryInk.getSymmetryDiagnostics());
  expect(warned.healthy).toBe(true); // 仅 warning，不算错误
  expect(warned.anomalies).toHaveLength(1);
  expect(warned.anomalies[0].level).toBe('warning');
  await expect(page.locator('#diagnostic-status')).toContainText('keep-all');
});

test('切换对称规则并绘制，轴向关系与实例来自所选笔画冻结的修补后计算', async ({ page }) => {
  await openApp(page);
  // D6 落笔。
  await drawStroke(page, arc(450, 320, 180, 90, -Math.PI * 0.6, Math.PI * 0.1));
  const dihedralInfo = await page.evaluate(() => {
    const compiled = window.__symmetryInk.getSelected();
    return {
      rule: compiled.group.rule,
      instances: compiled.instances.length,
      mirrorAxes: compiled.group.mirrorAxes.length,
      eventId: compiled.stroke.eventId,
    };
  });
  expect(dihedralInfo.rule).toBe('dihedral');
  expect(dihedralInfo.instances).toBe(12);
  expect(dihedralInfo.mirrorAxes).toBe(6);
  expect(typeof dihedralInfo.eventId).toBe('string');

  // 切到 C5 再落笔。
  await page.click('[data-rule="cyclic"]');
  await page.fill('#divisions', '5');
  await page.dispatchEvent('#divisions', 'input');
  await drawStroke(page, arc(380, 280, 120, 80, Math.PI * 0.2, Math.PI * 0.9));
  const cyclicInfo = await page.evaluate(() => {
    const compiled = window.__symmetryInk.getSelected();
    return {
      rule: compiled.group.rule,
      instances: compiled.instances.length,
      mirrorAxes: compiled.group.mirrorAxes.length,
      rotationRays: compiled.group.rotationRays.length,
    };
  });
  expect(cyclicInfo.rule).toBe('cyclic');
  expect(cyclicInfo.instances).toBe(5);
  expect(cyclicInfo.mirrorAxes).toBe(0);
  expect(cyclicInfo.rotationRays).toBe(5);

  // 轴向关系列表随所选笔画的冻结群快照变化。
  await expect(page.locator('#axis-list .axis-row')).toHaveCount(5);

  // 重新选中第一条 D6 笔画，轴向关系回到 6 条镜线。
  await page.locator('.stroke-item', { hasText: 's1' }).click();
  await expect(page.locator('#axis-list .axis-row')).toHaveCount(6);
});
