import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { readInitialTheme } from "./initial-theme.ts";

describe("readInitialTheme", () => {
  it("正常：--orbita-theme= 前缀 + 合法值原样解出", () => {
    strictEqual(readInitialTheme(["/path/to/electron", "--orbita-theme=dark"]), "dark");
    strictEqual(readInitialTheme(["--orbita-theme=system"]), "system");
  });

  it("缺参数回 null——手改坏的 argv 不该让渲染层拿到半截值", () => {
    strictEqual(readInitialTheme([]), null);
    strictEqual(readInitialTheme(["/path/to/electron", "--inspect"]), null);
  });

  it("非法值回 null——不在 THEME_PREFERENCES 里的值一律当没读到", () => {
    strictEqual(readInitialTheme(["--orbita-theme=purple"]), null);
    strictEqual(readInitialTheme(["--orbita-theme="]), null);
  });

  it("多个 --orbita-theme= 只取第一个", () => {
    strictEqual(readInitialTheme(["--orbita-theme=light", "--orbita-theme=black"]), "light");
  });
});
