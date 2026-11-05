/**
 * show_plugin_board 在主进程的落地：清单 board 的解析、已装与草稿两种来源、越权路径拒绝、
 * 样例退回、repeat 展开、快照上限与截取、模板按哈希去重存储。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  BOARD_SNAPSHOT_CARD_MAX_BYTES,
  BOARD_SNAPSHOT_TOTAL_MAX_BYTES,
  parsePluginBoardDetails,
  type PluginBoardOutcome,
  type PluginBoardResult,
} from "../../shared/plugin-board.ts";
import { BoardTemplateStore, PluginBoards, boardFrameOf, templateHash } from "./board-snapshot.ts";
import { PanelFrames } from "./panel-frame.ts";
import type { PluginRecord } from "./records.ts";

let dir = "";
let installedRoot = "";
let dataRoot = "";
let workspace = "";
let outside = "";
let templatesDir = "";
let records: PluginRecord[] = [];
let enabled = true;

const T1 = "<!doctype html><p>today</p>";
const T2 = "<!doctype html><p>list</p>";

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

/** 一个带两张卡（today 用数据、papers 是 repeat）的插件文件夹 */
async function makePlugin(root: string, name: string, extra: Record<string, unknown> = {}): Promise<void> {
  await mkdir(join(root, "board"), { recursive: true });
  await writeFile(join(root, "board", "today.html"), T1);
  await writeFile(join(root, "board", "list.html"), T2);
  await writeJson(join(root, "board", "today.sample.json"), { title: "sample" });
  await writeJson(join(root, ".claude-plugin", "plugin.json"), {
    name,
    displayName: "文献追踪",
    orbita: {
      board: {
        title: "今日文献",
        cards: [
          { id: "today", title: "今日一篇", size: "1x1", template: "./board/today.html", data: "${CLAUDE_PLUGIN_DATA}/today.json", sample: "./board/today.sample.json" },
          { id: "papers", title: "候选", size: "2x1", template: "./board/list.html", data: "${CLAUDE_PLUGIN_DATA}/papers.json", repeat: "items" },
        ],
      },
      ...extra,
    },
  });
}

function record(name: string, scope: PluginRecord["scope"] = { kind: "global" }): PluginRecord {
  return {
    name,
    source: { kind: "link", path: installedRoot },
    version: "0.1.0",
    installedAt: 1,
    updatedAt: 1,
    scope,
    placement: { kind: "global" },
    config: {},
    secretKeys: [],
  };
}

function boards(): PluginBoards {
  return new PluginBoards({
    plugins: {
      records: async () => records,
      rootOf: () => installedRoot,
      dataDirOf: (name) => join(dataRoot, name),
    },
    templates: new BoardTemplateStore(templatesDir),
    enabled: async () => enabled,
    session: async (id) => (id === "s1" ? { cwd: workspace, workspaceId: "ws-1" } : id === "home" ? { cwd: join(dir, "home"), workspaceId: null } : null),
    workspaceRoot: async (id) => (id === "ws-1" ? workspace : null),
    now: () => 1_000,
  });
}

