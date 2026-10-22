/**
 * agent 编译请求的边界：目录授权、main 越界、参数透传。
 *
 * 不碰真 latexmk：runner 用只记录参数的假货。目录授权本身（realpath / 越界）由
 * terminal/agent-policy.test.ts 盖住，这里测的是「这一层有没有把它用对」。
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LatexCompileRequest, LatexEngine, LatexResult } from "../../shared/latex.ts";
import { applyLatexRequest, mainInsideDir } from "./agent-requests.ts";

const roots: string[] = [];

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "orbita-latex-request-"));
  roots.push(root);
  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const OK_RESULT: LatexResult = {
  status: "ok",
  engine: "pdf",
  main: "main.tex",
  pdf: null,
  pdfFresh: false,
  pages: null,
  durationMs: 1,
  errors: [],
  warnings: [],
  logStale: false,
  logTail: null,
};

/** 记录 runner 实际收到的请求 */
function recordingRunner(): { compile: (request: LatexCompileRequest) => Promise<{ ok: true; result: LatexResult }>; calls: LatexCompileRequest[] } {
  const calls: LatexCompileRequest[] = [];
  return {
    calls,
    compile: async (request: LatexCompileRequest) => {
      calls.push(request);
      return { ok: true as const, result: OK_RESULT };
    },
  };
}

function sources(cwd: string): {
  sessions: { readMeta: (id: string) => Promise<{ cwd: string; workspaceId: string | null }> };
  workspaces: { attachedDirsOf: (id: string | null) => Promise<string[]> };
} {
  return {
    sessions: { readMeta: async () => ({ cwd, workspaceId: null }) },
    workspaces: { attachedDirsOf: async () => [] },
  };
}

describe("mainInsideDir", () => {
  test("目录内的相对路径放行", () => {
    assert.equal(mainInsideDir("/repo", "main.tex"), true);
    assert.equal(mainInsideDir("/repo", "chapters/one.tex"), true);
  });

  test("绝对路径与 .. 越界拒绝", () => {
    assert.equal(mainInsideDir("/repo", "/etc/main.tex"), false);
    assert.equal(mainInsideDir("/repo", "../main.tex"), false);
    assert.equal(mainInsideDir("/repo", "chapters/../../main.tex"), false);
  });

  test("Windows 盘符相对路径拒绝（D:x.tex 的 resolve 会落到进程 cwd）", () => {
    assert.equal(mainInsideDir("C:\\repo", "D:x.tex"), false);
    assert.equal(mainInsideDir("C:\\repo", "c:x.tex"), false);
  });

  test("前缀相同的兄弟目录不算在目录内", () => {
    // /repo 与 /repo-extra 是两棵不同的树
    assert.equal(mainInsideDir("/repo", "/repo-extra/main.tex"), false);
    assert.equal(mainInsideDir("/repo", "../repo-extra/main.tex"), false);
  });
});

describe("applyLatexRequest", () => {
  test("dir 落在授权目录内：realpath 之后透传给 runner", async () => {
    const root = tempDir();
    const runner = recordingRunner();
    const { sessions, workspaces } = sources(root);
    const outcome = await applyLatexRequest(runner, sessions, workspaces, {
      sessionId: "s1",
      request: { dir: root, main: "main.tex", engine: "xelatex" },
    });
    assert.equal(outcome.ok, true);
    assert.deepEqual(runner.calls, [{ dir: realpathSync(root), main: "main.tex", engine: "xelatex" }]);
  });

  test("dir 缺席 = 会话 cwd", async () => {
    const root = tempDir();
    const runner = recordingRunner();
    const { sessions, workspaces } = sources(root);
    await applyLatexRequest(runner, sessions, workspaces, { sessionId: "s1", request: {} });
    assert.deepEqual(runner.calls, [{ dir: realpathSync(root) }]);
  });

  test("dir 越界：拒绝且不碰 runner", async () => {
    const root = tempDir();
    const outside = tempDir();
    const runner = recordingRunner();
    const { sessions, workspaces } = sources(root);
    const outcome = await applyLatexRequest(runner, sessions, workspaces, {
      sessionId: "s1",
      request: { dir: outside },
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? "" : outcome.error, /outside this session's authorized directories/);
    assert.equal(runner.calls.length, 0);
  });

  test("main 越界：拒绝且不碰 runner", async () => {
    const root = tempDir();
    const runner = recordingRunner();
    const { sessions, workspaces } = sources(root);
    for (const main of ["../main.tex", "/etc/main.tex", "D:main.tex"]) {
      const outcome = await applyLatexRequest(runner, sessions, workspaces, {
        sessionId: "s1",
        request: { dir: root, main },
      });
      assert.equal(outcome.ok, false, `main=${main} 应被拒`);
      assert.match(outcome.ok ? "" : outcome.error, /main must be a relative path inside dir/);
    }
    assert.equal(runner.calls.length, 0);
  });

  test("坏 engine 被丢弃（不把脏值透给 runner）", async () => {
    const root = tempDir();
    const runner = recordingRunner();
    const { sessions, workspaces } = sources(root);
    await applyLatexRequest(runner, sessions, workspaces, {
      sessionId: "s1",
      request: { dir: root, engine: "pdflatex" as unknown as LatexEngine },
    });
    assert.deepEqual(runner.calls, [{ dir: realpathSync(root) }]);
  });
});
