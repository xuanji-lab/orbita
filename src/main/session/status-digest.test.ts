/**
 * StatusDigestStore 的测试（src/main/session/status-digest.ts）：补算 / 增量 / 回退重算 /
 * 坏摘要文件 / 摘要比日志旧 / 空会话 / 已删会话 / 导入更新失效 / 分支播种 / 删除清理 / 批量取。
 * 对账基准：同一份日志用 SessionStore.load 出生效视图，再 foldStatusRecords 折一遍——
 * 两条路径（流式扫盘 vs 内存全量折）必须给出同一个摘要。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, appendFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatusDigestStore } from "./status-digest.ts";
import { SessionStore } from "./store.ts";
import {
  digestChildActivity,
  digestOutputs,
  digestTerminals,
  foldStatusRecords,
  type StatusDigestState,
} from "../../shared/status-digest.ts";
import type { SessionRecord } from "../../shared/session.ts";

const ID = "a7f3c1d2-4b8e-4f21-9c3a-0d1e2f3a4b5c";
const CHILD = "b1c2d3e4-5f60-4a71-8b92-0c1d2e3f4a5b";

let seq = 0;
const rid = () => `rec-${++seq}`;

const user = (text: string, at: number): SessionRecord =>
  ({ role: "user", id: rid(), timestamp: at, content: [{ type: "text", text }] }) as unknown as SessionRecord;
const assistant = (blocks: unknown[], at: number): SessionRecord =>
  ({ role: "assistant", id: rid(), timestamp: at, content: blocks, status: "complete" }) as unknown as SessionRecord;
const toolCall = (toolCallId: string, toolName: string, input: unknown): unknown => ({ type: "toolCall", toolCallId, toolName, input });
const tool = (toolCallId: string, toolName: string, status: string, at: number, extra: Record<string, unknown> = {}): SessionRecord =>
  ({ role: "tool", id: rid(), toolCallId, toolName, input: {}, content: [], timestamp: at, status, isError: status === "error", ...extra }) as unknown as SessionRecord;
const fileTurn = (paths: string[], at: number): SessionRecord =>
  ({
    role: "file-turn",
    id: rid(),
    timestamp: at,
    changes: paths.map((path) => ({ path, before: { kind: "absent" }, after: { kind: "absent" }, added: 1, removed: 0 })),
  }) as unknown as SessionRecord;
const revert = (targetMessageId: string, at: number): SessionRecord =>
  ({ role: "revert", id: rid(), targetMessageId, restored: [], timestamp: at }) as unknown as SessionRecord;

/** 写一份日志（JSONL）+ 最小 meta（load 要它），返回日志字节数 */
async function writeLog(dir: string, id: string, records: readonly SessionRecord[]): Promise<number> {
  const text = records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
  await writeFile(join(dir, `${id}.jsonl`), text, "utf8");
  await writeFile(
    join(dir, `${id}.meta.json`),
    JSON.stringify({ id, title: "", cwd: "/repo/x", providerId: "zai", modelId: "glm-5.3", createdAt: 1000 }),
    "utf8",
  );
  return Buffer.byteLength(text);
}

/** 期望摘要：SessionStore 的生效视图（回退折叠后）全量折一遍 */
async function expectedState(dir: string, id: string): Promise<StatusDigestState> {
  const store = new SessionStore(dir);
  const detail = await store.load(id);
  return foldStatusRecords(detail?.transcript ?? []);
}

/** 摘要的「内容面」深等（meta.records 不比：扫描路径把跳过解析的大行也计数，见 store 注释） */
function assertSameDigest(actual: StatusDigestState, expected: StatusDigestState, label: string): void {
  assert.deepEqual(digestOutputs(actual), digestOutputs(expected), `${label}：产物`);
  assert.deepEqual(digestChildActivity(actual), digestChildActivity(expected), `${label}：在跑什么`);
  assert.deepEqual(digestTerminals(actual), digestTerminals(expected), `${label}：终端`);
  assert.deepEqual(actual.slim, expected.slim, `${label}：slim`);
  assert.equal(actual.meta.lastId, expected.meta.lastId, `${label}：lastId`);
}

