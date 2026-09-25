import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { readInitialLanguage, readInitialTheme } from "./initial-theme.ts";

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

describe("readInitialLanguage", () => {
  it("合法值原样解出；缺参数、非法值、空值回 null；多个只取第一个", () => {
    strictEqual(readInitialLanguage(["/electron", "--orbita-theme=light", "--orbita-language=zh"]), "zh");
    strictEqual(readInitialLanguage(["--orbita-theme=light"]), null);
    strictEqual(readInitialLanguage(["--orbita-language=fr"]), null);
    strictEqual(readInitialLanguage(["--orbita-language="]), null);
    strictEqual(readInitialLanguage(["--orbita-language=en", "--orbita-language=zh"]), "en");
  });
});
