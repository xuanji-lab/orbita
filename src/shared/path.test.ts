import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { pathTail, pathWithin } from "./path.ts";

describe("pathTail", () => {
  it("两种分隔符都取末段（不同系统、原生与混形都在内）", () => {
    strictEqual(pathTail("/ws/src/a.ts"), "a.ts");
    strictEqual(pathTail("C:\\Users\\me\\repo\\orbita"), "orbita");
    strictEqual(pathTail("C:\\Orbita/src\\a.ts"), "a.ts"); // 原生根 + 渲染端 / 的混形
    strictEqual(pathTail("a.ts"), "a.ts");
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
