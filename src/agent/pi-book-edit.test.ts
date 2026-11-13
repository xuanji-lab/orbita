import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { movePiBook, piBookContextRoles, revertPiBook, undoPiBook } from "./pi-book-edit.ts";

/**
 * 用**真的 SessionManager** 测（不 mock）：这一刀的险处全在 pi 的落盘语义里——
 * branch 只改内存、_persist 在「本子还没有 assistant」时不落盘、open 把叶子
 * 读到文件末尾。mock 掉任何一个都等于只测了我们自己的想象。
 */

let counter = 0;

function user(text: string): UserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic",
    provider: "zai",
    model: "glm-5.3",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    stopReason: "stop",
  } as AssistantMessage;
}

/** 造一本「两轮完整对话」的本子（文件持久化，模拟真实跑过的会话）。 */
async function bookWithTwoRounds(dir: string): Promise<{ manager: SessionManager; file: string }> {
  const manager = SessionManager.create("/tmp/work", dir);
  manager.appendMessage(user("first question"));
  manager.appendMessage(assistant("first answer"));
  manager.appendMessage(user("second question"));
  manager.appendMessage(assistant("second answer"));
  const file = manager.getSessionFile();
  if (file === undefined) throw new Error("expected a persisted session file");
  return { manager, file };
}

describe("revertPiBook", () => {
  test("裁到 roles 前缀之后：上下文只剩前缀，追加的界碑不进上下文", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-book-"));
    try {
      const { manager } = await bookWithTwoRounds(dir);
      revertPiBook(manager, ["user", "assistant"], { targetMessageId: "u2" });
      const roles = piBookContextRoles(manager);
      // 第二轮被撤：上下文只剩 first question / first answer
      assert.deepEqual(roles, ["user", "assistant"]);
      const text = JSON.stringify(manager.buildSessionContext().messages);
      assert.ok(text.includes("first"));
      assert.ok(!text.includes("second"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("roles 为空（回退到首条消息之前）：resetLeaf，上下文清空", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-book-"));
    try {
      const { manager } = await bookWithTwoRounds(dir);
      revertPiBook(manager, [], { targetMessageId: "u1" });
      assert.deepEqual(piBookContextRoles(manager), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("界碑持久化：重新 open 后叶子仍在裁点——回退不丢", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-book-"));
    try {
      const { manager, file } = await bookWithTwoRounds(dir);
      revertPiBook(manager, ["user", "assistant"], { targetMessageId: "u2" });
      // SessionManager 无 dispose（那是 AgentSession 的方法）；文件句柄按需打开即关
      // open 把叶子读到文件末尾——末尾必须是刚追加的 orbita-revert 界碑，
      // 而不是废枝（第二轮）的最后一个条目
      const reopened = SessionManager.open(file, undefined, "/tmp/work");
      assert.deepEqual(piBookContextRoles(reopened), ["user", "assistant"]);
      // SessionManager 无 dispose；文件按需打开即关
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("首条消息边界：本子还没落过 assistant（文件不存在）不炸、空本子对非空前缀报错", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-book-"));
    try {
      // 真实形状：create 出来的本子只有内存里的 header，文件还没写（pi 的
      // flushed 逻辑：没有 assistant 之前 _persist 不落盘）
      const fresh = SessionManager.create("/tmp/work", dir);
      fresh.appendMessage(user("never answered"));
      assert.equal(fresh.getSessionFile() !== undefined, true);
      // 空前缀合法：整本丢弃
      revertPiBook(fresh, [], { targetMessageId: "u" });
      assert.deepEqual(piBookContextRoles(fresh), []);
      // 非空前缀对空本子：对不出账，拒绝（宁拒不切错）
      const empty = SessionManager.create("/tmp/work", dir);
      assert.throws(() => revertPiBook(empty, ["user"], { targetMessageId: "u" }));
      // 同上
      // 同上
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("只有 header 的空文件（曾被 open 过）：回退后界碑直接落盘", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-book-"));
    try {
      const file = join(dir, "only-header.jsonl");
      await writeFile(file, "", "utf8");
      const manager = SessionManager.open(file, undefined, "/tmp/work");
      // flushed=true 的空本子：追加 custom 条目会直接落盘（hasAssistant 分支前置）
      revertPiBook(manager, [], { targetMessageId: "u" });
      const raw = await readFile(file, "utf8");
      assert.ok(raw.includes("orbita-revert"));
      // SessionManager 无 dispose（那是 AgentSession 的方法）；文件句柄按需打开即关
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("账对不上（顺序漂移）拒绝回退", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-book-"));
    try {
      const { manager } = await bookWithTwoRounds(dir);
      assert.throws(() => revertPiBook(manager, ["assistant", "user"], { targetMessageId: "u" }));
      // SessionManager 无 dispose（那是 AgentSession 的方法）；文件句柄按需打开即关
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("undoPiBook", () => {
  test("追加的 custom_message 进上下文（模型能看到），落盘后重开仍在", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-book-"));
    try {
      const { manager, file } = await bookWithTwoRounds(dir);
      undoPiBook(manager, "The user undid the agent's file changes: a.ts");
      const text = JSON.stringify(manager.buildSessionContext().messages);
      assert.ok(text.includes("The user undid the agent's file changes"));
      assert.deepEqual(piBookContextRoles(manager), ["user", "assistant", "user", "assistant", "user"]);
      // SessionManager 无 dispose（那是 AgentSession 的方法）；文件句柄按需打开即关
      const reopened = SessionManager.open(file, undefined, "/tmp/work");
      assert.ok(JSON.stringify(reopened.buildSessionContext().messages).includes("undid the agent"));
      // SessionManager 无 dispose；文件按需打开即关
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("回退之后的本子上撤销：撤销落在当前叶子（新枝）末尾", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-book-"));
    try {
      const { manager } = await bookWithTwoRounds(dir);
      revertPiBook(manager, ["user", "assistant"], { targetMessageId: "u2" });
      manager.appendMessage(user("redo question"));
      manager.appendMessage(assistant("redo answer"));
      undoPiBook(manager, "The user undid the agent's file changes: b.md");
      // 新枝上的完整一轮 + 撤销通知；废枝（second）不在
      assert.deepEqual(piBookContextRoles(manager), [
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
      ]);
      const text = JSON.stringify(manager.buildSessionContext().messages);
      assert.ok(!text.includes("second"));
      assert.ok(text.includes("b.md"));
      // SessionManager 无 dispose（那是 AgentSession 的方法）；文件句柄按需打开即关
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("movePiBook", () => {
  test("换目录后用新 cwd 重开：通知进上下文，pi 报告的 cwd 是新目录（本子头里的旧值被覆盖）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-book-"));
    try {
      const { file } = await bookWithTwoRounds(dir);
      // 本子是在 /tmp/work 建的；迁移时 runtime 用新目录开它
      const opened = SessionManager.open(file, undefined, "/tmp/elsewhere");
      movePiBook(opened, "The working directory moved from /tmp/work to /tmp/elsewhere.");
      const reopened = SessionManager.open(file, undefined, "/tmp/elsewhere");
      assert.equal(reopened.getCwd(), "/tmp/elsewhere");
      const text = JSON.stringify(reopened.buildSessionContext().messages);
      assert.ok(text.includes("moved from /tmp/work to /tmp/elsewhere"));
      // 旧对话原样保留，通知排在末尾（作为 user 侧消息）
      assert.ok(text.includes("first answer") && text.includes("second answer"));
      assert.deepEqual(piBookContextRoles(reopened), ["user", "assistant", "user", "assistant", "user"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
