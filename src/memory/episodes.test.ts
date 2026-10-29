/**
 * 事件段状态机（episodes.ts）——准入判定、切段解析、落盘 / 搬移 / 归档的布局。
 * 纯模块直测（node --test）：临时目录当数据目录。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admissionOf,
  buildSegmentPrompt,
  EpisodeStore,
  openEpisode,
  parseOpenEpisode,
  parseSegmentReply,
  toMemoryEpisode,
  truncateEpisode,
} from "./episodes.ts";

const TURN = { turn: 3, at: 5000, userText: "继续刚才的", assistantText: "好的" };

function baseEpisode() {
  return openEpisode({
    sessionId: "s1",
    scopeId: "ws-1",
    turn: { turn: 1, at: 1000, userText: "第一轮", assistantText: "答一" },
    now: 1000,
  });
}

test("admissionOf：无开段 start；重复轮 ignore；间隔超 30 分钟 split；否则 classify", () => {
  assert.equal(admissionOf(null, TURN).kind, "start");
  const episode = { ...baseEpisode(), toTurn: 3 };
  assert.equal(admissionOf(episode, { turn: 3, at: 5000 }).kind, "ignore");
  assert.equal(admissionOf(episode, { turn: 2, at: 5000 }).kind, "ignore");
  assert.equal(admissionOf(episode, { turn: 4, at: 1000 + 31 * 60_000 }).kind, "split");
  assert.equal(admissionOf(episode, { turn: 4, at: 1000 + 29 * 60_000 }).kind, "classify");
});

test("parseSegmentReply：same/new 各自认账，读不懂回 null（调用方按 same）", () => {
  assert.equal(parseSegmentReply("same"), "same");
  assert.equal(parseSegmentReply("NEW"), "new");
  assert.equal(parseSegmentReply(" new "), "new");
  assert.equal(parseSegmentReply(""), null);
  assert.equal(parseSegmentReply("我觉得是同一个"), null);
});

test("buildSegmentPrompt：prev 取尾、next 取头，包在标签里", () => {
  const prompt = buildSegmentPrompt({ prevUser: "a".repeat(1000), nextUser: "b".repeat(1000) });
  assert.ok(prompt.includes("<prev>"));
  assert.ok(prompt.includes("<next>"));
  assert.ok(!prompt.includes("a".repeat(700)));
});

test("parseOpenEpisode：字段不齐当没有；extracted 宽松解读", () => {
  assert.equal(parseOpenEpisode({ episodeId: "ep_1" }), null);
  const full = parseOpenEpisode({
    ...baseEpisode(),
    extracted: undefined,
  });
  assert.notEqual(full, null);
  assert.deepEqual(full?.extracted, { fact: false, preference: false, insight: false });
});

test("EpisodeStore：开段原子写读；pending 搬移；归档只追加；坏文件当没有", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-memory-"));
  const store = new EpisodeStore(dir);
  assert.equal(await store.loadOpen("s1"), null);

  const episode = baseEpisode();
  await store.saveOpen(episode);
  const loaded = await store.loadOpen("s1");
  assert.deepEqual(loaded, episode);

  // 收尾搬进 pending（文件名 = episodeId，同一会话的下一段不占用）
  await store.savePending({ ...episode, extracted: { fact: true, preference: false, insight: false } });
  const pending = await store.loadPending(episode.episodeId);
  assert.equal(pending?.extracted.fact, true);
  assert.equal(pending?.extracted.preference, false);

  // 归档 + 删 pending
  await store.archive(toMemoryEpisode(episode));
  await store.removePending(episode.episodeId);
  assert.equal(await store.loadPending(episode.episodeId), null);
  const log = await readFile(join(dir, "episodes", "log.jsonl"), "utf8");
  assert.equal(log.trim().split("\n").length, 1);

  // listAll：开段与待提取段分桶；坏文件跳过
  await store.saveOpen(episode);
  await store.savePending(episode);
  const tokenPath = join(dir, "episodes", `${createHash("sha1").update("s1").digest("hex")}.json`);
  await writeFile(tokenPath, "不是 JSON", "utf8");
  const all = await store.listAll();
  assert.equal(all.open.length, 0); // s1 的开段文件坏了，跳过
  assert.equal(all.pending.length, 1);
  assert.ok(!existsSync(join(dir, "episodes", "pending", "log.jsonl")));
});

test("toMemoryEpisode：公开形状不带运行态（extracted）", () => {
  const episode = baseEpisode();
  const pub = toMemoryEpisode(episode);
  assert.equal(pub.episodeId, episode.episodeId);
  assert.equal("extracted" in pub, false);
});

test("truncateEpisode：回退点之后的轮截掉，水位（toTurn / lastAt）回落；截空回 null；没碰到的原样返回", () => {
  const episode = {
    ...baseEpisode(),
    toTurn: 3,
    lastAt: 3000,
    turns: [
      { turn: 1, at: 1000, userText: "一", assistantText: "答一" },
      { turn: 2, at: 2000, userText: "二", assistantText: "答二" },
      { turn: 3, at: 3000, userText: "三", assistantText: "答三" },
    ],
    extracted: { fact: true, preference: false, insight: false },
  };
  const cut = truncateEpisode(episode, 2);
  assert.notEqual(cut, null);
  assert.deepEqual(cut?.turns.map((turn) => turn.turn), [1]);
  assert.equal(cut?.toTurn, 1);
  assert.equal(cut?.lastAt, 1000);
  assert.equal(cut?.fromTurn, 1);
  assert.deepEqual(cut?.extracted, { fact: true, preference: false, insight: false }); // 记账不动
  assert.equal(cut?.episodeId, episode.episodeId);
  // 截完水位回落：重说的第 2 轮不再被 ignore
  assert.equal(admissionOf(cut, { turn: 2, at: 4000 }).kind, "classify");
  assert.equal(truncateEpisode(episode, 1), null);
  assert.equal(truncateEpisode(episode, 4), episode);
});

test("listPending：只读 pending/，不读各会话的开段文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-episodes-"));
  const store = new EpisodeStore(dir);
  const open = baseEpisode();
  await store.saveOpen(open);
  const pending = { ...baseEpisode(), sessionId: "s2" };
  await store.savePending(pending);
  const listed = await store.listPending();
  assert.deepEqual(listed.map((episode) => episode.episodeId), [pending.episodeId]);
});
