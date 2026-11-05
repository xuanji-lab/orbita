import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { PluginPreviewResult } from "../../shared/plugin.ts";
import { PANEL_ACTIONS_FILE_MAX_BYTES, PANEL_ACTIONS_MAX_PER_WINDOW, PANEL_DATA_MAX_BYTES, type PluginBoardSnapshot } from "../../shared/plugin-panel.ts";
import { BOARD_MAX_EXPANDED_CARDS } from "../../shared/plugin-board.ts";
import { PanelFrames } from "./panel-frame.ts";
import { PluginPanels, expandDecl, type PanelPluginSource } from "./panel-service.ts";
import type { PluginRecord } from "./records.ts";

/** 示例夹具：文献追踪的三张卡（今日一篇 2x1、本周新进 1x1、在追的主线 1x2），只在测试与自检里用，不进产品。 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "lit-tracker");

let dir = "";
let root = "";
let dataRoot = "";
let workspaceRoot = "";
let frames: PanelFrames;
let record: PluginRecord;
let panels: PluginPanels;
let now = Date.UTC(2026, 10, 5, 7, 30, 0);
let previewResult: PluginPreviewResult = { ok: false, error: { kind: "not-a-plugin" } };

function makeRecord(scope: PluginRecord["scope"]): PluginRecord {
  return {
    name: "lit-tracker",
    source: { kind: "link", path: root },
    version: "0.1.0",
    installedAt: 1,
    updatedAt: 1,
    scope,
    placement: { kind: "global" },
    config: {},
    secretKeys: [],
  };
}

function build(records: () => PluginRecord[]): PluginPanels {
  const source: PanelPluginSource = {
    records: async () => records(),
    rootOf: () => root,
    dataDirOf: (name) => join(dataRoot, name),
    preview: async () => previewResult,
  };
  return new PluginPanels({
    plugins: source,
    frames,
    workspaceRoot: async (id) => (id === "ws-1" ? workspaceRoot : null),
    now: () => now,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-panel-service-"));
  root = join(dir, "plugin");
  dataRoot = join(dir, "plugin-data");
  workspaceRoot = join(dir, "ws");
  await cp(FIXTURE, root, { recursive: true });
  await mkdir(join(dataRoot, "lit-tracker"), { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  frames = new PanelFrames();
  record = makeRecord({ kind: "global" });
  panels = build(() => [record]);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const todayFile = (): string => join(dataRoot, "lit-tracker", "today.json");
const actionsFile = (): string => join(dataRoot, "lit-tracker", "actions.jsonl");
const manifestFile = (folder = root): string => join(folder, ".claude-plugin", "plugin.json");
const bump = async (file: string, seconds = 5): Promise<void> => {
  const when = new Date(Date.now() + seconds * 1000);
  await utimes(file, when, when);
};

type Ready = Extract<PluginBoardSnapshot, { kind: "ready" }>;

async function loadReady(stamp: string | null = null): Promise<Ready> {
  const snapshot = await panels.load({ name: "lit-tracker", workspaceId: "ws-1", stamp });
  assert.equal(snapshot.kind, "ready", JSON.stringify(snapshot));
  if (snapshot.kind !== "ready") throw new Error("unreachable");
  return snapshot;
}

/** 把清单的 board 换成给定的（夹具的其它字段不动）。 */
async function writeBoard(folder: string, board: unknown, name = "lit-tracker"): Promise<void> {
  await mkdir(join(folder, ".claude-plugin"), { recursive: true });
  await writeFile(manifestFile(folder), JSON.stringify({ name, orbita: { board } }));
}

const card = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "c1",
  size: "1x1",
  template: "./board/week.html",
  ...extra,
});

const cardOf = (snapshot: Ready, key: string): Ready["cards"][number] => {
  const found = snapshot.cards.find((each) => each.key === key);
  assert.ok(found, `没有卡 ${key}：${snapshot.cards.map((each) => each.key).join(",")}`);
  return found;
};