describe("StatusDigestStore", () => {
  let dir = "";
  let store: StatusDigestStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "orbita-status-digest-"));
    store = new StatusDigestStore(dir, { persistDelayMs: 5 });
  });
  afterEach(async () => {
    await store.flush();
    await rm(dir, { recursive: true, force: true });
  });

  test("旧会话首次补算：流式扫盘与内存全量折同一本摘要（含回退折叠）", async () => {
    const u1 = user("做个页面", 1000);
    const records = [
      u1,
      assistant([toolCall("c1", "write", { path: "/w/a.html" })], 1001),
      tool("c1", "write", "complete", 1002),
      assistant([{ type: "text", text: "写好了 /w/a.html" }], 1003),
      fileTurn(["/w/a.html"], 1004),
      // 回退到 u1 之前：u1 之后的全折掉，界碑留下
      revert(u1.id, 1005),
      user("换个说法", 1006),
    ];
    await writeLog(dir, ID, records);
    const map = await store.digests([ID]);
    const expected = await expectedState(dir, ID);
    assertSameDigest(map[ID]!, expected, "补算");
    // 回退生效：u1 之后的 write 产物不在摘要里
    assert.equal(digestOutputs(map[ID]!).length, 0);
  });

  test("增量：touch 之后新记录折进摘要", async () => {
    await writeLog(dir, ID, [user("第一句", 1000)]);
    await store.digests([ID]);
    const more = assistant([toolCall("c9", "bash", { command: "ls" })], 1001);
    await appendFile(join(dir, `${ID}.jsonl`), `${JSON.stringify(more)}\n`, "utf8");
    store.touch(ID);
    const map = await store.digests([ID]);
    assertSameDigest(map[ID]!, await expectedState(dir, ID), "增量");
    assert.deepEqual(digestChildActivity(map[ID]!), { toolName: "bash", input: { command: "ls" }, since: 1001 });
  });

  test("回退：追加 revert 记录后重算，摘要与生效视图一致", async () => {
    const u1 = user("第一句", 1000);
    await writeLog(dir, ID, [u1, assistant([{ type: "text", text: "回答 /w/x.md" }], 1001), fileTurn(["/w/x.md"], 1002)]);
    const before = await store.digests([ID]);
    assert.equal(digestOutputs(before[ID]!).length, 1);
    // 回退到 u1：u1 及之后全撤（界碑留下）
    await appendFile(join(dir, `${ID}.jsonl`), `${JSON.stringify(revert(u1.id, 1003))}\n`, "utf8");
    store.touch(ID);
    const after = await store.digests([ID]);
    assertSameDigest(after[ID]!, await expectedState(dir, ID), "回退");
    assert.equal(digestOutputs(after[ID]!).length, 0);
  });

  test("坏摘要文件：status.json 是垃圾 → 重算", async () => {
    await writeLog(dir, ID, [user("你好", 1000), assistant([{ type: "text", text: "你好" }], 1001)]);
    await writeFile(join(dir, `${ID}.status.json`), "not json{", "utf8");
    const map = await store.digests([ID]);
    assertSameDigest(map[ID]!, await expectedState(dir, ID), "坏文件");
  });

  test("摘要比日志旧（崩在落盘前）：重启后按 logOffset 增量补齐", async () => {
    await writeLog(dir, ID, [user("第一句", 1000)]);
    await store.digests([ID]);
    await store.flush(); // status.json 落盘（只覆盖第一句）
    // 模拟「追加落盘了但摘要没来得及折就崩了」：直接往日志里加，不 touch
    const more = assistant([toolCall("c7", "terminal_execute", { command: "bun dev" })], 1001);
    const moreResult = tool("c7", "terminal_execute", "complete", 1002, {
      input: { command: "bun dev" },
      content: [{ type: "text", text: "opened visible terminal term-9 (zsh)" }],
    });
    await appendFile(join(dir, `${ID}.jsonl`), `${JSON.stringify(more)}\n${JSON.stringify(moreResult)}\n`, "utf8");
    // 新 store（= 重启）：从 status.json 的 offset 补扫
    const reopened = new StatusDigestStore(dir, { persistDelayMs: 5 });
    const map = await reopened.digests([ID]);
    assertSameDigest(map[ID]!, await expectedState(dir, ID), "补扫");
    assert.deepEqual(digestTerminals(map[ID]!), [{ id: "term-9", command: "bun dev", since: 1002 }]);
    await reopened.flush();
  });

  test("空会话（有 meta 没日志）= 空摘要；连 meta 都没有 = null", async () => {
    await writeFile(join(dir, `${ID}.meta.json`), JSON.stringify({ id: ID, title: "新会话" }), "utf8");
    const map = await store.digests([ID, CHILD]);
    assert.notEqual(map[ID], null);
    assert.equal(map[ID]!.meta.records, 0);
    assert.equal(map[ID]!.meta.lastId, null);
    assert.equal(map[CHILD], null);
  });

  test("导入更新（日志整份替换）：invalidate 后重算", async () => {
    await writeLog(dir, ID, [user("旧内容", 1000), assistant([{ type: "text", text: "旧回答 /w/old.md" }], 1001), fileTurn(["/w/old.md"], 1002)]);
    const before = await store.digests([ID]);
    assert.equal(digestOutputs(before[ID]!).length, 1);
    await writeLog(dir, ID, [user("新内容", 2000)]);
    store.invalidate(ID);
    const after = await store.digests([ID]);
    assertSameDigest(after[ID]!, await expectedState(dir, ID), "替换");
    assert.equal(digestOutputs(after[ID]!).length, 0);
  });

  test("分支播种：seed 的摘要与全量折一致，之后的增量从播种偏移接着走", async () => {
    const prefix = [user("前缀", 1000), assistant([{ type: "text", text: "前缀回答" }], 1001)];
    const bytes = await writeLog(dir, ID, prefix);
    store.seed(ID, prefix, bytes);
    const seeded = await store.digests([ID]);
    assertSameDigest(seeded[ID]!, await expectedState(dir, ID), "播种");
    // 播种后继续写：增量补扫从播种偏移接着走
    const more = assistant([toolCall("c3", "read", { path: "/a" })], 1002);
    await appendFile(join(dir, `${ID}.jsonl`), `${JSON.stringify(more)}\n`, "utf8");
    store.touch(ID);
    const after = await store.digests([ID]);
    assertSameDigest(after[ID]!, await expectedState(dir, ID), "播种后增量");
  });

  test("删除：status.json 一并删掉", async () => {
    await writeLog(dir, ID, [user("你好", 1000)]);
    await store.digests([ID]);
    await store.flush();
    await stat(join(dir, `${ID}.status.json`)); // 在
    await store.remove(ID);
    await assert.rejects(stat(join(dir, `${ID}.status.json`)));
  });

  test("批量取：主会话与子会话一次取回；status.json 节流落盘", async () => {
    await writeLog(dir, ID, [user("母", 1000)]);
    await writeLog(dir, CHILD, [user("子", 1000), assistant([toolCall("c1", "bash", { command: "sleep 1" })], 1001)]);
    const map = await store.digests([ID, CHILD]);
    assertSameDigest(map[ID]!, await expectedState(dir, ID), "母");
    assertSameDigest(map[CHILD]!, await expectedState(dir, CHILD), "子");
    assert.deepEqual(digestChildActivity(map[CHILD]!), { toolName: "bash", input: { command: "sleep 1" }, since: 1001 });
    // 节流落盘：等定时器过去后 status.json 在盘上
    await new Promise((resolve) => setTimeout(resolve, 30));
    const onDisk = JSON.parse(await readFile(join(dir, `${CHILD}.status.json`), "utf8")) as { state: StatusDigestState };
    assertSameDigest(onDisk.state, await expectedState(dir, CHILD), "落盘");
  });
});