function ready(outcome: PluginBoardOutcome): PluginBoardResult {
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  if (!outcome.ok) throw new Error("unreachable");
  return outcome.board;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-board-"));
  installedRoot = join(dir, "installed", "lit");
  dataRoot = join(dir, "plugin-data");
  workspace = join(dir, "ws");
  outside = join(dir, "outside");
  templatesDir = join(dir, "userData", "board-templates");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(dir, "home"), { recursive: true });
  await makePlugin(installedRoot, "lit");
  records = [record("lit")];
  enabled = true;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("已装插件", () => {
  test("数据为空退回样例；repeat 卡没有数据 = 空态一张；模板存进仓库，快照只记哈希", async () => {
    const board = ready(await boards().snapshot({ sessionId: "s1", plugin: "lit", cards: null }));
    assert.equal(board.source, "installed");
    assert.equal(board.draftPath, null);
    assert.equal(board.title, "今日文献");
    assert.equal(board.displayName, "文献追踪");
    assert.equal(board.tuned, false);
    assert.equal(board.at, 1_000);
    assert.deepEqual(
      board.cards.map((card) => [card.id, card.index, card.state, card.usingSample, card.size]),
      [
        ["today", 0, "ready", true, "1x1"],
        ["papers", 0, "empty", false, "2x1"],
      ],
    );
    assert.deepEqual(board.cards[0]?.data, { title: "sample" });
    assert.equal(board.cards[0]?.template, templateHash(T1));
    assert.equal(await readFile(join(templatesDir, `${templateHash(T1)}.html`), "utf8"), T1);
    assert.deepEqual(board.skipped, []);
  });

  test("有数据用数据（带 mtime）；repeat 每项一张、data 是那一项", async () => {
    await writeJson(join(dataRoot, "lit", "today.json"), { title: "real" });
    await writeJson(join(dataRoot, "lit", "papers.json"), { items: [{ t: "a" }, { t: "b" }, { t: "c" }] });
    const board = ready(await boards().snapshot({ sessionId: "s1", plugin: "lit", cards: null }));
    const today = board.cards[0];
    assert.deepEqual(today?.data, { title: "real" });
    assert.equal(today?.usingSample, false);
    assert.equal(typeof today?.updatedAt, "number");
    assert.deepEqual(
      board.cards.filter((card) => card.id === "papers").map((card) => [card.index, card.data]),
      [
        [0, { t: "a" }],
        [1, { t: "b" }],
        [2, { t: "c" }],
      ],
    );
    // 三张展开卡共用同一份模板：仓库里只有两份文件
    assert.equal((await readdir(templatesDir)).length, 2);
  });

  test("cards 参数只取点名的卡；没有的 id 列进 skipped", async () => {
    const board = ready(await boards().snapshot({ sessionId: "s1", plugin: "lit", cards: ["papers", "nope"] }));
    assert.deepEqual(board.cards.map((card) => card.id), ["papers"]);
    assert.deepEqual(board.skipped, [{ id: "nope", reason: "unknown-card", detail: "nope" }]);
  });

  test("数据文件坏了：不拿样例盖过去，这张卡列进 skipped(data)", async () => {
    await mkdir(join(dataRoot, "lit"), { recursive: true });
    await writeFile(join(dataRoot, "lit", "today.json"), "{ broken");
    const board = ready(await boards().snapshot({ sessionId: "s1", plugin: "lit", cards: ["today"] }));
    assert.equal(board.cards.length, 0);
    assert.equal(board.skipped[0]?.reason, "data");
    assert.match(board.skipped[0]?.detail ?? "", /invalid-json/);
  });

  test("repeat 指的不是数组：skipped(repeat)", async () => {
    await writeJson(join(dataRoot, "lit", "papers.json"), { items: "x" });
    const board = ready(await boards().snapshot({ sessionId: "s1", plugin: "lit", cards: ["papers"] }));
    assert.deepEqual(board.skipped.map((skip) => skip.reason), ["repeat"]);
  });

  test("tuned 读清单 orbita.tuned", async () => {
    await makePlugin(installedRoot, "lit", { tuned: true });
    assert.equal(ready(await boards().snapshot({ sessionId: "s1", plugin: "lit", cards: null })).tuned, true);
  });

  test("没在这个工作区启用 / 没装 / 开关关着 / 会话没了：都以一句话拒", async () => {
    records = [record("lit", { kind: "workspaces", ids: ["ws-2"] })];
    const notEnabled = await boards().snapshot({ sessionId: "s1", plugin: "lit", cards: null });
    assert.equal(notEnabled.ok, false);
    assert.match(notEnabled.ok ? "" : notEnabled.error, /not enabled in this workspace/);
    records = [];
    const missing = await boards().snapshot({ sessionId: "s1", plugin: "lit", cards: null });
    assert.match(missing.ok ? "" : missing.error, /is not installed/);
    enabled = false;
    assert.equal((await boards().snapshot({ sessionId: "s1", plugin: "lit", cards: null })).ok, false);
    enabled = true;
    assert.equal((await boards().snapshot({ sessionId: "gone", plugin: "lit", cards: null })).ok, false);
  });

  test("插件没写 board：一句话说清楚", async () => {
    await writeJson(join(installedRoot, ".claude-plugin", "plugin.json"), { name: "lit" });
    const outcome = await boards().snapshot({ sessionId: "s1", plugin: "lit", cards: null });
    assert.match(outcome.ok ? "" : outcome.error, /orbita\.board/);
  });
});