describe("load 载入与轮询（按卡）", () => {
  test("夹具的三张卡：顺序、尺寸、各自一个一次性 iframe 地址，模板就是各自的 HTML；没数据用样例并标 usingSample", async () => {
    const first = await loadReady();
    assert.equal(first.title, "文献追踪");
    assert.deepEqual(first.cards.map((each) => [each.key, each.size, each.title]), [
      ["today", "2x1", "今日一篇"],
      ["week", "1x1", "本周新进"],
      ["lines", "1x2", "在追的主线"],
    ]);
    const urls = new Set(first.cards.map((each) => each.frameUrl));
    assert.equal(urls.size, 3, "一张卡一个地址");
    for (const each of first.cards) {
      assert.ok(each.frameUrl !== null && !each.broken);
      const served = frames.respond(each.frameUrl ?? "");
      assert.equal(served.status, 200);
      assert.equal(served.body, await readFile(join(root, "board", `${each.id}.html`), "utf8"));
      assert.equal(each.usingSample, true);
      assert.equal(each.data.kind, "ready");
    }
    assert.match(first.spec ?? "", /今日一篇/);
  });

  test("stamp 没变回 unchanged；某张卡的数据文件变了 → 只那张卡换数据、所有卡 frameUrl 为 null（保留 iframe）", async () => {
    const first = await loadReady();
    assert.deepEqual(await panels.load({ name: "lit-tracker", workspaceId: "ws-1", stamp: first.stamp }), { kind: "unchanged" });
    await writeFile(todayFile(), JSON.stringify({ date: "11/06", title: "T", venue: "V", why: "W" }));
    const second = await loadReady(first.stamp);
    assert.ok(second.cards.every((each) => each.frameUrl === null), "模板没变，不换 iframe");
    assert.equal(cardOf(second, "today").usingSample, false);
    assert.equal(cardOf(second, "week").usingSample, true);
    assert.notEqual(second.stamp, first.stamp);
    assert.deepEqual(await panels.load({ name: "lit-tracker", workspaceId: "ws-1", stamp: second.stamp }), { kind: "unchanged" });
  });

  test("只有改了模板的那张卡拿到新地址，旧地址已作废", async () => {
    const first = await loadReady();
    const template = join(root, "board", "week.html");
    await writeFile(template, "<p>v2</p>");
    await bump(template);
    const second = await loadReady(first.stamp);
    assert.equal(cardOf(second, "today").frameUrl, null);
    assert.equal(cardOf(second, "lines").frameUrl, null);
    const fresh = cardOf(second, "week").frameUrl;
    assert.ok(fresh !== null);
    assert.equal(frames.respond(fresh ?? "").body, "<p>v2</p>");
  });

  test("数据文件是 {} / [] / 空文件 / null 也算没有，退回样例；删掉数据文件回到样例", async () => {
    await writeFile(todayFile(), '{"title":"real"}');
    const real = await loadReady();
    assert.equal(cardOf(real, "today").usingSample, false);
    for (const empty of ["{}", "[]", "", "null"]) {
      await writeFile(todayFile(), empty);
      const snapshot = await loadReady(real.stamp);
      assert.equal(cardOf(snapshot, "today").usingSample, true, JSON.stringify(empty));
    }
    await rm(todayFile());
    assert.equal(cardOf(await loadReady(real.stamp), "today").usingSample, true);
  });

  test("数据超 2 MB / 写坏的 JSON：卡上给 problem，不拿样例盖过去，也不发给模板", async () => {
    await writeFile(todayFile(), `"${"x".repeat(PANEL_DATA_MAX_BYTES)}"`);
    const big = cardOf(await loadReady(), "today");
    assert.equal(big.usingSample, false);
    assert.equal(big.data.kind === "problem" && big.data.problem.kind, "too-large");
    await writeFile(todayFile(), '{"title": [');
    const bad = cardOf(await loadReady(), "today");
    assert.equal(bad.data.kind === "problem" && bad.data.problem.kind, "invalid-json");
  });

  test("不可用：没装 / 没在这个工作区启用 / 没有看板 / 只有已作废的 panel——各有原因，同一原因连着轮询回 unchanged", async () => {
    const missing = await panels.load({ name: "nope", workspaceId: "ws-1", stamp: null });
    assert.equal(missing.kind === "unavailable" && missing.reason, "not-installed");
    if (missing.kind === "unavailable") assert.deepEqual(await panels.load({ name: "nope", workspaceId: "ws-1", stamp: missing.stamp }), { kind: "unchanged" });

    record = makeRecord({ kind: "workspaces", ids: ["ws-2"] });
    const notEnabled = await panels.load({ name: "lit-tracker", workspaceId: "ws-1", stamp: null });
    assert.equal(notEnabled.kind === "unavailable" && notEnabled.reason, "not-enabled");

    record = makeRecord({ kind: "global" });
    await writeFile(manifestFile(), JSON.stringify({ name: "lit-tracker" }));
    const none = await panels.load({ name: "lit-tracker", workspaceId: "ws-1", stamp: null });
    assert.equal(none.kind === "unavailable" && none.reason, "no-board");

    await writeFile(manifestFile(), JSON.stringify({ name: "lit-tracker", orbita: { panel: { title: "x", template: "./a.html", data: "./b.json" } } }));
    const oldPanel = await panels.load({ name: "lit-tracker", workspaceId: "ws-1", stamp: null });
    assert.equal(oldPanel.kind === "unavailable" && oldPanel.reason, "no-board", "orbita.panel 已作废，不再渲染");
  });

  test("一张卡的模板缺失 / 逃逸：只那张卡 broken 并写明原因，别的卡照常", async () => {
    await writeBoard(root, {
      title: "t",
      cards: [card({ id: "ok" }), card({ id: "gone", template: "./board/nope.html" }), card({ id: "out", template: "../x.html" })],
    });
    const snapshot = await loadReady();
    assert.equal(cardOf(snapshot, "ok").broken, false);
    assert.ok(cardOf(snapshot, "ok").frameUrl !== null);
    assert.equal(cardOf(snapshot, "gone").broken, true);
    assert.equal(cardOf(snapshot, "gone").frameUrl, null);
    assert.equal(cardOf(snapshot, "gone").problems[0]?.kind, "template-missing");
    assert.equal(cardOf(snapshot, "out").problems[0]?.kind, "template-escape");
  });

  test("data 路径解析失败（Home 会话用了 ${workspaceFolder}）→ 那张卡 broken 写明原因，而不是显示成空态", async () => {
    await writeBoard(root, { title: "t", cards: [card({ data: "${workspaceFolder}/p.json" })] });
    const home = await panels.load({ name: "lit-tracker", workspaceId: null, stamp: null });
    assert.equal(home.kind, "ready");
    if (home.kind === "ready") {
      assert.equal(home.cards[0]?.broken, true);
      assert.deepEqual(home.cards[0]?.problems, [{ kind: "data-needs-workspace", detail: "workspaceFolder" }]);
    }
    assert.equal(cardOf(await loadReady(), "c1").broken, false);
  });

  test("data 放在插件根之内（${CLAUDE_PLUGIN_ROOT}/data/x.json）→ 读得到", async () => {
    await writeBoard(root, { title: "t", cards: [card({ data: "${CLAUDE_PLUGIN_ROOT}/data/x.json" })] });
    await mkdir(join(root, "data"), { recursive: true });
    const empty = await loadReady();
    assert.deepEqual(cardOf(empty, "c1").data, { kind: "empty" }, "文件还没有 = 空态，不是错误");
    await writeFile(join(root, "data", "x.json"), '{"added":3}');
    const filled = await loadReady(empty.stamp);
    assert.equal(cardOf(filled, "c1").data.kind, "ready");
  });

  test("data 指到插件目录之外（模板想读别的文件）→ 那张卡 broken，不读", async () => {
    await writeFile(join(dir, "secret.json"), '{"secret":true}');
    await writeBoard(root, { title: "t", cards: [card({ data: join(dir, "secret.json") })] });
    const snapshot = await loadReady();
    assert.equal(cardOf(snapshot, "c1").broken, true);
    assert.equal(cardOf(snapshot, "c1").problems[0]?.kind, "data-escape");
    assert.deepEqual(cardOf(snapshot, "c1").data, { kind: "empty" });
  });

  test("改说明 / 改样例都会让 stamp 变；spec / sample 写得不对：卡照常出，原因进 problems", async () => {
    const first = await loadReady();
    await writeFile(join(root, "board", "spec.md"), "# 改过了");
    await bump(join(root, "board", "spec.md"));
    const afterSpec = await loadReady(first.stamp);
    assert.equal(afterSpec.spec, "# 改过了");
    assert.ok(afterSpec.cards.every((each) => each.frameUrl === null));
    await writeFile(join(root, "board", "week.sample.json"), '{"added":99,"must":0,"marked":0}');
    await bump(join(root, "board", "week.sample.json"), 9);
    const afterSample = await loadReady(afterSpec.stamp);
    assert.equal((cardOf(afterSample, "week").data as { value: { added: number } }).value.added, 99);

    await writeBoard(root, { title: "t", spec: "../out.md", cards: [card({ sample: "./nope.json" })] });
    const bad = await loadReady();
    assert.equal(bad.spec, null);
    assert.deepEqual(bad.problems.map((problem) => problem.kind), ["spec-escape"]);
    assert.deepEqual(cardOf(bad, "c1").problems.map((problem) => problem.kind), ["sample-missing"]);
    assert.equal(cardOf(bad, "c1").broken, false);
  });

  test("同一份数据文件的缓存：签名没变不重读，改了才重读（stamp 同、内容换了不会漏）", async () => {
    await writeFile(todayFile(), '{"title":"A"}');
    const first = await loadReady();
    await writeFile(todayFile(), '{"title":"B"}');
    await bump(todayFile());
    const second = await loadReady(first.stamp);
    assert.deepEqual((cardOf(second, "today").data as { value: unknown }).value, { title: "B" });
  });
});

