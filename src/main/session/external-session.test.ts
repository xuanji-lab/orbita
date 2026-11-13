import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createExternalSessionReader,
  INDEX_PER_SOURCE,
  type ExternalSessionReader,
  type ExternalSessionSummary,
  type ExternalSourceRoots,
} from "./external-session.ts";
import {
  EXTERNAL_BLOB_MAX_BYTES,
  EXTERNAL_BLOBS_MAX_BYTES,
  EXTERNAL_SOURCE_MAX_BYTES as EXTERNAL_WIRE_MAX_BYTES,
  EXTERNAL_TOTAL_MAX_BYTES,
  kimiWorkDataRoot,
} from "./external-adapters.ts";

type Group = Omit<ExternalSourceRoots, "enabled"> & { enabled?: boolean };

/** 测试里的 reader：开关缺省开着，桌面清单目录指向不存在的地方。 */
function createKimiExternalSessionReader(input: { sources: () => Promise<readonly Group[]>; defaultCwd: string }): ExternalSessionReader {
  return createExternalSessionReader({
    defaultCwd: input.defaultCwd,
    claudeDesktopDir: join(input.defaultCwd, "no-claude-desktop"),
    sources: async () => (await input.sources()).map((group) => ({ ...group, enabled: group.enabled ?? true })),
  });
}

/** 目录的各段摊平成一列（测试只关心列了哪些）。 */
async function listed(reader: ExternalSessionReader): Promise<ExternalSessionSummary[]> {
  return (await reader.list()).flatMap((section) => section.summaries);
}

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

function imageRecord(shas: readonly string[]): string {
  return rec({
    type: "context.append_message",
    agentId: "main",
    message: {
      role: "user",
      content: shas.map((sha) => ({ type: "image_url", imageUrl: { url: `blobref:image/png;${sha}` } })),
      origin: { kind: "user" },
    },
  });
}