describe("草稿", () => {
  test("按名字找到 <工作区>/plugins/<名字>/；数据目录按清单名字", async () => {
    records = [];
    const draft = join(workspace, "plugins", "draft-lit");
    await makePlugin(draft, "draft-lit");
    await writeJson(join(dataRoot, "draft-lit", "today.json"), { title: "draft data" });
    const board = ready(await boards().snapshot({ sessionId: "s1", plugin: "draft-lit", cards: ["today"] }));
    assert.equal(board.source, "draft");
    assert.equal(board.plugin, "draft-lit");
    assert.ok(board.draftPath?.endsWith(join("plugins", "draft-lit")));
    assert.deepEqual(board.cards[0]?.data, { title: "draft data" });
  });

  test("按路径（相对工作目录）也行", async () => {
    await makePlugin(join(workspace, "mine"), "mine");
    const board = ready(await boards().snapshot({ sessionId: "s1", plugin: "./mine", cards: ["today"] }));
    assert.equal(board.source, "draft");
    assert.equal(board.cards[0]?.usingSample, true);
  });

  test("越权路径拒绝：工作区外、.. 走出去、符号链接指出去", async () => {
    await makePlugin(outside, "evil");
    for (const plugin of [outside, "../outside"]) {
      const outcome = await boards().snapshot({ sessionId: "s1", plugin, cards: null });
      assert.equal(outcome.ok, false, plugin);
      assert.match(outcome.ok ? "" : outcome.error, /outside this session's workspace/);
    }
    await symlink(outside, join(workspace, "link"));
    const linked = await boards().snapshot({ sessionId: "s1", plugin: "./link", cards: null });
    assert.match(linked.ok ? "" : linked.error, /outside this session's workspace/);
  });

  test("模板路径逃出插件根：这张卡 skipped(template)，别的卡照常", async () => {
    const draft = join(workspace, "plugins", "esc");
    await makePlugin(draft, "esc");
    await writeFile(join(outside, "x.html"), "secret").catch(async () => {
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "x.html"), "secret");
    });
    const manifest = JSON.parse(await readFile(join(draft, ".claude-plugin", "plugin.json"), "utf8")) as { orbita: { board: { cards: { template: string }[] } } };
    const first = manifest.orbita.board.cards[0];
    if (first !== undefined) first.template = "../../../outside/x.html";
    await writeJson(join(draft, ".claude-plugin", "plugin.json"), manifest);
    const board = ready(await boards().snapshot({ sessionId: "s1", plugin: "esc", cards: null }));
    assert.deepEqual(board.skipped.map((skip) => [skip.id, skip.reason]), [["today", "template"]]);
    assert.deepEqual(board.cards.map((card) => card.id), ["papers"]);
  });

  test("数据路径逃出允许目录：skipped(data)", async () => {
    const draft = join(workspace, "plugins", "esc2");
    await makePlugin(draft, "esc2");
    const manifest = JSON.parse(await readFile(join(draft, ".claude-plugin", "plugin.json"), "utf8")) as { orbita: { board: { cards: { data: string }[] } } };
    const first = manifest.orbita.board.cards[0];
    if (first !== undefined) first.data = "/etc/hosts";
    await writeJson(join(draft, ".claude-plugin", "plugin.json"), manifest);
    const board = ready(await boards().snapshot({ sessionId: "s1", plugin: "esc2", cards: ["today"] }));
    assert.equal(board.skipped[0]?.reason, "data");
    assert.match(board.skipped[0]?.detail ?? "", /data-escape/);
  });

  test("Home 会话（没有工作区）找不到别处的草稿", async () => {
    records = [];
    const outcome = await boards().snapshot({ sessionId: "home", plugin: "draft-lit", cards: null });
    assert.equal(outcome.ok, false);
  });
});