describe("repeat 展开", () => {
  const items = { items: [{ n: 1 }, { n: 2 }, { n: 3 }] };

  test("data 里数组的每一项各一张同尺寸卡：data = 那一项，index = 下标，key = id#index，各自一个 iframe 地址", async () => {
    await writeBoard(root, { title: "t", cards: [card({ id: "paper", size: "1x2", data: "${CLAUDE_PLUGIN_DATA}/p.json", repeat: "items" })] });
    await writeFile(join(dataRoot, "lit-tracker", "p.json"), JSON.stringify(items));
    const snapshot = await loadReady();
    assert.deepEqual(snapshot.cards.map((each) => [each.key, each.index, each.size]), [["paper#0", 0, "1x2"], ["paper#1", 1, "1x2"], ["paper#2", 2, "1x2"]]);
    assert.deepEqual(snapshot.cards.map((each) => (each.data as { value: unknown }).value), items.items);
    assert.equal(new Set(snapshot.cards.map((each) => each.frameUrl)).size, 3);
  });

  test("多一项：只新来的那张拿新地址，已有的保留 iframe；少一项：卡数减少", async () => {
    await writeBoard(root, { title: "t", cards: [card({ id: "paper", data: "${CLAUDE_PLUGIN_DATA}/p.json", repeat: "items" })] });
    const file = join(dataRoot, "lit-tracker", "p.json");
    await writeFile(file, JSON.stringify(items));
    const first = await loadReady();
    await writeFile(file, JSON.stringify({ items: [...items.items, { n: 4 }] }));
    await bump(file);
    const grown = await loadReady(first.stamp);
    assert.deepEqual(grown.cards.map((each) => each.frameUrl === null), [true, true, true, false]);
    await writeFile(file, JSON.stringify({ items: [{ n: 1 }] }));
    await bump(file, 9);
    const shrunk = await loadReady(grown.stamp);
    assert.equal(shrunk.cards.length, 1);
  });

  test("没数据时用样例的数组展开并标 usingSample；样例和数据都没有 → 一张占位卡（data 为 empty），数组是空的也一样", async () => {
    await writeBoard(root, { title: "t", cards: [card({ id: "paper", sample: "./s.json", repeat: "items" })] });
    await writeFile(join(root, "s.json"), JSON.stringify(items));
    const sampled = await loadReady();
    assert.equal(sampled.cards.length, 3);
    assert.ok(sampled.cards.every((each) => each.usingSample));

    await writeBoard(root, { title: "t", cards: [card({ id: "paper", data: "${CLAUDE_PLUGIN_DATA}/none.json", repeat: "items" })] });
    const placeholder = await loadReady();
    assert.deepEqual(placeholder.cards.map((each) => [each.key, each.data.kind]), [["paper#0", "empty"]]);
    await writeFile(join(dataRoot, "lit-tracker", "none.json"), '{"items":[]}');
    assert.equal((await loadReady()).cards.length, 1);
  });

  test("repeat 的属性不是数组：这块声明不出卡，原因进看板级 problems", async () => {
    await writeBoard(root, { title: "t", cards: [card({ id: "paper", data: "${CLAUDE_PLUGIN_DATA}/p.json", repeat: "items" }), card({ id: "other" })] });
    await writeFile(join(dataRoot, "lit-tracker", "p.json"), '{"items":"nope"}');
    const snapshot = await loadReady();
    assert.deepEqual(snapshot.cards.map((each) => each.key), ["other"]);
    assert.deepEqual(snapshot.problems, [{ kind: "repeat-not-array", detail: "items" }]);
  });

  test(`展开后整块最多 ${BOARD_MAX_EXPANDED_CARDS} 张，多的丢掉并报 repeat-limit`, async () => {
    await writeBoard(root, { title: "t", cards: [card({ id: "paper", data: "${CLAUDE_PLUGIN_DATA}/p.json", repeat: "items" }), card({ id: "tail" })] });
    await writeFile(join(dataRoot, "lit-tracker", "p.json"), JSON.stringify({ items: Array.from({ length: 30 }, (_, n) => ({ n })) }));
    const snapshot = await loadReady();
    assert.equal(snapshot.cards.length, BOARD_MAX_EXPANDED_CARDS);
    assert.ok(snapshot.problems.some((problem) => problem.kind === "repeat-limit"));
  });

  test("expandDecl 纯函数：不带 repeat = 一张整份；样例问题挂在卡上", () => {
    const decl = { id: "a", title: "a", size: "1x1", note: null, template: "t", data: null, sample: null, repeat: null } as const;
    const plain = expandDecl({ decl }, { data: { kind: "ready", value: { x: 1 }, updatedAt: 1 }, usingSample: false, problems: [] });
    assert.deepEqual(plain.cards, [{ index: 0, data: { kind: "ready", value: { x: 1 }, updatedAt: 1 }, usingSample: false }]);
  });
});

