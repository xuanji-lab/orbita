import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { planLegacyMigration } from "./legacy-migrate.ts";
import { branchPiBook, movePiBook, PiBookFile, revertPiBook, undoPiBook } from "./pi-book-edit.ts";

/**
 * 测真文件（不 mock）：这一刀的险处全在落盘规则——回退只改内存、要靠追加一行才落盘；
 * 文件最后一行就是叶子；文件不存在时不建。上下文用迁移器（legacy-migrate.ts）的投影来看：
 * 这些本子下一次开轮正是被它迁进库，它看到什么，模型就看到什么。
 */

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-book-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function line(id: string, parentId: string | null, message: object): string {
  return JSON.stringify({ type: "message", id, parentId, timestamp: "2026-11-01T00:00:00.000Z", message });
}
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const answer = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: "zai", model: "glm-5.3", usage, stopReason: "stop", timestamp: 2 });

/** 一本「两轮完整对话」的本子 */
async function bookWithTwoRounds(dir: string, version = 3): Promise<string> {
  const file = join(dir, "2026-11-01T00-00-00-000Z_s1.jsonl");
  const header = JSON.stringify({ type: "session", version, id: "s1", timestamp: "2026-11-01T00:00:00.000Z", cwd: "/tmp/work" });
  await writeFile(file, [header, line("a1", null, user("first question")), line("a2", "a1", answer("first answer")), line("a3", "a2", user("second question")), line("a4", "a3", answer("second answer"))].join("\n") + "\n");
  return file;
}

async function contextOf(file: string): Promise<{ roles: string[]; text: string }> {
  const result = planLegacyMigration(await readFile(file, "utf8"));
  if (!result.ok) throw new Error(result.reason);
  const messages: Message[] = result.plan.drafts.flatMap((draft) => draft.model).filter((message) => message.role !== "system");
  return { roles: messages.map((message) => (message.role === "assistant" ? "assistant" : "user")), text: JSON.stringify(messages) };
}

describe("revertPiBook", () => {
  test("裁到 roles 前缀之后：重新读，上下文只剩前缀；追加的界碑不进上下文", () =>
    withDir(async (dir) => {
      const file = await bookWithTwoRounds(dir);
      revertPiBook(PiBookFile.open(file, "/tmp/work"), ["user", "assistant"], { targetMessageId: "u2" });
      const context = await contextOf(file);
      assert.deepEqual(context.roles, ["user", "assistant"]);
      assert.ok(!context.text.includes("second"));
      assert.match(await readFile(file, "utf8"), /"customType":"orbita-revert".*"parentId":"a2"/);
    }));

  test("roles 为空（回退到首条消息之前）：上下文清空", () =>
    withDir(async (dir) => {
      const file = await bookWithTwoRounds(dir);
      revertPiBook(PiBookFile.open(file, "/tmp/work"), [], { targetMessageId: "u1" });
      assert.deepEqual((await contextOf(file)).roles, []);
    }));

  test("文件不存在（首轮还没落盘）：空前缀不炸也不建文件；非空前缀报错", () =>
    withDir(async (dir) => {
      const file = join(dir, "never.jsonl");
      revertPiBook(PiBookFile.open(file, "/tmp/work"), [], { targetMessageId: "u" });
      assert.deepEqual(await readdir(dir), []);
      assert.throws(() => revertPiBook(PiBookFile.open(file, "/tmp/work"), ["user"], { targetMessageId: "u" }), /empty/);
    }));

  test("空文件：先写本子头，再落界碑", () =>
    withDir(async (dir) => {
      const file = join(dir, "only-header.jsonl");
      await writeFile(file, "");
      revertPiBook(PiBookFile.open(file, "/tmp/work"), [], { targetMessageId: "u" });
      const lines = (await readFile(file, "utf8")).trim().split("\n").map((each) => JSON.parse(each) as { type: string; cwd?: string });
      assert.equal(lines[0]?.type, "session");
      assert.equal(lines[0]?.cwd, "/tmp/work");
      assert.equal(lines[1]?.type, "custom");
    }));

  test("文件非空却不是本子：报错，不动它", () =>
    withDir(async (dir) => {
      const file = join(dir, "junk.jsonl");
      await writeFile(file, "not json\n");
      assert.throws(() => PiBookFile.open(file, "/tmp/work"));
      assert.equal(await readFile(file, "utf8"), "not json\n");
    }));

  test("账对不上（顺序漂移）拒绝回退，文件不变", () =>
    withDir(async (dir) => {
      const file = await bookWithTwoRounds(dir);
      const before = await readFile(file, "utf8");
      assert.throws(() => revertPiBook(PiBookFile.open(file, "/tmp/work"), ["assistant", "user"], { targetMessageId: "u" }));
      assert.equal(await readFile(file, "utf8"), before);
    }));

  test("v2 的老本子：先改写成 v3 再追加", () =>
    withDir(async (dir) => {
      const file = await bookWithTwoRounds(dir, 2);
      revertPiBook(PiBookFile.open(file, "/tmp/work"), ["user", "assistant"], { targetMessageId: "u2" });
      assert.match((await readFile(file, "utf8")).split("\n")[0] ?? "", /"version":3/);
      assert.deepEqual((await contextOf(file)).roles, ["user", "assistant"]);
    }));
});

