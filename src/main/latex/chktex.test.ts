/**
 * chktex 输出的账：格式解析、行号 / 严重级、项目相对路径、坏行 / 项目外文件跳过。
 * 夹具是从真 chktex 1.7.9 抓的输出（`%m` 行尾的换行由 chktex 自己生成）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { lintWithChktex, parseChktexOutput, probeChktex } from "./chktex.ts";

const projectDir = resolve("C:/paper");

describe("parseChktexOutput", () => {
  test("file:line:col:length:Warning:code:message → LatexIssue", () => {
    const stdout = [
      "sections/intro.tex:3:7:1:Warning:18:Use either `` or '' as an alternative to `\"'.",
      "main.tex:12:1:8:Error:1:Command terminated with space.",
    ].join("\n");
    assert.deepEqual(parseChktexOutput(stdout, projectDir), [
      {
        file: "sections/intro.tex",
        line: 3,
        kind: "warning",
        message: "chktex 18: Use either `` or '' as an alternative to `\"'.",
      },
      { file: "main.tex", line: 12, kind: "error", message: "chktex 1: Command terminated with space." },
    ]);
  });

  test("Windows 绝对路径转成项目相对路径（正斜杠）；项目外的如实给绝对路径", () => {
    const inside = join(projectDir, "chapters", "two.tex");
    const outside = resolve("C:/other/x.tex");
    const stdout = [
      `${inside}:5:2:1:Warning:3:Some warning.`,
      `${outside}:1:1:1:Warning:4:Other file.`,
    ].join("\n");
    const issues = parseChktexOutput(stdout, projectDir);
    assert.equal(issues[0]?.file, "chapters/two.tex");
    assert.equal(issues[1]?.file, outside.replace(/\\/g, "/"));
  });

  test("坏行 / 空消息 / 重复行跳过", () => {
    const stdout = [
      "not a chktex line",
      "main.tex:0:1:1:Warning:1:zero line",
      "main.tex:4:1:1:Warning:2:",
      "main.tex:6:2:1:Warning:9:same message",
      "main.tex:6:2:1:Warning:9:same message",
    ].join("\n");
    assert.deepEqual(parseChktexOutput(stdout, projectDir), [
      { file: "main.tex", line: 6, kind: "warning", message: "chktex 9: same message" },
    ]);
  });

  test("空输出 = 没有警告", () => {
    assert.deepEqual(parseChktexOutput("", projectDir), []);
  });
});

describe("lintWithChktex（本机装了 chktex 才跑）", () => {
  test("真文件里的一句直引号会被查出来", async () => {
    const binary = await probeChktex(null);
    if (binary === null) {
      // 没装 chktex 的机器：这个功能本来就「不存在」，跳过而不是失败
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "orbita-chktex-"));
    try {
      const file = join(dir, "main.tex");
      writeFileSync(file, '\documentclass{article}\n\begin{document}\nHe said "hello".\n\end{document}\n');
      const result = await lintWithChktex({ binary, file, projectDir: dir });
      assert.equal(result.ok, true);
      assert.ok(result.issues.some((issue) => issue.file === "main.tex" && issue.line === 3));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