describe("loadDraftBoard 草稿预览（看板）", () => {
  let draft = "";
  beforeEach(async () => {
    draft = join(workspaceRoot, "plugins", "lit-draft");
    await cp(FIXTURE, draft, { recursive: true });
    const manifest = JSON.parse(await readFile(manifestFile(draft), "utf8")) as Record<string, unknown>;
    await writeFile(manifestFile(draft), JSON.stringify({ ...manifest, name: "lit-draft" }));
    // 草稿没装：records 里没有它
    panels = build(() => []);
  });

  const loadDraft = (path: string, workspaceId: string | null = "ws-1", stamp: string | null = null): Promise<PluginBoardSnapshot> =>
    panels.loadDraftBoard({ path, workspaceId, stamp });

  test("绝对路径与相对工作区根的路径都行：样例渲染 + 同一套 iframe 协议", async () => {
    for (const path of [draft, "plugins/lit-draft", "./plugins/lit-draft/"]) {
      const snapshot = await loadDraft(path);
      assert.equal(snapshot.kind, "ready", path);
      if (snapshot.kind !== "ready") continue;
      assert.equal(snapshot.cards.length, 3);
      assert.ok(snapshot.cards.every((each) => each.usingSample && each.frameUrl !== null && frames.respond(each.frameUrl).status === 200));
    }
  });

  test("轮询：stamp 没变回 unchanged；agent 往（装上之后的）数据目录写出真数据 → 换成真数据", async () => {
    const first = await loadDraft(draft);
    assert.equal(first.kind, "ready");
    if (first.kind !== "ready") return;
    assert.deepEqual(await loadDraft(draft, "ws-1", first.stamp), { kind: "unchanged" });
    await mkdir(join(dataRoot, "lit-draft"), { recursive: true });
    await writeFile(join(dataRoot, "lit-draft", "today.json"), '{"title":"P9"}');
    const second = await loadDraft(draft, "ws-1", first.stamp);
    assert.equal(second.kind, "ready");
    if (second.kind !== "ready") return;
    assert.equal(cardOf(second, "today").usingSample, false);
    assert.equal(cardOf(second, "today").frameUrl, null);
  });

  test("工作区之外一律拒（不管那里有没有东西）：绝对路径、`..`、同名前缀的兄弟目录", async () => {
    const sibling = `${workspaceRoot}-evil`;
    await cp(FIXTURE, join(sibling, "p"), { recursive: true });
    await cp(FIXTURE, join(dir, "outside-plugin"), { recursive: true });
    const outsiders = [join(dir, "outside-plugin"), "../outside-plugin", "plugins/../../outside-plugin", join(sibling, "p"), "../ws-evil/p", "/etc", dir, join(dir, "no-such-place"), "../no-such-place"];
    for (const path of outsiders) {
      const snapshot = await loadDraft(path);
      assert.equal(snapshot.kind === "unavailable" && snapshot.reason, "outside-workspace", path);
      const view = await panels.loadDraftView({ path, workspaceId: "ws-1", stamp: null });
      assert.equal(view.kind === "unavailable" && view.reason, "outside-workspace", `view ${path}`);
    }
  });

  test("符号链接走出工作区：目录链接、指向工作区外插件的链接都拒", async () => {
    await cp(FIXTURE, join(dir, "outside-plugin"), { recursive: true });
    await symlink(join(dir, "outside-plugin"), join(workspaceRoot, "sneaky"));
    await mkdir(join(workspaceRoot, "plugins", "viaDir"), { recursive: true });
    await symlink(dir, join(workspaceRoot, "plugins", "viaDir", "up"));
    for (const path of ["sneaky", "plugins/viaDir/up/outside-plugin"]) {
      const snapshot = await loadDraft(path);
      assert.equal(snapshot.kind === "unavailable" && snapshot.reason, "outside-workspace", path);
    }
  });

  test("会话不在工作区（Home / 未知 id）、路径含 NUL：outside-workspace", async () => {
    for (const workspaceId of [null, "ws-unknown"]) {
      assert.equal((await loadDraft(draft, workspaceId)).kind === "unavailable", true, String(workspaceId));
    }
    const nul = await loadDraft(`plugins/lit-draft\u0000/../../..`);
    assert.equal(nul.kind === "unavailable" && nul.reason, "outside-workspace");
  });

  test("工作区里的路径不存在 / 是个文件：not-found；同一原因连着轮询回 unchanged", async () => {
    const missing = await loadDraft("plugins/not-yet");
    assert.equal(missing.kind === "unavailable" && missing.reason, "not-found");
    if (missing.kind === "unavailable") assert.deepEqual(await loadDraft("plugins/not-yet", "ws-1", missing.stamp), { kind: "unchanged" });
    await writeFile(join(workspaceRoot, "plugins", "a-file"), "x");
    const file = await loadDraft("plugins/a-file");
    assert.equal(file.kind === "unavailable" && file.reason, "not-found");
  });

  test("还没有看板（没清单 / 清单没声明 / 清单写到一半）：no-board，写出来之后下一次轮询就出现", async () => {
    await mkdir(join(workspaceRoot, "plugins", "early", ".claude-plugin"), { recursive: true });
    const bare = await loadDraft("plugins/early");
    assert.equal(bare.kind === "unavailable" && bare.reason, "no-board");
    await writeFile(manifestFile(join(workspaceRoot, "plugins", "early")), '{"name":"early"');
    const broken = await loadDraft("plugins/early", "ws-1", bare.kind === "unavailable" ? bare.stamp : null);
    assert.equal(broken.kind, "unchanged", "写到一半的清单按「还没有看板」，同一原因不重发");
    await writeBoard(join(workspaceRoot, "plugins", "early"), { title: "t", cards: [card({ template: "./t.html" })] }, "early");
    await writeFile(join(workspaceRoot, "plugins", "early", "t.html"), "<p>t</p>");
    assert.equal((await loadDraft("plugins/early")).kind, "ready");
  });

  test("草稿里模板 / data 逃逸照拒（卡 broken）", async () => {
    await writeBoard(draft, { title: "t", cards: [card({ id: "a", template: "../../../outside.html" }), card({ id: "b", data: join(dir, "secret.json") })] }, "lit-draft");
    const snapshot = await loadDraft(draft);
    assert.equal(snapshot.kind, "ready");
    if (snapshot.kind !== "ready") return;
    assert.equal(cardOf(snapshot, "a").problems[0]?.kind, "template-escape");
    assert.equal(cardOf(snapshot, "b").problems[0]?.kind, "data-escape");
  });

  test("草稿清单里的名字不合规：数据目录退回文件夹名，再不行退回草稿自己的 data/（路径穿越进不来）", async () => {
    const odd = join(workspaceRoot, "plugins", "Odd Name");
    await cp(FIXTURE, odd, { recursive: true });
    await writeBoard(odd, { title: "t", cards: [card({ template: "./board/week.html", data: "${CLAUDE_PLUGIN_DATA}/w.json" })] }, "../../x");
    await mkdir(join(odd, "data"), { recursive: true });
    await writeFile(join(odd, "data", "w.json"), '{"added":7}');
    const snapshot = await loadDraft(odd);
    assert.equal(snapshot.kind, "ready");
    assert.equal(snapshot.kind === "ready" && snapshot.cards[0]?.data.kind, "ready", "读的是草稿根下的 data/w.json");
  });

  test("loadDraftView：把预览结果投成 PluginView（草稿没有范围 / 安装记录）；内容没变回 unchanged；空文件夹给一张空页", async () => {
    const empty = await panels.loadDraftView({ path: "plugins/lit-draft", workspaceId: "ws-1", stamp: null });
    assert.equal(empty.kind, "ready", "预览失败（not-a-plugin）也给一张空页");
    if (empty.kind !== "ready") return;
    assert.equal(empty.view.name, "lit-draft");
    assert.deepEqual(empty.view.scope, { kind: "off" });
    assert.equal(empty.view.install, null);
    assert.equal(empty.view.board, null);
    assert.deepEqual(await panels.loadDraftView({ path: "plugins/lit-draft", workspaceId: "ws-1", stamp: empty.stamp }), { kind: "unchanged" });
  });
});

