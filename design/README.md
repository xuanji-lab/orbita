# Orbita 设计资产（design/）

> 设计语言规范见 **`Orbita Design System/readme.md`**（单一真源，2026-08-23 交接；
> 原 `docs/orbita-design.md` 已降为转发 stub）。
> 本目录只存**源资产**（字体源文件、图标源、logo 源）；应用运行时用到的字体仍打包在
> `orbita-desktop/src/renderer/src/assets/`。
>
> **本目录是资产真源，方向单向**：`Orbita Design System/assets/` 只是按需拷出的工作子集
> （46 枚图标 vs 本目录 2,034 枚；4 个字体文件 vs 本目录 5 个——缺 `SourceHanSansSC-Medium.otf`）。
> 需要新图标/字重时从这里复制过去，**不要反向同步**，也不要以设计系统的 `assets/` 为准做取舍。

## fonts/ 字体清单

| 目录 | 字体 | 用途 | 授权状态 |
| --- | --- | --- | --- |
| `cjk-serif/` | Source Han Serif SC Medium（思源宋体 SC） | 中文标题 / slogan | ✅ SIL OFL 1.1 开源，已入库（`OFL.txt`） |
| `cjk-sans/` | Source Han Sans SC Regular + Medium（思源黑体 SC） | 中文界面 UI | ✅ SIL OFL 1.1 开源，已入库 |
| `western-display/` | Literata（可变体：opsz + wght，含 Italic） | 英文标题 / slogan | ✅ SIL OFL 1.1 开源（Google Fonts），已入库 |
| `western-ui/` | Manrope（可变体：wght） | 英文界面 UI | ✅ SIL OFL 1.1 开源（Google Fonts），已入库 |

全部开源无授权障碍。**2026-08-23 已接入应用**（R9-09）：转 woff2 打包，CJK 按用途分别子集化，派生产物在 `orbita-desktop/src/renderer/src/assets/fonts/`（合计 7.03 MB）——思源宋体只服务界面文案故按应用 zhCN 字符集子集化（171 KB），思源黑体要渲染用户内容故取 CJK 全块（3.3 MB/字重）。本目录仍是**字体源的真源**，派生产物由它生成。
（2026-08-22：原商业字体方案 Galaxie Copernicus / Styrene A 以此平替作废。）

## icons/ 图标

- `icons/lucide/`：lucide 开源图标库静态 SVG 全集（2034 枚，ISC License，`lucide-static@1.33.0`）。
  运行时 UI 用 `lucide-react`（npm 依赖）；本目录是设计/Figma 用的源文件副本。
- 文件/文件夹类型图标（未来文件树）：@react-symbols/icons，待右栏文件系统 slice 引入（调研结论见 design.md §1）。

## logos/

品牌 logo 尚未定稿——此目录留空占位。定稿后放：SVG 源 + PNG 导出 + 使用规范。