async function addSession(input: {
  root: string;
  workspace?: string;
  id: string;
  title?: string;
  cwd?: string;
  prompt: string;
  answer: string;
  wireOverride?: string;
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
  const wire = input.wireOverride ?? [user(input.prompt), ...answer(input.answer)].join("\n");
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
    const groups: Group[] = [
      { source: "kimi-code", roots: [codeRoot] },
      { source: "kimi-work", roots: [workRoot] },
    ];
    const reader = createKimiExternalSessionReader({ sources: async () => groups, defaultCwd: join(dir, "default") });

    const first = await listed(reader);
    const second = await listed(reader);
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
    const [summary] = await listed(reader);
    assert.ok(summary !== undefined);
    const before = await readFile(sourceFile, "utf8");

    const detail = await reader.load(summary.ref);
    assert.ok(detail !== null);
    assert.equal(detail.meta.id, summary.ref);
    assert.equal(detail.meta.cwd, defaultCwd);
    assert.equal(detail.sourceFile, sourceFile);
    // 源坐标不借 SessionMeta.importedFrom（那是导入幂等键，用量统计按它排除导入会话）
    assert.equal(detail.meta.importedFrom, undefined);
    assert.equal(detail.records[0]?.role, "user");
    assert.equal(detail.records[1]?.role, "assistant");
    assert.equal(await readFile(sourceFile, "utf8"), before);
    await assert.rejects(stat(defaultCwd));

    await writeFile(sourceFile, `${before}\n${[user("第二句"), ...answer("第二答", "s2")].join("\n")}`);
    const updated = await reader.load(summary.ref);
    assert.ok(updated !== null);
    assert.equal(updated.records.filter((record) => record.role === "user").length, 2);
    assert.equal(updated.records.filter((record) => record.role === "assistant").length, 2);
    assert.equal(updated.sourceFile, sourceFile);
  });

  test("目录每个来源只列最近 INDEX_PER_SOURCE 条；精确 ref 仍能读目录之外的旧会话", async () => {
    const root = join(dir, "kimi-work");
    const oldFile = await addSession({ root, id: "old", title: "旧会话", prompt: "old prompt", answer: "old answer" });
    await utimes(oldFile, new Date(1000), new Date(1000));
    const reader = createKimiExternalSessionReader({
      sources: async () => [{ source: "kimi-work", roots: [root] }],
      defaultCwd: dir,
    });
    const [old] = await listed(reader);
    assert.ok(old !== undefined);

    for (let index = 0; index < INDEX_PER_SOURCE; index += 1) {
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

    const recent = await listed(reader);
    assert.equal(recent.length, INDEX_PER_SOURCE);
    assert.ok(recent.every((item) => item.ref !== old.ref));
    // 总数如实写出
    assert.equal((await reader.list())[0]?.total, INDEX_PER_SOURCE + 1);
    // 只看这一个来源时放宽条数，旧会话也列得出
    assert.ok((await reader.list({ source: "kimi-work" }))[0]?.summaries.some((item) => item.ref === old.ref));
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

    const visible = await listed(reader);
    assert.equal(visible.length, 2);
    assert.deepEqual(
      new Set(visible.map((item) => item.title)),
      new Set(["可以迁移聊天记录进来吗？", "can you generate images?"]),
    );
    assert.ok(visible.every((item) => /^ext:kimi-work:/.test(item.ref)));
  });

  test("坏 ref / 不存在的来源返回 null；源里删掉的工作区不列", async () => {
    const root = join(dir, ".kimi-code");
    await addSession({ root, workspace: "deleted", id: "old", prompt: "hidden", answer: "hidden" });
    await writeFile(join(root, "workspaces.json"), JSON.stringify({ deleted_workspace_ids: ["deleted"] }));
    const reader = createKimiExternalSessionReader({
      sources: async () => [{ source: "kimi-code", roots: [root, join(dir, "missing")] }],
      defaultCwd: dir,
    });
    assert.deepEqual(await listed(reader), []);
    // 自定义目录被挪走：如实写进这一段的 problems，不静默当成没有
    const [section] = await reader.list();
    assert.ok(section?.problems.some((problem) => problem.includes(join(dir, "missing"))));
    assert.equal(await reader.load("ext:kimi-code:0000000000000000"), null);
    assert.equal(await reader.load("not-an-external-ref"), null);
  });

  test("wire 超过字节预算时拒绝，不返回部分 transcript，也不改源文件", async () => {
    const root = join(dir, "kimi-work");
    const sourceFile = await addSession({
      root,
      id: "wire-too-large",
      prompt: "prompt",
      answer: "answer",
      wireOverride: "x".repeat(EXTERNAL_WIRE_MAX_BYTES + 1),
    });
    const before = await readFile(sourceFile);
    const reader = createKimiExternalSessionReader({
      sources: async () => [{ source: "kimi-work", roots: [root] }],
      defaultCwd: dir,
    });
    const [summary] = await listed(reader);
    assert.ok(summary !== undefined);
    await assert.rejects(reader.load(summary.ref), /Could not read Kimi Work session .*wire\.jsonl exceeds/);
    assert.deepEqual(await readFile(sourceFile), before);
  });

  test("单个 blob 超过预算时拒绝，且不把 blob 转成 base64", async () => {
    const root = join(dir, "kimi-work");
    const sha = "a".repeat(64);
    const sourceFile = await addSession({
      root,
      id: "blob-too-large",
      prompt: "prompt",
      answer: "answer",
      wireOverride: [imageRecord([sha]), ...answer("answer")].join("\n"),
    });
    const blobsDir = join(dirname(sourceFile), "blobs");
    await mkdir(blobsDir, { recursive: true });
    await writeFile(join(blobsDir, sha), Buffer.alloc(EXTERNAL_BLOB_MAX_BYTES + 1, 7));
    const reader = createKimiExternalSessionReader({
      sources: async () => [{ source: "kimi-work", roots: [root] }],
      defaultCwd: dir,
    });
    const [summary] = await listed(reader);
    assert.ok(summary !== undefined);
    await assert.rejects(reader.load(summary.ref), /an image blob exceeds/);
  });

  test("多个 blob 的合计预算生效；预算内会话仍能载入", async () => {
    const root = join(dir, "kimi-work");
    const shas = ["b", "c", "d", "e"].map((prefix) => prefix.repeat(64));
    const sourceFile = await addSession({
      root,
      id: "blobs-total",
      prompt: "prompt",
      answer: "answer",
      wireOverride: [imageRecord(shas), ...answer("answer")].join("\n"),
    });
    const blobsDir = join(dirname(sourceFile), "blobs");
    await mkdir(blobsDir, { recursive: true });
    for (const sha of shas) await writeFile(join(blobsDir, sha), Buffer.alloc(Math.floor(EXTERNAL_BLOBS_MAX_BYTES / shas.length) + 1, 9));
    const reader = createKimiExternalSessionReader({
      sources: async () => [{ source: "kimi-work", roots: [root] }],
      defaultCwd: dir,
    });
    const [summary] = await listed(reader);
    assert.ok(summary !== undefined);
    await assert.rejects(reader.load(summary.ref), /the referenced image blobs exceeds/);

    const wirePrefix = [imageRecord(shas), ...answer("answer")].join("\n");
    const wire = `${wirePrefix}${"x".repeat(EXTERNAL_WIRE_MAX_BYTES - Buffer.byteLength(wirePrefix) - 1)}`;
    const totalRoot = join(dir, "kimi-work-total");
    const totalSourceFile = await addSession({
      root: totalRoot,
      id: "total-too-large",
      prompt: "prompt",
      answer: "answer",
      wireOverride: wire,
    });
    const totalBlobsDir = join(dirname(totalSourceFile), "blobs");
    await mkdir(totalBlobsDir, { recursive: true });
    const totalBlobSize = Math.ceil((EXTERNAL_TOTAL_MAX_BYTES - EXTERNAL_WIRE_MAX_BYTES + 1) / 3);
    for (const sha of shas.slice(0, 3)) await writeFile(join(totalBlobsDir, sha), Buffer.alloc(totalBlobSize, 8));
    const totalReader = createKimiExternalSessionReader({
      sources: async () => [{ source: "kimi-work", roots: [totalRoot] }],
      defaultCwd: dir,
    });
    const [totalSummary] = await listed(totalReader);
    assert.ok(totalSummary !== undefined);
    await assert.rejects(totalReader.load(totalSummary.ref), /the session with its images exceeds/);

    const smallRoot = join(dir, "small-kimi-work");
    const smallSha = "f".repeat(64);
    const smallFile = await addSession({
      root: smallRoot,
      id: "blob-ok",
      prompt: "prompt",
      answer: "answer",
      wireOverride: [imageRecord([smallSha]), ...answer("answer")].join("\n"),
    });
    await mkdir(join(dirname(smallFile), "blobs"), { recursive: true });
    await writeFile(join(dirname(smallFile), "blobs", smallSha), Buffer.from("small-image"));
    const smallReader = createKimiExternalSessionReader({
      sources: async () => [{ source: "kimi-work", roots: [smallRoot] }],
      defaultCwd: dir,
    });
    const [smallSummary] = await listed(smallReader);
    assert.ok(smallSummary !== undefined);
    const detail = await smallReader.load(smallSummary.ref);
    assert.ok(detail !== null);
    assert.ok(detail.records.length > 0);
  });
  test("Kimi Work 数据根从 appData 推导", () => {
    assert.equal(
      kimiWorkDataRoot("/app-data"),
      join("/app-data", "kimi-desktop", "daimon-share", "daimon", "runtime", "kimi-code", "home"),
    );
  });
});