describe("action 动作回传", () => {
  test("追加一行 {at, action, payload}：at 是 ISO UTC 字符串，每次一行", async () => {
    assert.deepEqual(await panels.action({ name: "lit-tracker", action: "feedback", payload: { pid: "P0181", verdict: "useful" } }), { ok: true });
    now += 1000;
    assert.deepEqual(await panels.action({ name: "lit-tracker", action: "feedback", payload: { pid: "P0001", verdict: "irrelevant" } }), { ok: true });
    const lines = (await readFile(actionsFile(), "utf8")).split("\n").filter((line) => line !== "");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0] ?? ""), { at: "2026-11-05T07:30:00.000Z", action: "feedback", payload: { pid: "P0181", verdict: "useful" } });
    assert.equal((JSON.parse(lines[1] ?? "") as { at: string }).at, "2026-11-05T07:30:01.000Z");
  });

  test("校验：动作名空 / 超 64 字符、载荷超 16 KB / 不能序列化——拒绝且不落盘", async () => {
    assert.deepEqual(await panels.action({ name: "lit-tracker", action: "", payload: null }), { ok: false, reason: "invalid" });
    assert.deepEqual(await panels.action({ name: "lit-tracker", action: "x".repeat(65), payload: null }), { ok: false, reason: "action-too-long" });
    assert.deepEqual(await panels.action({ name: "lit-tracker", action: "a", payload: "x".repeat(16 * 1024) }), { ok: false, reason: "payload-too-large" });
    assert.deepEqual(await panels.action({ name: "lit-tracker", action: "a", payload: 1n }), { ok: false, reason: "invalid" });
    assert.deepEqual(await panels.action({ name: "lit-tracker", action: 7 as unknown as string, payload: null }), { ok: false, reason: "invalid" });
    await assert.rejects(readFile(actionsFile(), "utf8"), { code: "ENOENT" });
  });

  test("带 card：落进日志的 card 字段是 {id, index}；card 形状不对拒绝且不落盘", async () => {
    assert.deepEqual(await panels.action({ name: "lit-tracker", action: "feedback", payload: 1, card: { id: "today", index: 0 } }), { ok: true });
    const line = JSON.parse((await readFile(actionsFile(), "utf8")).trim()) as { card: unknown };
    assert.deepEqual(line.card, { id: "today", index: 0 });
    for (const card of [{ id: "Bad Id", index: 0 }, { id: "today", index: -1 }, { id: "today", index: 1.5 }, { id: "today", index: 5000 }, { id: "", index: 0 }]) {
      assert.deepEqual(await panels.action({ name: "lit-tracker", action: "a", payload: null, card }), { ok: false, reason: "invalid" }, JSON.stringify(card));
    }
    assert.equal((await readFile(actionsFile(), "utf8")).split("\n").filter((x) => x !== "").length, 1);
  });

  test("插件没装 / 已停用：unavailable，不替别人的目录写文件", async () => {
    assert.deepEqual(await panels.action({ name: "nope", action: "a", payload: null }), { ok: false, reason: "unavailable" });
    record = makeRecord({ kind: "off" });
    assert.deepEqual(await panels.action({ name: "lit-tracker", action: "a", payload: null }), { ok: false, reason: "unavailable" });
  });

  test("限速：10 秒窗口内最多 20 条，第 21 条 too-fast 且不落盘；窗口过去后恢复", async () => {
    for (let index = 0; index < PANEL_ACTIONS_MAX_PER_WINDOW; index += 1) {
      assert.equal((await panels.action({ name: "lit-tracker", action: "a", payload: index })).ok, true);
    }
    assert.deepEqual(await panels.action({ name: "lit-tracker", action: "a", payload: 99 }), { ok: false, reason: "too-fast" });
    assert.equal((await readFile(actionsFile(), "utf8")).split("\n").filter((line) => line !== "").length, PANEL_ACTIONS_MAX_PER_WINDOW);
    now += 10_001;
    assert.equal((await panels.action({ name: "lit-tracker", action: "a", payload: 100 })).ok, true);
  });

  test("日志满了（4 MB）拒绝再追加：file-full", async () => {
    await writeFile(actionsFile(), `${"x".repeat(PANEL_ACTIONS_FILE_MAX_BYTES - 10)}\n`);
    assert.deepEqual(await panels.action({ name: "lit-tracker", action: "a", payload: "y".repeat(100) }), { ok: false, reason: "file-full" });
  });

  test("落盘顺序 = 到达顺序：并发发出的动作不会因为各自读记录的快慢而换位", async () => {
    const results = await Promise.all(Array.from({ length: 15 }, (_, index) => panels.action({ name: "lit-tracker", action: "seq", payload: index })));
    assert.ok(results.every((result) => result.ok));
    const order = (await readFile(actionsFile(), "utf8")).split("\n").filter((line) => line !== "").map((line) => (JSON.parse(line) as { payload: number }).payload);
    assert.deepEqual(order, Array.from({ length: 15 }, (_, index) => index));
  });

  test("并发的 30 次点击（限速之内的先放进 20 条）：每行都是完整 JSON，不穿插", async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, index) => panels.action({ name: "lit-tracker", action: "feedback", payload: { index, pad: "p".repeat(2000) } })),
    );
    assert.equal(results.filter((result) => result.ok).length, PANEL_ACTIONS_MAX_PER_WINDOW);
    const lines = (await readFile(actionsFile(), "utf8")).split("\n").filter((line) => line !== "");
    assert.equal(lines.length, PANEL_ACTIONS_MAX_PER_WINDOW);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  });
});

