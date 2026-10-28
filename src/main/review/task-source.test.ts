import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
    const byPath = new Map(list.entries.map((entry) => [basename(entry.path), entry]));
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
    const names = list.entries.map((entry) => basename(entry.path));
    assert.ok(names.includes("made.txt"));
    assert.equal(list.entries.find((entry) => entry.path.endsWith("made.txt"))?.restored, true);
    assert.ok(names.includes("gone.txt"));
    assert.equal(list.entries.find((entry) => entry.path.endsWith("gone.txt"))?.removed, 1);
  });

  test("没有轮尾账 → no-changes 空态", async () => {
    const list = await taskReviewList(store, ID);
    assert.deepEqual(list, { kind: "empty", reason: "no-changes", cwd: lab });
  });

  test("带 BOM 的文件：磁盘与基线字节一致 → 已还原，不出幽灵 diff（与 toSnapshot / diskText 同口径）", async () => {
    // 快照侧（file-tracker.toSnapshot）ignoreBOM 把 U+FEFF 留在正文里；磁盘读侧曾用
    // 默认 TextDecoder（剥 BOM），两边口径不一 → 首行永远“改了”、字节级还原后也判不成
    // 已还原（Windows 实机验收）。这里锁死：带 BOM 且未变的文件就是已还原。
    const bom = "\uFEFFalpha\r\nbeta\r\n";
    await writeFile(join(lab, "bom.cs"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("alpha\r\nbeta\r\n", "utf8")]));
    await turn("t1", [{ path: join(lab, "bom.cs"), before: bom, after: "\uFEFFalpha\r\nBETA\r\n" }]);
    // 磁盘 = 基线（字节级还原过）
    const list = await taskReviewList(store, ID);
    assert.equal(list.kind, "ok");
    if (list.kind !== "ok") return;
    const entry = list.entries.find((item) => item.path.endsWith("bom.cs"));
    assert.equal(entry?.restored, true);
    const diff = await taskReviewDiff(store, ID, join(lab, "bom.cs"));
    assert.equal(diff.restored, true);
    assert.equal(diff.diff, null);
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
    // 拒绝要说清楚：不在账上，而不是显示成「二进制」
    assert.equal(outside.error?.reason, "not-in-record");
    assert.equal(outside.binary, false);
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

// ————————————————————————————————————————————————
// 读盘边界：账上的路径事后被换成符号链接（指到账外、甚至根外），审查面板不跟过去读——
// 否则「本任务改动」就成了读任意文件的后门（文件账白名单只管路径，不管路径现在指向谁）。
// ————————————————————————————————————————————————
describe("task 来源 × 符号链接", () => {
  let outside = "";
  /** 这台机器建不了文件符号链接（Windows 未开开发者模式）：整组跳过 */
  let canLink = true;

  beforeEach(async () => {
    outside = await mkdtemp(join(tmpdir(), "orbita-task-outside-"));
    await writeFile(join(outside, "secret.txt"), "OUTSIDE-SECRET\n", "utf8");
    // 账：本任务新建了 notes.txt；事后它被换成指向根外的链接
    await turn("t1", [{ path: join(lab, "notes.txt"), before: null, after: "mine\n" }]);
    try {
      await symlink(join(outside, "secret.txt"), join(lab, "notes.txt"), "file");
    } catch {
      canLink = false;
    }
  });

  afterEach(async () => {
    await rm(outside, { recursive: true, force: true });
  });

  test("正文：不跟到目标读，回执标出链接指向哪", async (t) => {
    if (!canLink) return t.skip("这台机器建不了文件符号链接");
    const diff = await taskReviewDiff(store, ID, join(lab, "notes.txt"));
    assert.ok(!(diff.diff ?? "").includes("OUTSIDE-SECRET"), `跟着链接读到了根外：${diff.diff}`);
    assert.equal(diff.diff, null);
    assert.equal(diff.symlink, join(outside, "secret.txt"));
    assert.equal(diff.binary, false);
  });

  test("列表：链接标 symlink，行数不算目标的", async (t) => {
    if (!canLink) return t.skip("这台机器建不了文件符号链接");
    const list = await taskReviewList(store, ID);
    assert.equal(list.kind, "ok");
    if (list.kind !== "ok") return;
    const entry = list.entries.find((item) => item.path.endsWith("notes.txt"));
    assert.deepEqual(
      { added: entry?.added, removed: entry?.removed, symlink: entry?.symlink },
      { added: 0, removed: 0, symlink: join(outside, "secret.txt") },
    );
  });

  test("对照：链接换回普通文件，正文照常出", async (t) => {
    if (!canLink) return t.skip("这台机器建不了文件符号链接");
    await unlink(join(lab, "notes.txt"));
    await writeFile(join(lab, "notes.txt"), "mine\nmore\n", "utf8");
    const diff = await taskReviewDiff(store, ID, join(lab, "notes.txt"));
    assert.equal(diff.symlink, undefined);
    assert.ok(diff.diff?.includes("+more"), `普通文件被一起拦掉了：${JSON.stringify(diff)}`);
  });
});