describe("undoPiBook / movePiBook", () => {
  test("追加的 custom_message 进上下文，挂在当前叶子下", () =>
    withDir(async (dir) => {
      const file = await bookWithTwoRounds(dir);
      undoPiBook(PiBookFile.open(file, "/tmp/work"), "The user undid the agent's file changes: a.ts");
      const context = await contextOf(file);
      assert.deepEqual(context.roles, ["user", "assistant", "user", "assistant", "user"]);
      assert.ok(context.text.includes("undid the agent's file changes"));
    }));

  test("回退之后再撤销：撤销落在新枝末尾，废枝不在上下文里", () =>
    withDir(async (dir) => {
      const file = await bookWithTwoRounds(dir);
      revertPiBook(PiBookFile.open(file, "/tmp/work"), ["user", "assistant"], { targetMessageId: "u2" });
      undoPiBook(PiBookFile.open(file, "/tmp/work"), "The user undid the agent's file changes: b.md");
      const context = await contextOf(file);
      assert.deepEqual(context.roles, ["user", "assistant", "user"]);
      assert.ok(!context.text.includes("second") && context.text.includes("b.md"));
    }));

  test("换工作目录：通知进上下文，旧对话原样保留", () =>
    withDir(async (dir) => {
      const file = await bookWithTwoRounds(dir);
      movePiBook(PiBookFile.open(file, "/tmp/elsewhere"), "The working directory moved from /tmp/work to /tmp/elsewhere.");
      const context = await contextOf(file);
      assert.ok(context.text.includes("moved from /tmp/work to /tmp/elsewhere"));
      assert.ok(context.text.includes("first answer") && context.text.includes("second answer"));
      assert.match(await readFile(file, "utf8"), /"customType":"orbita-move"/);
    }));
});

describe("branchPiBook", () => {
  test("裁到第一轮回答，写成同目录的新本子：新 id、头里记源文件与现在的 cwd；源本子不动", () =>
    withDir(async (dir) => {
      const file = await bookWithTwoRounds(dir);
      const before = await readFile(file, "utf8");
      const branched = branchPiBook(PiBookFile.open(file, "/tmp/now"), ["user", "assistant"]);
      assert.equal(await readFile(file, "utf8"), before);
      const lines = (await readFile(branched, "utf8")).trim().split("\n").map((each) => JSON.parse(each) as Record<string, unknown>);
      assert.equal(lines[0]?.["parentSession"], file);
      assert.equal(lines[0]?.["cwd"], "/tmp/now");
      assert.notEqual(lines[0]?.["id"], "s1");
      assert.deepEqual((await contextOf(branched)).roles, ["user", "assistant"]);
    }));

  test("锚点不是回答：拒绝", () =>
    withDir(async (dir) => {
      const file = await bookWithTwoRounds(dir);
      assert.throws(() => branchPiBook(PiBookFile.open(file, "/tmp/work"), ["user"]), /agent reply/);
    }));
});
