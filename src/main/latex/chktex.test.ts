/**
 * chktex 输出的账：格式解析、行号 / 严重级、项目相对路径、坏行 / 项目外文件跳过。
 * 夹具是从真 chktex 1.7.9 抓的输出（`%m` 行尾的换行由 chktex 自己生成）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { lintWithChktex, chktexCwd, parseChktexOutput, probeChktex } from "./chktex.ts";

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
        // chktex 是三个证据源里唯一给列号的（match[3] 以前被丢掉）
        column: 7,
        source: "chktex",
        code: "other",
        step: "chktex",
      },
      {
        file: "main.tex",
        line: 12,
        kind: "error",
        message: "chktex 1: Command terminated with space.",
        column: 1,
        source: "chktex",
        code: "other",
        step: "chktex",
      },
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
      {
        file: "main.tex",
        line: 6,
        kind: "warning",
        message: "chktex 9: same message",
        column: 2,
        source: "chktex",
        code: "other",
        step: "chktex",
      },
    ]);
  });

  test("空输出 = 没有警告", () => {
    assert.deepEqual(parseChktexOutput("", projectDir), []);
  });
});

describe("chktexCwd（chktex 的进程 cwd）", () => {
  test("项目内的文件 → 项目目录（子文件也一样，不用它自己的目录）", () => {
    assert.equal(chktexCwd(join(projectDir, "main.tex"), projectDir), projectDir);
    // chktex 按 cwd 解析 `\input`，子文件里 root 相对的路径只有在项目根才找得到
    assert.equal(chktexCwd(join(projectDir, "sections", "results.tex"), projectDir), projectDir);
  });

  test("项目外的文件 → 它自己的目录（不拿别的项目当基准）", () => {
    const outside = resolve("C:/other/x.tex");
    assert.equal(chktexCwd(outside, projectDir), resolve("C:/other"));
  });
});

describe("lintWithChktex（cwd 一路传到 spawn）", () => {
  test("注入的 runner 收到项目目录作 cwd，输出照常解析", async () => {
    const file = join(projectDir, "sections", "results.tex");
    const calls: { args: string[]; cwd: string }[] = [];
    const result = await lintWithChktex({
      binary: "fake-chktex",
      file,
      projectDir,
      run: async (_binary, args, _timeout, cwd) => {
        calls.push({ args, cwd });
        return { stdout: "sections/results.tex:7:5:6:Warning:44:User Regex: -2:booktabs.\n", timedOut: false, failed: false };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.cwd, projectDir);
    assert.deepEqual(calls[0]?.args.slice(1), ["-q", file]);
    assert.equal(result.ok, true);
    // cwd 相对路径经 parseChktexOutput 归一成项目相对；不会错记到被检查的那个文件头上
    assert.equal(result.issues[0]?.file, "sections/results.tex");
    assert.equal(result.issues[0]?.message, "chktex 44: User Regex: -2:booktabs.");
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

  test("`\\input` 跟着进子文件：没有 27 假警告，子文件的真警告归它自己", async () => {
    const binary = await probeChktex(null);
    if (binary === null) return;
    const dir = mkdtempSync(join(tmpdir(), "orbita-chktex-input-"));
    try {
      mkdirSync(join(dir, "sections"));
      const main = join(dir, "main.tex");
      writeFileSync(main, "\\documentclass{article}\n\\begin{document}\n\\input{sections/results}\n\\end{document}\n");
      // 子文件里的直引号：cwd 不对时 chktex 打不开它，只会报 27 并把这条真警告吞掉
      writeFileSync(join(dir, "sections", "results.tex"), "He said \"hello\" there.\n");
      const result = await lintWithChktex({ binary, file: main, projectDir: dir });
      assert.equal(result.ok, true);
      assert.equal(result.issues.filter((issue) => issue.message.includes("chktex 27")).length, 0);
      assert.ok(result.issues.some((issue) => issue.file === "sections/results.tex" && issue.line === 1));
      assert.ok(!result.issues.some((issue) => issue.file === "main.tex"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("chktex 不可用时的安静降级", () => {
  test("二进制起不来：ok:false、无问题、不抛（界面据此不显示这条通道）", async () => {
    const result = await lintWithChktex({
      binary: "definitely-not-a-chktex-binary-xyz",
      file: "main.tex",
      projectDir,
    });
    assert.deepEqual(result, { ok: false, issues: [] });
  });
});
