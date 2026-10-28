import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKimiExternalSessionReader, kimiWorkDataRoot, type ExternalSourceRoots } from "./external-session.ts";

let dir = "";
let clock = 1000;

function rec(record: Record<string, unknown>): string {
  clock += 1;
  return JSON.stringify({ ...record, time: clock });
}

function user(text: string): string {
  return rec({
    type: "context.append_message",
    agentId: "main",
    message: { role: "user", content: [{ type: "text", text }], origin: { kind: "user" } },
  });
}

function answer(text: string, step = "s1"): string[] {
  return [
    rec({ type: "llm.request", agentId: "main", model: "k3" }),
    rec({ type: "context.append_loop_event", agentId: "main", event: { type: "step.begin", uuid: step, step: 1 } }),
    rec({ type: "context.append_loop_event", agentId: "main", event: { type: "content.part", part: { type: "text", text } } }),
    rec({ type: "context.append_loop_event", agentId: "main", event: { type: "step.end", uuid: step, finishReason: "end_turn" } }),
  ];
}

async function addSession(input: {
  root: string;
  workspace?: string;
  id: string;
  title?: string;
  cwd?: string;
  prompt: string;
  answer: string;
}): Promise<string> {
  const sessionDir = join(input.root, "sessions", input.workspace ?? "ws-1", input.id);
  await mkdir(join(sessionDir, "agents", "main"), { recursive: true });
  await writeFile(
    join(sessionDir, "state.json"),
    JSON.stringify({
      id: input.id,
      title: input.title ?? "New Session",
      isCustomTitle: input.title !== undefined,
      cwd: input.cwd,
      createdAt: 100,
      updatedAt: 200,
    }),
  );
  const wire = [user(input.prompt), ...answer(input.answer)].join("\n");
  await writeFile(join(sessionDir, "agents", "main", "wire.jsonl"), wire);
  return join(sessionDir, "agents", "main", "wire.jsonl");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-external-session-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Kimi 外部会话只读", () => {
  test("目录合并 Kimi Code / Kimi Work；无标题从首条提问取名；ref 稳定", async () => {
    const codeRoot = join(dir, ".kimi-code");
    const workRoot = join(dir, "kimi-work");
    await addSession({ root: codeRoot, id: "code-1", title: "Code 会话", prompt: "code prompt", answer: "code answer" });
    await addSession({ root: workRoot, id: "work-1", prompt: "Work 的第一句", answer: "work answer" });
    const groups: ExternalSourceRoots[] = [
      { source: "kimi-code", roots: [codeRoot] },
      { source: "kimi-work", roots: [workRoot] },
    ];
    const reader = createKimiExternalSessionReader({ sources: async () => groups, defaultCwd: join(dir, "default") });

    const first = await reader.list();
    const second = await reader.list();
    assert.equal(first.length, 2);
    assert.deepEqual(new Set(first.map((item) => item.source)), new Set(["kimi-code", "kimi-work"]));
    assert.ok(first.some((item) => item.title === "Code 会话"));
    assert.ok(first.some((item) => item.title === "Work 的第一句"));
    assert.deepEqual(first.map((item) => item.ref), second.map((item) => item.ref));
    assert.ok(first.every((item) => /^ext:kimi-(?:code|work):[0-9a-f]{16}$/.test(item.ref)));
  });

  test("load 读全文但不写源目录或默认 cwd；源里追加后同一 ref 读到新轮", async () => {
    const root = join(dir, "kimi-work");
    const defaultCwd = join(dir, "must-not-be-created");
    const sourceFile = await addSession({ root, id: "work-1", prompt: "第一句", answer: "第一答" });
    const reader = createKimiExternalSessionReader({
      sources: async () => [{ source: "kimi-work", roots: [root] }],
      defaultCwd,
    });
    const [summary] = await reader.list();
    assert.ok(summary !== undefined);
    const before = await readFile(sourceFile, "utf8");

    const detail = await reader.load(summary.ref);
    assert.ok(detail !== null);
    assert.equal(detail.meta.id, summary.ref);
    assert.equal(detail.meta.cwd, defaultCwd);
    assert.equal(detail.meta.importedFrom, sourceFile);
    assert.equal(detail.records[0]?.role, "user");
    assert.equal(detail.records[1]?.role, "assistant");
    assert.equal(await readFile(sourceFile, "utf8"), before);
    await assert.rejects(stat(defaultCwd));

    await writeFile(sourceFile, `${before}\n${[user("第二句"), ...answer("第二答", "s2")].join("\n")}`);
    const updated = await reader.load(summary.ref);
    assert.ok(updated !== null);
    assert.equal(updated.records.filter((record) => record.role === "user").length, 2);
    assert.equal(updated.records.filter((record) => record.role === "assistant").length, 2);
    assert.equal(updated.meta.importedFrom, sourceFile);
  });

  test("目录只列最近 10 条；精确 ref 仍能读目录之外的旧会话", async () => {
    const root = join(dir, "kimi-work");
    const oldFile = await addSession({ root, id: "old", title: "旧会话", prompt: "old prompt", answer: "old answer" });
    await utimes(oldFile, new Date(1000), new Date(1000));
    const reader = createKimiExternalSessionReader({
      sources: async () => [{ source: "kimi-work", roots: [root] }],
      defaultCwd: dir,
    });
    const [old] = await reader.list();
    assert.ok(old !== undefined);

    for (let index = 0; index < 10; index += 1) {
      const file = await addSession({
        root,
        id: `new-${index}`,
        title: `新会话 ${index}`,
        prompt: `new prompt ${index}`,
        answer: `new answer ${index}`,
      });
      const time = new Date(10_000 + index * 1000);
      await utimes(file, time, time);
    }

    const listed = await reader.list();
    assert.equal(listed.length, 10);
    assert.ok(listed.every((item) => item.ref !== old.ref));
    const detail = await reader.load(old.ref);
    assert.ok(detail !== null);
    assert.equal(detail.summary.title, "旧会话");
    assert.equal(detail.records[0]?.role, "user");
  });

  test("Kimi Work 不列自动起标题的内部会话；标题去掉用户原文前的 meta", async () => {
    const root = join(dir, "kimi-work");
    await addSession({
      root,
      id: "conv-visible",
      prompt: '<meta awareness="low" timestamp="2026-10-28 22:37" />\n可以迁移聊天记录进来吗？',
      answer: "visible answer",
    });
    await addSession({
      root,
      id: "ctitle-internal",
      prompt: "Generate a concise title for the conversation below",
      answer: "内部标题",
    });
    await addSession({
      root,
      id: "conv-state-title",
      title: '<meta awareness="low" timestamp="2026-09-15 22:05" /> can you generate images?',
      prompt: "fallback prompt",
      answer: "state answer",
    });
    const reader = createKimiExternalSessionReader({
      sources: async () => [{ source: "kimi-work", roots: [root] }],
      defaultCwd: dir,
    });

    const listed = await reader.list();
    assert.equal(listed.length, 2);
    assert.deepEqual(
      new Set(listed.map((item) => item.title)),
      new Set(["可以迁移聊天记录进来吗？", "can you generate images?"]),
    );
    assert.ok(listed.every((item) => /^ext:kimi-work:/.test(item.ref)));
  });

  test("坏 ref / 不存在的来源返回 null；源里删掉的工作区不列", async () => {
    const root = join(dir, ".kimi-code");
    await addSession({ root, workspace: "deleted", id: "old", prompt: "hidden", answer: "hidden" });
    await writeFile(join(root, "workspaces.json"), JSON.stringify({ deleted_workspace_ids: ["deleted"] }));
    const reader = createKimiExternalSessionReader({
      sources: async () => [{ source: "kimi-code", roots: [root, join(dir, "missing")] }],
      defaultCwd: dir,
    });
    assert.deepEqual(await reader.list(), []);
    assert.equal(await reader.load("ext:kimi-code:0000000000000000"), null);
    assert.equal(await reader.load("not-an-external-ref"), null);
  });

  test("Kimi Work 数据根从 appData 推导", () => {
    assert.equal(
      kimiWorkDataRoot("/app-data"),
      join("/app-data", "kimi-desktop", "daimon-share", "daimon", "runtime", "kimi-code", "home"),
    );
  });
});
