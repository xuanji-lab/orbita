import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMeta, SessionRecord } from "../../shared/session.ts";
import { SessionStore } from "../session/store.ts";
import { taskReviewDiff, taskReviewList } from "./task-source.ts";

const ID = "d2e3f4a5-6b70-4812-9c34-5d6e7f809213";

const meta = (cwd: string): SessionMeta => ({
  id: ID,
  title: "",
  titleSource: "derived",
  stats: null,
  cwd,
  providerId: "zai",
  modelId: "glm-5.3",
  mode: "plan",
  thinkingLevel: "medium",
  createdAt: 1000,
  updatedAt: 1000,
  workspaceId: null,
  piSessionFile: "/lab/pi.jsonl",
  pinned: false,
  archived: false,
  recentQueries: [],
});

function userItem(id: string, timestamp: number): SessionRecord {
  return { id, role: "user", content: [{ type: "text", text: "q" }], timestamp };
}

let dir = "";
let lab = "";
let store: SessionStore;

/** 落一轮文件账（before/after 走真实 blob 存储）。 */
async function turn(id: string, changes: { path: string; before: string | null; after: string | null }[]): Promise<void> {
  const persisted = [];
  for (const change of changes) {
    persisted.push({
      path: change.path,
      before: change.before === null ? { kind: "absent" as const } : { kind: "text" as const, blob: await store.snapshots.save(ID, change.before) },
      after: change.after === null ? { kind: "absent" as const } : { kind: "text" as const, blob: await store.snapshots.save(ID, change.after) },
      added: 1,
      removed: 0,
    });
  }
  await store.record(ID, { role: "file-turn", id, timestamp: Date.now(), changes: persisted });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-task-review-"));
  lab = join(dir, "lab");
  await mkdir(lab, { recursive: true });
  store = new SessionStore(join(dir, "sessions"));
  await store.ensureSession(meta(lab));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("taskReviewList", () => {
  test("基线 = 首次改前；现状与基线一致 → 已还原；新建未删 → 全量新增", async () => {
    await writeFile(join(lab, "a.ts"), "v0\n", "utf8"); // 首轮前
    await store.record(ID, userItem("u1", 1000));
    await turn("t1", [{ path: join(lab, "a.ts"), before: "v0\n", after: "v1\n" }]);
    await turn("t2", [{ path: join(lab, "new.md"), before: null, after: "brand\n" }]);
    // 磁盘：a.ts 已被还原回 v0（回退过）；new.md 还是 agent 写的样子
    await writeFile(join(lab, "a.ts"), "v0\n", "utf8");
    await writeFile(join(lab, "new.md"), "brand\n", "utf8");
    const list = await taskReviewList(store, ID);
    assert.equal(list.kind, "ok");
    if (list.kind !== "ok") return;
    const byPath = new Map(list.entries.map((entry) => [entry.path.split("/").pop() ?? "", entry]));
    assert.equal(byPath.get("a.ts")?.restored, true);
    assert.equal(byPath.get("new.md")?.added, 1);
    assert.equal(byPath.get("new.md")?.restored, undefined);
  });

  test("回退过的轮次也算「动过」：基线含已撤回轮次（readRawLog）", async () => {
    await store.record(ID, userItem("u1", 1000));
    await store.record(ID, { id: "a1", role: "assistant", content: [{ type: "text", text: "ok" }], model: { provider: "zai", id: "glm" }, timestamp: 1100, status: "complete", stopReason: "stop" } as SessionRecord);
    await turn("t1", [{ path: join(lab, "x.ts"), before: "x0\n", after: "x1\n" }]);
    await store.record(ID, userItem("u2", 2000));
    await store.record(ID, { id: "a2", role: "assistant", content: [{ type: "text", text: "ok" }], model: { provider: "zai", id: "glm" }, timestamp: 2100, status: "complete", stopReason: "stop" } as SessionRecord);
    // 模拟回退 u2：追加界碑（readLog 会折掉 u2 轮；readRawLog 不会）
    await store.record(ID, { role: "revert", id: "r1", targetMessageId: "u2", restored: [], timestamp: 3000 });
    await writeFile(join(lab, "x.ts"), "x0\n", "utf8");
    const list = await taskReviewList(store, ID);
    assert.equal(list.kind, "ok");
    if (list.kind !== "ok") return;
    assert.ok(list.entries.some((entry) => entry.path.endsWith("x.ts")));
  });

  test("任务里建过又删净 → 列出并标已还原；磁盘上被删（基线在）→ 全量删除", async () => {
    await turn("t1", [{ path: join(lab, "made.txt"), before: null, after: "x\n" }]);
    await turn("t2", [{ path: join(lab, "gone.txt"), before: "g0\n", after: "g1\n" }]);
    // made.txt 被删净（undo 删除）；gone.txt 被外部删了
    const list = await taskReviewList(store, ID);
    assert.equal(list.kind, "ok");
    if (list.kind !== "ok") return;
    const names = list.entries.map((entry) => entry.path.split("/").pop() ?? "");
    assert.ok(names.includes("made.txt"));
    assert.equal(list.entries.find((entry) => entry.path.endsWith("made.txt"))?.restored, true);
    assert.ok(names.includes("gone.txt"));
    assert.equal(list.entries.find((entry) => entry.path.endsWith("gone.txt"))?.removed, 1);
  });

  test("没有轮尾账 → no-changes 空态", async () => {
    const list = await taskReviewList(store, ID);
    assert.deepEqual(list, { kind: "empty", reason: "no-changes", cwd: lab });
  });
});

describe("taskReviewDiff", () => {
  test("账上的路径给 unified diff；不在账上的路径不给（不是读任意文件的后门）", async () => {
    await writeFile(join(lab, "a.ts"), "one\ntwo\n", "utf8");
    await turn("t1", [{ path: join(lab, "a.ts"), before: "one\n", after: "one\ntwo\n" }]);
    const inside = await taskReviewDiff(store, ID, join(lab, "a.ts"));
    assert.ok(inside.diff?.includes("+two"));
    const outside = await taskReviewDiff(store, ID, join(dir, "sessions", `${ID}.meta.json`));
    assert.equal(outside.diff, null);
  });

  test("基线与现状一致 → restored；二进制基线 → binary", async () => {
    await writeFile(join(lab, "same.txt"), "s\n", "utf8");
    await turn("t1", [{ path: join(lab, "same.txt"), before: "s\n", after: "s2\n" }]);
    await writeFile(join(lab, "same.txt"), "s\n", "utf8");
    const same = await taskReviewDiff(store, ID, join(lab, "same.txt"));
    assert.equal(same.restored, true);

    await writeFile(join(lab, "bin.png"), Buffer.from([0, 1]));
    await store.recordFileTurn(ID, [
      { path: join(lab, "bin.png"), before: { kind: "unrecoverable" }, after: { kind: "text", content: "x" }, added: 1, removed: 0 },
    ]);
    const bin = await taskReviewDiff(store, ID, join(lab, "bin.png"));
    assert.equal(bin.binary, true);
  });
});
