/**
 * 构建 PDF 阅读器的桥脚本与样式到 out/reader-host/（主进程把它们插进阅读器页面，见 src/main/pdf-reader/respond.ts）。
 * `bun run dev` / `bun run build` 前自动跑；改了 src/reader-host/ 之后单独跑 `bun scripts/build-reader-host.mjs`
 * 再在窗口里重开 PDF 即可（它不在 electron-vite 的 HMR 里）。
 *
 * 用 bun 自带的打包（Bun.build），不加依赖：桥脚本是浏览器里的一个独立 IIFE，只 import shared 里的纯模块。
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "out", "reader-host");
mkdirSync(outDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "src", "reader-host", "host.ts")],
  target: "browser",
  format: "iife",
  minify: false,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const output = result.outputs[0];
if (output === undefined) throw new Error("Bun.build 没有产出");
await Bun.write(join(outDir, "orbita-host.js"), output);
copyFileSync(join(root, "src", "reader-host", "host.css"), join(outDir, "orbita-host.css"));
console.log(`✓ 阅读器桥脚本 → ${outDir}`);
