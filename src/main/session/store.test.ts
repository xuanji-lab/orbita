import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { SessionStore } from "./store.ts";
import type { SessionMeta } from "../../shared/session.ts";

const ID = "a7f3c1d2-4b8e-4f21-9c3a-0d1e2f3a4b5c";
const OTHER = "b1c2d3e4-5f60-4a71-8b92-0c1d2e3f4a5b";

const meta = (patch: Partial<SessionMeta> = {}): SessionMeta => ({
  id: ID,
  title: "",
  cwd: "/repo/orbita-lab",
  providerId: "zai",
  modelId: "glm-5.3",
  mode: "plan",
  createdAt: 1000,
  updatedAt: 1000,
  ...patch,
});

const userItem = (text: string, timestamp = 2000): TranscriptItem => ({
  id: "u1",
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
});

const assistantItem = (text: string, timestamp = 3000): TranscriptItem => ({
  id: "a1",
  role: "assistant",
  content: [{ type: "text", text }],
  model: { provider: "zai", id: "glm-5.3" },
  timestamp,
  status: "complete",
  stopReason: "stop",
});

let dir = "";
let store: SessionStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-session-"));
  store = new SessionStore(join(dir, "sessions"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SessionStore", () => {
  test("目录还不存在时列表是空的，不抛", async () => {
    assert.deepEqual(await store.list(), []);
  });

  test("建了就能列出来、能读回来", async () => {
    await store.create(meta());
    assert.deepEqual((await store.list()).map((m) => m.id), [ID]);
    assert.deepEqual((await store.load(ID))?.meta.id, ID);
    assert.deepEqual((await store.load(ID))?.transcript, []);
  });

  test("记一条就追加一行，并把 updatedAt 推到那条的时间", async () => {
    await store.create(meta());
    await store.record(ID, userItem("重做外壳"));
    await store.record(ID, assistantItem("好的"));
    const detail = await store.load(ID);
    assert.equal(detail?.transcript.length, 2);
    assert.equal(detail?.meta.updatedAt, 3000);
  });

  test("标题取第一条用户消息，之后不再改——否则会话会在侧栏里改名", async () => {
    await store.create(meta());
    await store.record(ID, userItem("第一句"));
    await store.record(ID, userItem("第二句", 4000));
    assert.equal((await store.load(ID))?.meta.title, "第一句");
  });

  test("assistant 消息不当标题用", async () => {
    await store.create(meta());
    await store.record(ID, assistantItem("我先说话"));
    assert.equal((await store.load(ID))?.meta.title, "");
  });

  test("列表按 updatedAt 倒序——新的在前", async () => {
    await store.create(meta({ id: ID, updatedAt: 1000 }));
    await store.create(meta({ id: OTHER, updatedAt: 5000 }));
    assert.deepEqual((await store.list()).map((m) => m.id), [OTHER, ID]);
  });

  test("meta 坏了就跳过这条，不让一条坏记录挡住整张列表", async () => {
    await store.create(meta({ id: ID }));
    await writeFile(join(dir, "sessions", `${OTHER}.meta.json`), "{ 这不是 JSON", "utf8");
    assert.deepEqual((await store.list()).map((m) => m.id), [ID]);
  });

  // 只追加的文件断电时最后一行可能只写了一半
  test("日志里的半截行跳过，前面读到的照常返回", async () => {
    await store.create(meta());
    await store.record(ID, userItem("完整的一行"));
    await writeFile(join(dir, "sessions", `${ID}.jsonl`), '{"id":"u1","role":"user"', { flag: "a" });
    const detail = await store.load(ID);
    assert.equal(detail?.transcript.length, 1);
  });

  test("meta 不在就不往日志里加，避免长出孤儿日志", async () => {
    await store.record(ID, userItem("没有会话"));
    assert.deepEqual(await readdir(join(dir, "sessions")).catch(() => []), []);
  });

  test("删掉两个文件都清干净", async () => {
    await store.create(meta());
    await store.record(ID, userItem("x"));
    await store.remove(ID);
    assert.deepEqual(await readdir(join(dir, "sessions")), []);
    assert.equal(await store.load(ID), null);
  });

  test("setMode 落盘——重开会话不该静默换档", async () => {
    await store.create(meta());
    await store.setMode(ID, "skip");
    assert.equal((await store.load(ID))?.meta.mode, "skip");
  });

  // id 从 renderer 经 IPC 进来，直接拼路径的话一个 ../../ 就能写到别处
  test("非法 id 一律拒绝，不落在 sessions 目录之外", async () => {
    for (const bad of ["../../etc/passwd", "..", "a/b", "", "not-a-uuid", `${ID}/../x`]) {
      await assert.rejects(() => store.create(meta({ id: bad })), /invalid session id/);
      await assert.rejects(() => store.remove(bad), /invalid session id/);
    }
  });

  test("原子写不留临时文件", async () => {
    await store.create(meta());
    await store.record(ID, userItem("x"));
    const names = await readdir(join(dir, "sessions"));
    assert.deepEqual(names.filter((n) => n.endsWith(".tmp")), []);
  });

  test("日志是一行一条 JSON，人能直接读", async () => {
    await store.create(meta());
    await store.record(ID, userItem("看得懂吗"));
    const raw = await readFile(join(dir, "sessions", `${ID}.jsonl`), "utf8");
    assert.equal(raw.trimEnd().split("\n").length, 1);
    assert.equal(JSON.parse(raw.trim()).role, "user");
  });
});
