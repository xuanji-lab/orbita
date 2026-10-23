/**
 * new_paper 的边界：目录授权、非空拒绝、默认目录、title 透传。
 *
 * 这里不碰模板内容本身（paper-template.test.ts 管）也不跑编译（真编译在
 * paper-template.test.ts 的「模板能编译」）；测的是「这一层会不会把论文写到
 * 不该去的地方、会不会覆盖已有文件」——两条都出过真实事故的形态。
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NewPaperOutcome } from "../../shared/latex.ts";
import { applyNewPaperRequest } from "./new-paper.ts";

const roots: string[] = [];

function temp(prefix = "orbita-new-paper-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** 假会话：cwd 就是根，附加目录空（授权名单 = [cwd]） */
function sources(cwd: string, attached: string[] = []) {
  return {
    sessions: { readMeta: async () => ({ cwd, workspaceId: null }) },
    workspaces: { attachedDirsOf: async () => attached },
  };
}

async function create(cwd: string, request: { dir?: string; title?: string }, attached: string[] = []): Promise<NewPaperOutcome> {
  const { sessions, workspaces } = sources(cwd, attached);
  return applyNewPaperRequest(sessions, workspaces, { sessionId: "session-1", request });
}

function filesOf(outcome: NewPaperOutcome): string[] {
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.error);
  return outcome.result.files;
}

describe("new_paper —— 成功路径", () => {
  test("空目录：写出 main.tex / refs.bib / figures/example.png", async () => {
    const root = temp();
    const outcome = await create(root, {});
    assert.deepEqual(filesOf(outcome), ["main.tex", "refs.bib", "figures/example.png"]);
    assert.ok(outcome.ok);
    assert.equal(outcome.result.dir, realpathSync(root));
    for (const file of ["main.tex", "refs.bib", "figures/example.png"]) {
      assert.ok(existsSync(join(root, file)), `${file} 没写出来`);
    }
    // PNG 真的是图，不是文本占位
    const png = readFileSync(join(root, "figures/example.png"));
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });

  test("目标目录不存在：连父目录一起建", async () => {
    const root = temp();
    const outcome = await create(root, { dir: join("papers", "first-paper") });
    assert.ok(outcome.ok, outcome.ok ? "" : outcome.error);
    assert.equal(outcome.result.dir, join(realpathSync(root), "papers", "first-paper"));
    assert.ok(existsSync(join(root, "papers", "first-paper", "main.tex")));
  });

  test("title 写进 \\title{}，特殊字符被转义", async () => {
    const root = temp();
    await create(root, { title: "RAG: 50%_faster & cheaper" });
    const tex = readFileSync(join(root, "main.tex"), "utf8");
    assert.match(tex, /\\title\{RAG: 50\\%\\_faster \\& cheaper\}/);
  });

  test("附加授权目录里的目标同样可写", async () => {
    const root = temp();
    const attached = temp("orbita-new-paper-attached-");
    const outcome = await create(root, { dir: join(attached, "paper") }, [attached]);
    assert.ok(outcome.ok, outcome.ok ? "" : outcome.error);
    assert.ok(existsSync(join(attached, "paper", "main.tex")));
  });
});

describe("new_paper —— 拒绝路径", () => {
  test("非空目录：拒绝，且一个文件都不写、原内容不动", async () => {
    const root = temp();
    writeFileSync(join(root, "notes.txt"), "keep me", "utf8");
    const before = readdirSync(root).sort();
    const outcome = await create(root, {});
    assert.ok(!outcome.ok);
    assert.match(outcome.error, /is not empty \(notes\.txt\)/);
    assert.match(outcome.error, /never overwrites/);
    assert.deepEqual(readdirSync(root).sort(), before);
    assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "keep me");
    assert.ok(!existsSync(join(root, "main.tex")));
  });

  test("已有同名文件（目录非空的特例）：同样不覆盖", async () => {
    const root = temp();
    mkdirSync(join(root, "figures"));
    writeFileSync(join(root, "refs.bib"), "@misc{mine, title={mine}}", "utf8");
    const outcome = await create(root, {});
    assert.ok(!outcome.ok);
    assert.match(outcome.error, /is not empty/);
    assert.equal(readFileSync(join(root, "refs.bib"), "utf8"), "@misc{mine, title={mine}}");
    assert.ok(!existsSync(join(root, "main.tex")));
  });

  test("授权目录外的已存在目录：拒绝", async () => {
    const root = temp();
    const outside = temp("orbita-new-paper-outside-");
    const outcome = await create(root, { dir: outside });
    assert.ok(!outcome.ok);
    assert.match(outcome.error, /outside this session's authorized directories/);
    assert.ok(!existsSync(join(outside, "main.tex")));
  });

  test("授权目录外的不存在目录：拒绝且不创建", async () => {
    const root = temp();
    const escape = join(root, "..", `orbita-escape-${Date.now()}`);
    const outcome = await create(root, { dir: escape });
    assert.ok(!outcome.ok);
    assert.match(outcome.error, /outside this session's authorized directories/);
    assert.ok(!existsSync(escape));
  });

  test("目标是一个文件：报 not a directory", async () => {
    const root = temp();
    writeFileSync(join(root, "paper"), "not a dir", "utf8");
    const outcome = await create(root, { dir: "paper" });
    assert.ok(!outcome.ok);
    assert.match(outcome.error, /is not a directory/);
  });

  test("会话没有授权目录：明确拒绝，不猜 homedir", async () => {
    const outcome = await applyNewPaperRequest(
      { readMeta: async () => ({ cwd: undefined, workspaceId: null }) },
      { attachedDirsOf: async () => [] },
      { sessionId: "session-1", request: {} },
    );
    assert.ok(!outcome.ok);
    assert.match(outcome.error, /no authorized directory/);
  });
});
