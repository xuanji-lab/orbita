import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTheme } from "./theme-resolve.ts";

describe("resolveTheme", () => {
  it("system 深色落 black（Ink，2026-09-03 用户指定）", () => {
    strictEqual(resolveTheme("system", true), "black");
  });

  it("system 浅色落 light", () => {
    strictEqual(resolveTheme("system", false), "light");
  });

  it("light 原样透传，不受 prefersDark 影响——手动档顶掉系统色", () => {
    strictEqual(resolveTheme("light", true), "light");
    strictEqual(resolveTheme("light", false), "light");
  });

  it("dark 原样透传，不受 prefersDark 影响", () => {
    strictEqual(resolveTheme("dark", true), "dark");
    strictEqual(resolveTheme("dark", false), "dark");
  });

  it("black 原样透传，不受 prefersDark 影响", () => {
    strictEqual(resolveTheme("black", true), "black");
    strictEqual(resolveTheme("black", false), "black");
  });

  it("稿纸两档原样透传：只有明，系统深色也不换", () => {
    strictEqual(resolveTheme("manuscript", true), "manuscript");
    strictEqual(resolveTheme("typescript", true), "typescript");
  });
});
