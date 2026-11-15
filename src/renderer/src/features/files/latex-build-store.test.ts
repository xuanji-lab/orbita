/**
 * 编译结局的寄存（2026-11-15 验收 P0-4）：按项目目录存，切标签 / 卸载面板不丢。
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { clearBuildStore, recallBuild, rememberBuild, type LatexBuildSummary } from "./latex-build-store.ts";

const summary = (status: LatexBuildSummary["status"], errors: number): LatexBuildSummary => ({
  status,
  pages: status === "ok" ? 3 : null,
  durationMs: 400,
  errors: Array.from({ length: errors }, (_, index) => ({
    message: `错误 ${index}`,
    file: "main.tex" as string | null,
    line: index + 1 as number | null,
    kind: "error" as const,
  })),
  warnings: [],
  pdfPath: "/p/build/main.pdf",
  finishedAt: 1,
});

describe("latex build store", () => {
  beforeEach(() => clearBuildStore());

  it("没编过的项目是 null（不是空摘要）", () => {
    assert.equal(recallBuild("/p/paper"), null);
  });

  it("同一个项目的新一轮覆盖旧的", () => {
    rememberBuild("/p/paper", summary("compile-error", 3));
    rememberBuild("/p/paper", summary("ok", 0));
    assert.equal(recallBuild("/p/paper")?.status, "ok");
  });

  it("不同项目各存各的：切走再切回来拿到的是自己那一份", () => {
    rememberBuild("/p/paper", summary("compile-error", 3));
    rememberBuild("/p/other", summary("ok", 0));
    assert.equal(recallBuild("/p/paper")?.errors.length, 3);
    assert.equal(recallBuild("/p/other")?.errors.length, 0);
  });
});