describe("快照上限", () => {
  test("单张卡超 256 KB：skipped(too-large)，其余照常", async () => {
    const big = "x".repeat(BOARD_SNAPSHOT_CARD_MAX_BYTES);
    await writeJson(join(dataRoot, "lit", "today.json"), { big });
    await writeJson(join(dataRoot, "lit", "papers.json"), { items: [{ t: 1 }] });
    const board = ready(await boards().snapshot({ sessionId: "s1", plugin: "lit", cards: null }));
    assert.deepEqual(board.skipped.map((skip) => [skip.id, skip.reason]), [["today", "too-large"]]);
    assert.deepEqual(board.cards.map((card) => card.id), ["papers"]);
  });

  test("整份到 1 MB：放得下的放进去，放不下的 skipped(budget)", async () => {
    // 每项约 200 KB：前 5 项 = 1000 KB 放得下，第 6 项超 1 MB
    const item = { s: "y".repeat(200 * 1024 - 10) };
    await writeJson(join(dataRoot, "lit", "papers.json"), { items: Array.from({ length: 7 }, () => item) });
    const board = ready(await boards().snapshot({ sessionId: "s1", plugin: "lit", cards: ["papers"] }));
    const total = board.cards.reduce((sum, card) => sum + Buffer.byteLength(JSON.stringify(card.data)), 0);
    assert.ok(total <= BOARD_SNAPSHOT_TOTAL_MAX_BYTES);
    assert.equal(board.cards.length, 5);
    assert.deepEqual(board.skipped.map((skip) => skip.reason), ["budget", "budget"]);
  });

  test("repeat 展开超过 24 张：余下的一条 skipped(repeat) 说还有几项", async () => {
    await writeJson(join(dataRoot, "lit", "papers.json"), { items: Array.from({ length: 30 }, (_, i) => ({ i })) });
    const board = ready(await boards().snapshot({ sessionId: "s1", plugin: "lit", cards: null }));
    assert.equal(board.cards.length, 24);
    assert.equal(board.skipped.length, 1);
    assert.equal(board.skipped[0]?.reason, "repeat");
    assert.match(board.skipped[0]?.detail ?? "", /^7 more/);
  });

  test("结果能被 parsePluginBoardDetails 原样读回（会话落盘后重开）", async () => {
    await writeJson(join(dataRoot, "lit", "papers.json"), { items: [{ t: "a" }] });
    const board = ready(await boards().snapshot({ sessionId: "s1", plugin: "lit", cards: null }));
    const roundTrip = parsePluginBoardDetails(JSON.parse(JSON.stringify({ pluginBoard: board })));
    assert.deepEqual(roundTrip, board);
  });
});

describe("模板仓库", () => {
  test("同内容只写一次；读回校验哈希；哈希不合规 / 被改过回 null", async () => {
    const store = new BoardTemplateStore(templatesDir);
    const a = await store.put(T1);
    const b = await store.put(T1);
    assert.equal(a, b);
    assert.equal((await readdir(templatesDir)).length, 1);
    assert.equal(await store.read(a), T1);
    assert.equal(await store.read("../../etc/passwd"), null);
    assert.equal(await store.read("0".repeat(64)), null);
    await writeFile(join(templatesDir, `${a}.html`), "tampered");
    assert.equal(await store.read(a), null);
  });
});

describe("board:frame", () => {
  test("合规且在仓库里的哈希换一次性地址；别的都回 null", async () => {
    const store = new BoardTemplateStore(templatesDir);
    const frames = new PanelFrames();
    const hash = await store.put(T1);
    const ok = await boardFrameOf({ templates: store, frames }, { hash });
    assert.ok(ok !== null && ok.frameUrl.startsWith("orbita-panel://doc/"));
    for (const raw of [null, "x", { hash: 1 }, { hash: "../x" }, { hash: "f".repeat(64) }]) {
      assert.equal(await boardFrameOf({ templates: store, frames }, raw), null, JSON.stringify(raw));
    }
  });
});
