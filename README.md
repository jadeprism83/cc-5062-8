# 对称笔迹 · Symmetry Ink

一个由旋转群 / 反射群驱动的对称绘画引擎。原始笔画会被编译成一组对称实例，
**真实渲染到画布**并导出为 PNG；每个实例的笔尖方向、手性与颜色都随群变换
正确传播。仓库同时提供浏览器绘画窗口、可重放文档格式、命令行辅助工具与测试。

## 图形入口（主要入口）

```bash
npm install
npm start
# 打开 http://localhost:4173/
```

绘画窗口：

- 左栏：对称群（二面体 Dₙ / 循环 Cₙ）、旋转分区数、轴角度、反射语义、
  重叠覆盖政策，以及笔尖形状、尺寸、长宽比、斜切（手性）、倾斜、不透明度和颜色。
- 中间：画布。拖动即绘制；笔画按当前对称群生成全部关联实例。
- 右栏：结果区、实例与来源列表、轴向关系列表。
- 顶栏：撤销 / 重做 / 清空 / 重放自检 / 导出 PNG / 保存笔画 / 打开笔画。

## 设计要点

### 笔画冻结对称快照

每条笔画在落笔时把 `{rule, divisions, axisAngle, center, reflection, dedupePolicy}`
冻结进自身。之后调整“旋转分区数”或切换群，只影响**新笔画**；已落笔的笔画
始终按创建时的群渲染。这样作品与当前工具设置之间的关系是显式且稳定的，
改变分区数不会让先前笔画无解释地重新叠加。

### 群变换语义

坐标取画布像素坐标（y 轴向下），轴角从 +x 轴量起。

- 旋转 `R_k = R(2πk/n)`：位置绕中心旋转，笔尖方向 `θ → θ + 2πk/n`，
  手性 `skew` 保持不变。
- 反射 `F_φ`：位置镜像，笔尖方向 `θ → 2φ − θ`。
  - `reflection = "mirror"`：`skew → −skew`，得到严格几何镜像（手性翻转）。
  - `reflection = "preserve-hand"`：`skew` 不变，只镜像方向与位置（保留笔尖手性）。

笔尖局部形状关于长轴对称，因此 `(θ, skew)` 这组参数对旋转与反射封闭。
方向是否可按 π 周期折叠取决于笔尖对称性：

| 笔尖 | 方向语义 |
| --- | --- |
| `round` + `aspect=1` + `skew=0`（圆） | 各向同性，方向无关 |
| `round` + `skew=0`（未错切椭圆） | 关于长轴 180° 对称，θ 按 π 折叠 |
| `nib` 或任何 `skew≠0` | 笔尖有向，θ 按 2π 比较 |

### 两种去重办法

1. **按对称群轨道合并样本**（编译期）：`src/instance.js` 对每个采样点应用全部
   群元素，把姿态 `(位置, 笔尖方向, 手性)` 简并的桌面用一个带容差的全局哈希索引
   合并成一个实例，并记录它的全部来源元素。
2. **画布写入端只累计一次覆盖**（光栅期）：`src/raster.js` 为每条笔画建立
   4×4 子采样位掩码，同一笔画的所有实例通过位 OR 合并覆盖，最后对每个像素
   **只合成一次**。

两者叠加保证：对称轴/中心处多个变换落到同一点时，透明色不会重复加深。
判断重合使用与笔刷尺寸相关的几何容差（位置、方向、手性），**不是浮点坐标全等**，
因此对旋转带来的舍入误差稳健。

`dedupePolicy = "keep-all"` 可关闭编译期合并，用于对照“重复加深”的行为。

### 连续性渲染

同一群元素的相邻笔尖之间取凸包再栅格化，消除离散盖章在曲线外侧留下的
扇贝锯齿；凸包与等距变换可交换，所以仍在世界坐标完成。覆盖并集语义不变。

## 可重放文档

`保存笔画` 导出的 JSON 只包含原始笔画点、笔刷参数与冻结的对称快照，
不含任何编译产物。重放时重新编译，**逐字节复现相同的 PNG**。
格式版本见 `DOCUMENT_VERSION`。

```json
{
  "version": 1,
  "width": 900,
  "height": 640,
  "background": "#ffffff",
  "strokes": [
    {
      "id": "s1",
      "points": [{ "x": 450, "y": 110 }],
      "brush": { "shape": "nib", "size": 14, "aspect": 2.8, "skew": 0.62, "tiltDeg": 18, "opacity": 0.82, "color": "#1d3557" },
      "symmetry": { "rule": "dihedral", "divisions": 6, "axisAngle": 0, "center": { "x": 450, "y": 320 }, "reflection": "mirror", "dedupePolicy": "coverage-union" },
      "dedupePolicy": "coverage-union"
    }
  ]
}
```

## 示例作品

`samples/` 中提供确定性生成的示例，既是作品也是测试场景：

| 文件 | 场景 |
| --- | --- |
| `flower.png / .json` | D6 + 轴偏移 D6，含中心圆点 |
| `axis-stress.png / .json` | 中心点、沿对称轴往返长线、斜向非对称笔尖 |
| `cyclic-mandala.png / .json` | C9 纯旋转曼陀罗 |
| `reflection-showcase.png / .json` | 严格镜像 vs 保留手性的对照 |

重新生成：`npm run samples`。

## 命令行（仅辅助对称笔迹）

命令行只用于渲染/检查由图形界面保存的笔画数据，不提供独立绘画能力：

```bash
node cli.js render samples/flower.json --out out.png
node cli.js inspect samples/axis-stress.json
node cli.js inspect samples/axis-stress.json --json
```

- `render` 用引擎真实渲染 PNG（不是截图）。
- `inspect` 打印每笔的群、采样数、写入数、合并简并副本数与实例来源。

## 测试

```bash
npm test          # Node 单元测试：群论、轨道去重、像素对称性、覆盖、重放、PNG
npm run test:ui   # Playwright 端到端：真实指针绘制、切换规则、导出、重放
```

单元测试覆盖：

- 群复合封闭、反射自逆、轴数随分区数变化、轴角归一化；
- 中心圆点合并为一次覆盖、椭圆方向按 π 折叠、尖笔 12 方向保留；
- 轴向长线中点只着色一次（覆盖并集）、`keep-all` 对照确实更深；
- D4 结果的 x/y 像素级对称、反射模式逐像素镜像；
- 保存 JSON 重放到 PNG 逐字节一致；分区数变化不回溯改写历史笔画。

## 目录

```
index.html        绘画窗口
styles.css        界面样式
server.js         静态服务器（npm start）
src/group.js      旋转 / 反射群、轴角归一化
src/brush.js      笔尖多边形与采样
src/instance.js   对称快照、轨道合并、反射/手性语义
src/raster.js     子采样覆盖并集、凸包扫掠、像素合成
src/png.js        PNG 编码（Node 用 zlib）
src/document.js   可重放文档、渲染与序列化
src/ui/main.js    浏览器交互与来源可视化
cli.js            辅助 CLI
scripts/          示例生成
test/             单元测试与端到端测试
```
