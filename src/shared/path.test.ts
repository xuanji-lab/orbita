import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { looksLikeWindowsPath, pathTail, pathWithin } from "./path.ts";

describe("looksLikeWindowsPath", () => {
  it("盘符后不跟分隔符也算——`C:proj` 是盘符相对路径", () => {
    strictEqual(looksLikeWindowsPath("C:proj"), true);
    strictEqual(looksLikeWindowsPath("c:/Users/x"), true);
  });

  it("反斜杠起头：UNC、设备命名空间、当前盘根相对", () => {
    strictEqual(looksLikeWindowsPath("\\\\server\\share"), true);
    strictEqual(looksLikeWindowsPath("\\\\?\\C:\\x"), true);
    strictEqual(looksLikeWindowsPath("\\Users\\dama\\proj"), true);
  });

  // 这一条是 macOS 上的真事：`my\folder` 是一个文件夹名，不是一个目录层级
  it("POSIX 形不认——`\\` 只在这时候才当分隔符", () => {
    strictEqual(looksLikeWindowsPath("/Users/x/my\\folder"), false);
    strictEqual(looksLikeWindowsPath("/home/u/proj"), false);
    strictEqual(looksLikeWindowsPath("my\\folder"), false);
  });
});

describe("pathTail", () => {
  it("Windows 形两种分隔符都取末段（原生与混形都在内）", () => {
    strictEqual(pathTail("/ws/src/a.ts"), "a.ts");
    strictEqual(pathTail("C:\\Users\\me\\repo\\orbita"), "orbita");
    strictEqual(pathTail("C:\\Orbita/src\\a.ts"), "a.ts"); // 原生根 + 渲染端 / 的混形
    strictEqual(pathTail("a.ts"), "a.ts");
  });

  // POSIX 形只切 `/`：`\` 在这里是一个文件夹名的合法字符（Mac 上的真目录）。
  // 这一条曾与「无条件双切」的旧 pathTail 相反——两条规则在 #106 里合成「按形切」
  it("POSIX 形不切 `\\`——`my\\folder` 是一个名字，不是一层目录", () => {
    strictEqual(pathTail("/Users/x/my\\folder"), "my\\folder");
  });

  it("全是分隔符或空 → 空串（回退交给调用方，不给空名）", () => {
    strictEqual(pathTail("/"), "");
    strictEqual(pathTail(""), "");
  });
});

describe("pathWithin", () => {
  it("自身、正斜杠子孙、反斜杠子孙、混形子孙都算在内", () => {
    strictEqual(pathWithin("/ws", "/ws"), true);
    strictEqual(pathWithin("/ws", "/ws/src"), true);
    strictEqual(pathWithin("C:\\Orbita", "C:\\Orbita\\src"), true);
    strictEqual(pathWithin("C:\\Orbita", "C:\\Orbita/src"), true); // 原生父 + 渲染端子
  });
  it("按路径段判：前缀相同但不在段边界上不算", () => {
    strictEqual(pathWithin("/ws", "/wsfavorite"), false);
    strictEqual(pathWithin("/home/a", "/home/ab"), false);
    strictEqual(pathWithin("C:\\Orbita", "C:\\Orbita-dev"), false);
    strictEqual(pathWithin("/ws", "/other/ws"), false);
  });
});
