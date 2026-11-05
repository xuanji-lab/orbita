import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  PANEL_ACTIONS_FILE_MAX_BYTES,
  PANEL_ACTIONS_MAX_PER_WINDOW,
  PANEL_DATA_MAX_BYTES,
  type PluginPanelSnapshot,
} from "../../shared/plugin-panel.ts";
import { PanelFrames } from "./panel-frame.ts";
import { PluginPanels, type PanelPluginSource } from "./panel-service.ts";
import type { PluginRecord } from "./records.ts";

/** 示例夹具：文献追踪的最小面板（判定 + 问题句 + 三个反馈按钮），只在测试与自检里用，不进产品。 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "lit-tracker");

let dir = "";
let root = "";
let dataRoot = "";
let workspaceRoot = "";
let frames: PanelFrames;
let record: PluginRecord;
let panels: PluginPanels;
let now = Date.UTC(2026, 10, 5, 7, 30, 0);

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

const dataFile = (): string => join(dataRoot, "lit-tracker", "panel.json");
const actionsFile = (): string => join(dataRoot, "lit-tracker", "actions.jsonl");
const sample = async (): Promise<string> => readFile(join(root, "panel.sample.json"), "utf8");

async function loadReady(stamp: string | null = null): Promise<Extract<PluginPanelSnapshot, { kind: "ready" }>> {
  const snapshot = await panels.load({ name: "lit-tracker", workspaceId: "ws-1", stamp });
  assert.equal(snapshot.kind, "ready", JSON.stringify(snapshot));
  if (snapshot.kind !== "ready") throw new Error("unreachable");
  return snapshot;
}

describe("夹具本身", () => {
  test("示例数据：8 篇（3 分 3、2 分 3、1 分 2），问题句是全角标点", async () => {
    const data = JSON.parse(await sample()) as { papers: { score: number; problem: string }[] };
    assert.equal(data.papers.length, 8);
    assert.deepEqual([3, 2, 1].map((score) => data.papers.filter((paper) => paper.score === score).length), [3, 3, 2]);
    assert.ok(data.papers.every((paper) => !/[():,]/.test(paper.problem)), "问题句里没有半角标点");
  });
});

describe("tabs 右栏页签", () => {
  test("已启用且带面板的插件各一个页签，标题用 panel.title", async () => {
    assert.deepEqual(await panels.tabs("ws-1"), [{ name: "lit-tracker", title: "文献追踪", displayName: "文献追踪" }]);
  });

  test("范围：global 在 Home（null）也出现；workspaces 范围只在名单里的工作区出现；off 不出现", async () => {
    assert.equal((await panels.tabs(null)).length, 1);
    record = makeRecord({ kind: "workspaces", ids: ["ws-1"] });
    assert.equal((await panels.tabs("ws-1")).length, 1);
    assert.equal((await panels.tabs("ws-2")).length, 0);
    assert.equal((await panels.tabs(null)).length, 0, "Home 会话没有 id，只有 global 覆盖它");
    record = makeRecord({ kind: "off" });
    assert.equal((await panels.tabs("ws-1")).length, 0);
  });

  test("没声明面板的插件不加页签；模板逃逸 / 不存在的也不加死页签", async () => {
    await writeFile(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "lit-tracker", orbita: { workflow: [] } }));
    assert.equal((await panels.tabs("ws-1")).length, 0);
    for (const template of ["../escape.html", "/etc/hosts", "./missing.html"]) {
      await writeFile(
        join(root, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "lit-tracker", orbita: { panel: { title: "x", template, data: "${CLAUDE_PLUGIN_DATA}/p.json" } } }),
      );
      assert.equal((await panels.tabs("ws-1")).length, 0, template);
    }
  });
});

describe("load 载入与轮询", () => {
  test("数据文件不存在 = 空态；首次来（stamp null）给一个新 iframe 地址，模板就是夹具里的 HTML", async () => {
    const first = await loadReady();
    assert.deepEqual(first.data, { kind: "empty" });
    assert.equal(first.title, "文献追踪");
    assert.ok(first.frameUrl !== null);
    const served = frames.respond(first.frameUrl ?? "");
    assert.equal(served.status, 200);
    assert.equal(served.body, await readFile(join(root, "panel", "index.html"), "utf8"));
  });

  test("stamp 没变回 unchanged（轮询只是 stat）；数据文件变了 → ready、frameUrl 为 null（保留 iframe）", async () => {
    const first = await loadReady();
    assert.deepEqual(await panels.load({ name: "lit-tracker", workspaceId: "ws-1", stamp: first.stamp }), { kind: "unchanged" });
    await writeFile(dataFile(), await sample());
    const second = await loadReady(first.stamp);
    assert.equal(second.frameUrl, null, "模板没变，不换 iframe");
    assert.equal(second.data.kind, "ready");
    assert.notEqual(second.stamp, first.stamp);
    if (second.data.kind === "ready") assert.equal((second.data.value as { papers: unknown[] }).papers.length, 8);
    assert.deepEqual(await panels.load({ name: "lit-tracker", workspaceId: "ws-1", stamp: second.stamp }), { kind: "unchanged" });
  });

  test("再改数据（追加一篇）面板自动刷新；删掉数据文件回到空态", async () => {
    await writeFile(dataFile(), await sample());
    const first = await loadReady();
    const data = JSON.parse(await sample()) as { papers: unknown[] };
    data.papers.pop();
    await writeFile(dataFile(), JSON.stringify(data));
    const second = await loadReady(first.stamp);
    if (second.data.kind === "ready") assert.equal((second.data.value as { papers: unknown[] }).papers.length, 7);
    await rm(dataFile());
    const third = await loadReady(second.stamp);
    assert.deepEqual(third.data, { kind: "empty" });
  });

  test("模板文件变了（agent 改了面板）→ 新的 iframe 地址，旧地址已作废", async () => {
    const first = await loadReady();
    const template = join(root, "panel", "index.html");
    await writeFile(template, "<p>v2</p>");
    const future = new Date(Date.now() + 5000);
    await utimes(template, future, future);
    const second = await loadReady(first.stamp);
    assert.ok(second.frameUrl !== null);
    assert.equal(frames.respond(second.frameUrl ?? "").body, "<p>v2</p>");
  });

  test("数据超 2 MB：不读、报 too-large；写坏的 JSON：invalid-json——都不会发给模板", async () => {
    await writeFile(dataFile(), `"${"x".repeat(PANEL_DATA_MAX_BYTES)}"`);
    const big = await loadReady();
    assert.equal(big.data.kind, "problem");
    if (big.data.kind === "problem") assert.equal(big.data.problem.kind, "too-large");
    await writeFile(dataFile(), '{"papers": [');
    const bad = await loadReady(big.stamp);
    if (bad.data.kind === "problem") assert.equal(bad.data.problem.kind, "invalid-json");
    else assert.fail("应当是 problem");
  });

  test("不可用：没装 / 没在这个工作区启用 / 没有面板 / 清单写坏——各有原因，同一原因连着轮询回 unchanged", async () => {
    const missing = await panels.load({ name: "nope", workspaceId: "ws-1", stamp: null });
    assert.equal(missing.kind === "unavailable" && missing.reason, "not-installed");
    if (missing.kind === "unavailable") assert.deepEqual(await panels.load({ name: "nope", workspaceId: "ws-1", stamp: missing.stamp }), { kind: "unchanged" });

    record = makeRecord({ kind: "workspaces", ids: ["ws-2"] });
    const notEnabled = await panels.load({ name: "lit-tracker", workspaceId: "ws-1", stamp: null });
    assert.equal(notEnabled.kind === "unavailable" && notEnabled.reason, "not-enabled");

    record = makeRecord({ kind: "global" });
    await writeFile(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "lit-tracker" }));
    const none = await panels.load({ name: "lit-tracker", workspaceId: "ws-1", stamp: null });
    assert.equal(none.kind === "unavailable" && none.reason, "no-panel");

    await writeFile(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "lit-tracker", orbita: { panel: { title: "x" } } }));
    const invalid = await panels.load({ name: "lit-tracker", workspaceId: "ws-1", stamp: null });
    assert.equal(invalid.kind === "unavailable" && invalid.reason, "invalid");
    if (invalid.kind === "unavailable") assert.deepEqual(invalid.problems, [{ kind: "shape", detail: "template" }, { kind: "shape", detail: "data" }]);
  });

  test("data 路径解析失败（Home 会话用了 ${workspaceFolder}）→ 不可用并写明原因，而不是显示成空态", async () => {
    await writeFile(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "lit-tracker", orbita: { panel: { title: "x", template: "./panel/index.html", data: "${workspaceFolder}/p.json" } } }),
    );
    const home = await panels.load({ name: "lit-tracker", workspaceId: null, stamp: null });
    assert.equal(home.kind, "unavailable");
    if (home.kind === "unavailable") assert.deepEqual(home.problems, [{ kind: "data-needs-workspace", detail: "workspaceFolder" }]);
    const inWorkspace = await panels.load({ name: "lit-tracker", workspaceId: "ws-1", stamp: null });
    assert.equal(inWorkspace.kind, "ready");
  });

  test("data 放在插件根之内（${CLAUDE_PLUGIN_ROOT}/data/panel.json：链接安装的插件，agent 装之前就能试跑产出）→ 读得到", async () => {
    await writeFile(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "lit-tracker", orbita: { panel: { title: "文献追踪", template: "./panel/index.html", data: "${CLAUDE_PLUGIN_ROOT}/data/panel.json" } } }),
    );
    await mkdir(join(root, "data"), { recursive: true });
    const empty = await loadReady();
    assert.deepEqual(empty.data, { kind: "empty" }, "文件还没有 = 空态，不是错误");
    await writeFile(join(root, "data", "panel.json"), await sample());
    const filled = await loadReady(empty.stamp);
    assert.equal(filled.data.kind, "ready");
    assert.equal((await panels.info("lit-tracker", "ws-1"))?.dataPath, join(root, "data", "panel.json"));
    assert.equal((await panels.info("lit-tracker", "ws-1"))?.data?.items, 8);
  });

  test("data 指到插件目录之外（模板想读别的文件）→ 不可用，不读", async () => {
    await writeFile(join(dir, "secret.json"), '{"secret":true}');
    await writeFile(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "lit-tracker", orbita: { panel: { title: "x", template: "./panel/index.html", data: join(dir, "secret.json") } } }),
    );
    const snapshot = await panels.load({ name: "lit-tracker", workspaceId: "ws-1", stamp: null });
    assert.equal(snapshot.kind, "unavailable");
    if (snapshot.kind === "unavailable") assert.equal(snapshot.problems[0]?.kind, "data-escape");
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

describe("info 详情页的面板与最近产出", () => {
  test("没声明面板为 null；声明了给标题、模板、替换后的数据路径", async () => {
    await writeFile(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "lit-tracker" }));
    assert.equal(await panels.info("lit-tracker", "ws-1"), null);
    await cp(join(FIXTURE, ".claude-plugin", "plugin.json"), join(root, ".claude-plugin", "plugin.json"));
    const info = await panels.info("lit-tracker", "ws-1");
    assert.equal(info?.title, "文献追踪");
    assert.equal(info?.template, "./panel/index.html");
    assert.equal(info?.dataRaw, "${CLAUDE_PLUGIN_DATA}/panel.json");
    assert.equal(info?.dataPath, dataFile());
    assert.equal(info?.openable, true);
    assert.deepEqual(info?.problems, []);
  });

  test("最近产出：没有数据 = exists false / 0 条动作；有了之后给更新时间、字节数、条数", async () => {
    const empty = await panels.info("lit-tracker", "ws-1");
    assert.equal(empty?.data?.exists, false);
    assert.deepEqual(empty?.actions, { path: actionsFile(), updatedAt: null, count: 0 });
    await writeFile(dataFile(), await sample());
    await panels.action({ name: "lit-tracker", action: "feedback", payload: { pid: "P0181" } });
    await panels.action({ name: "lit-tracker", action: "feedback", payload: { pid: "P0001" } });
    const filled = await panels.info("lit-tracker", "ws-1");
    assert.equal(filled?.data?.exists, true);
    assert.equal(filled?.data?.items, 8);
    assert.ok((filled?.data?.bytes ?? 0) > 1000);
    assert.ok((filled?.data?.updatedAt ?? 0) > 0);
    assert.equal(filled?.actions.count, 2);
    assert.ok((filled?.actions.updatedAt ?? 0) > 0);
  });

  test("openable：只有插件在当前工作区启用才可点；解析问题列在 problems（模板逃逸 / data 变量不认得）", async () => {
    record = makeRecord({ kind: "workspaces", ids: ["ws-2"] });
    assert.equal((await panels.info("lit-tracker", "ws-1"))?.openable, false);
    assert.equal((await panels.info("lit-tracker", "ws-2"))?.openable, true);
    record = makeRecord({ kind: "global" });
    await writeFile(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "lit-tracker", orbita: { panel: { title: "x", template: "../out.html", data: "${NOPE}/p.json" } } }),
    );
    const info = await panels.info("lit-tracker", "ws-1");
    assert.equal(info?.openable, false);
    assert.deepEqual(info?.problems.map((problem) => problem.kind), ["template-escape", "data-variable"]);
    assert.equal(info?.dataPath, null);
    assert.equal(info?.data, null);
  });

  test("数据超限在最近产出里也如实标出", async () => {
    await writeFile(dataFile(), `"${"x".repeat(PANEL_DATA_MAX_BYTES)}"`);
    const info = await panels.info("lit-tracker", "ws-1");
    assert.equal(info?.data?.problem?.kind, "too-large");
  });
});
