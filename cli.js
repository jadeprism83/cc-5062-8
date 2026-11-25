#!/usr/bin/env node
/**
 * 命令行仅用于辅助对称笔迹：可把可重放 JSON 渲染成 PNG，或输出
 * 一份带回放统计的报告。图形入口见 README 与 `npm start`。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

import { SketchDocument, DOCUMENT_VERSION } from './src/document.js';
import { instanceProvenance } from './src/instance.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

const USAGE = `对称笔迹命令行（辅助工具）

用法:
  node cli.js render <input.json> [--out <output.png>] [--width N] [--height N] [--background <#rrggbb|transparent>]
  node cli.js inspect <input.json> [--json]
  node cli.js version

说明:
  图形绘画入口: npm start，然后打开 http://localhost:4173/
  render  把可重放笔画数据真实渲染为 PNG（不是截图）
  inspect 打印笔画、实例来源与覆盖去重统计
`;

async function loadDocument(path) {
  const text = await readFile(path, 'utf8');
  const raw = JSON.parse(text);
  return { raw, doc: SketchDocument.fromJSON(raw) };
}

async function commandRender(args) {
  const input = args._[1];
  if (!input) throw new Error('render 需要输入 JSON 路径');
  const { doc } = await loadDocument(input);
  const width = args.width ? Number(args.width) : doc.width;
  const height = args.height ? Number(args.height) : doc.height;
  const background = args.background ?? doc.background;
  const png = doc.toPNG({ width, height, background });
  const out = args.out ?? join(dirname(input), `${basename(input, extname(input))}.png`);
  await writeFile(out, png);
  console.log(`已渲染 ${doc.strokeCount} 笔 → ${out} (${width}×${height}, ${png.length} 字节)`);
}

async function commandInspect(args) {
  const input = args._[1];
  if (!input) throw new Error('inspect 需要输入 JSON 路径');
  const { doc } = await loadDocument(input);
  const report = {
    version: DOCUMENT_VERSION,
    title: doc.title,
    size: { width: doc.width, height: doc.height },
    strokes: doc.strokes.map((stroke) => {
      const compiled = doc.getCompiled(stroke.id);
      return {
        id: stroke.id,
        points: stroke.points.length,
        brush: stroke.brush,
        symmetry: stroke.symmetry,
        provenance: instanceProvenance(compiled),
      };
    }),
  };
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`${report.title} — ${report.size.width}×${report.size.height}`);
  for (const stroke of report.strokes) {
    const p = stroke.provenance;
    console.log(
      `\n${stroke.id}: ${stroke.points} 个点, ${p.group}（${p.order} 变换）, ` +
        `反射=${p.reflection}, 覆盖=${p.dedupePolicy}`
    );
    console.log(`  采样 ${p.sampleCount} → 写入 ${p.writeCount}，合并简并副本 ${p.mergedSamples}`);
    const kinds = p.attribution.reduce((acc, entry) => {
      acc[entry.elementKind] = (acc[entry.elementKind] ?? 0) + entry.stampCount;
      return acc;
    }, {});
    console.log(
      `  实例来源: ${p.instances.length} 个元素` +
        Object.entries(kinds)
          .map(([kind, count]) => `, ${kind === 'reflection' ? '反射' : '旋转'} ${count} 覆盖`)
          .join('')
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  try {
    if (!command || command === 'help' || args.help) {
      console.log(USAGE);
      return;
    }
    if (command === 'version') {
      console.log(`symmetry-ink document v${DOCUMENT_VERSION}`);
      return;
    }
    if (command === 'render') {
      await commandRender(args);
      return;
    }
    if (command === 'inspect') {
      await commandInspect(args);
      return;
    }
    throw new Error(`未知命令: ${command}`);
  } catch (error) {
    console.error(`错误: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
