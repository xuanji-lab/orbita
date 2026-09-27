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

  it("graphite 原样透传，不受 prefersDark 影响", () => {
    strictEqual(resolveTheme("graphite", true), "graphite");
    strictEqual(resolveTheme("graphite", false), "graphite");
  });

  it("black 原样透传，不受 prefersDark 影响", () => {
    strictEqual(resolveTheme("black", true), "black");
    strictEqual(resolveTheme("black", false), "black");
  });

  it("纸面两档原样透传：只有明，系统深色也不换", () => {
    strictEqual(resolveTheme("copybook", true), "copybook");
    strictEqual(resolveTheme("typescript", true), "typescript");
  });
});
