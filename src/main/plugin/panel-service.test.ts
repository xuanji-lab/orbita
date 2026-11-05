import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
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

/** 把清单换成带 spec / sample 的版本（夹具里的 panel/index.html 还在 root 下）。 */
async function writePanelManifest(folder: string, panel: Record<string, unknown>, name = "lit-tracker"): Promise<void> {
  await mkdir(join(folder, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(folder, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name, orbita: { panel: { title: "文献追踪", template: "./panel/index.html", data: "${CLAUDE_PLUGIN_DATA}/panel.json", ...panel } } }),
  );
}

describe("spec 与 sample：模板说明、样例数据、usingSample", () => {
  beforeEach(async () => {
    await writePanelManifest(root, { spec: "./panel/spec.md", sample: "./panel.sample.json" });
    await writeFile(join(root, "panel", "spec.md"), "# 卡片\n\n- 问题句：最大的字");
  });

  test("数据文件不存在 → 用样例渲染并标 usingSample；说明原文随快照给出", async () => {
    const snapshot = await loadReady();
    assert.equal(snapshot.usingSample, true);
    assert.equal(snapshot.data.kind, "ready");
    if (snapshot.data.kind === "ready") assert.equal((snapshot.data.value as { papers: unknown[] }).papers.length, 8);
    assert.equal(snapshot.spec, "# 卡片\n\n- 问题句：最大的字");
    assert.deepEqual(snapshot.problems, []);
  });

  test("数据文件有内容 → 用数据、不标样例；数据文件是 {} / [] / 空文件也算没有，退回样例", async () => {
    await writeFile(dataFile(), '{"papers":[{"pid":"P1"}]}');
    const real = await loadReady();
    assert.equal(real.usingSample, false);
    for (const empty of ["{}", "[]", "", "null"]) {
      await writeFile(dataFile(), empty);
      const snapshot = await loadReady(real.stamp);
      assert.equal(snapshot.usingSample, true, JSON.stringify(empty));
      assert.equal(snapshot.data.kind, "ready");
    }
  });

  test("数据文件写坏 / 超限是要让人看到的错误：不拿样例盖过去", async () => {
    await writeFile(dataFile(), '{"papers": [');
    const bad = await loadReady();
    assert.equal(bad.usingSample, false);
    assert.equal(bad.data.kind === "problem" && bad.data.problem.kind, "invalid-json");
    await writeFile(dataFile(), `"${"x".repeat(PANEL_DATA_MAX_BYTES)}"`);
    const big = await loadReady(bad.stamp);
    assert.equal(big.usingSample, false);
    assert.equal(big.data.kind === "problem" && big.data.problem.kind, "too-large");
  });

  test("agent 写出真数据后：下一次轮询从样例换成真数据（stamp 变、frameUrl 保持 null）", async () => {
    const first = await loadReady();
    assert.equal(first.usingSample, true);
    assert.deepEqual(await panels.load({ name: "lit-tracker", workspaceId: "ws-1", stamp: first.stamp }), { kind: "unchanged" });
    await writeFile(dataFile(), await sample());
    const second = await loadReady(first.stamp);
    assert.equal(second.usingSample, false);
    assert.equal(second.frameUrl, null);
  });

  test("改说明 / 改样例都会让 stamp 变（草稿预览靠它几秒内刷新）", async () => {
    const first = await loadReady();
    await writeFile(join(root, "panel", "spec.md"), "# 改过了");
    await utimes(join(root, "panel", "spec.md"), new Date(), new Date(Date.now() + 5000));
    const afterSpec = await loadReady(first.stamp);
    assert.equal(afterSpec.spec, "# 改过了");
    assert.equal(afterSpec.frameUrl, null, "模板没动就不换 iframe");
    await writeFile(join(root, "panel.sample.json"), '{"papers":[{"pid":"only"}]}');
    await utimes(join(root, "panel.sample.json"), new Date(), new Date(Date.now() + 9000));
    const afterSample = await loadReady(afterSpec.stamp);
    assert.equal(afterSample.data.kind === "ready" && (afterSample.data.value as { papers: unknown[] }).papers.length, 1);
  });

  test("spec / sample 写得不对：面板照常出，缺的那块不出，原因进 problems", async () => {
    await writePanelManifest(root, { spec: "../out.md", sample: "./nope.json" });
    const snapshot = await loadReady();
    assert.equal(snapshot.spec, null);
    assert.equal(snapshot.usingSample, false);
    assert.deepEqual(snapshot.data, { kind: "empty" });
    assert.deepEqual(snapshot.problems.map((problem) => problem.kind), ["sample-missing", "spec-escape"]);
    // 样例写坏了：同样不拦面板
    await writePanelManifest(root, { sample: "./bad.json" });
    await writeFile(join(root, "bad.json"), '{"a":');
    const bad = await loadReady(snapshot.stamp);
    assert.deepEqual(bad.problems.map((problem) => problem.kind), ["sample-invalid"]);
    assert.equal(bad.usingSample, false);
    // 写成了不认识的形状
    await writePanelManifest(root, { spec: 5 });
    const shape = await loadReady(bad.stamp);
    assert.deepEqual(shape.problems, [{ kind: "shape", detail: "spec" }]);
  });

  test("没写 spec / sample 的插件：usingSample false、spec null、没有 problems（旧插件原样）", async () => {
    await writePanelManifest(root, {});
    const snapshot = await loadReady();
    assert.equal(snapshot.usingSample, false);
    assert.equal(snapshot.spec, null);
    assert.deepEqual(snapshot.problems, []);
  });

  test("详情页信息：给出清单原文，spec / sample 的路径问题进 problems（不读内容）", async () => {
    const info = await panels.info("lit-tracker", "ws-1");
    assert.equal(info?.spec, "./panel/spec.md");
    assert.equal(info?.sample, "./panel.sample.json");
    assert.deepEqual(info?.problems, []);
    await writePanelManifest(root, { spec: "/etc/hosts", sample: "./nope.json" });
    const bad = await panels.info("lit-tracker", "ws-1");
    assert.deepEqual(bad?.problems.map((problem) => problem.kind), ["spec-escape", "sample-missing"]);
    assert.equal(bad?.title, "文献追踪", "说明 / 样例的问题不影响面板信息本身");
  });
});

describe("loadDraft 草稿预览", () => {
  let draft = "";
  beforeEach(async () => {
    draft = join(workspaceRoot, "plugins", "lit-draft");
    await cp(FIXTURE, draft, { recursive: true });
    await writePanelManifest(draft, { spec: "./panel/spec.md", sample: "./panel.sample.json" }, "lit-draft");
    await writeFile(join(draft, "panel", "spec.md"), "# 草稿说明");
    // 草稿没装：records 里没有它
    panels = build(() => []);
  });

  const loadDraft = (path: string, workspaceId: string | null = "ws-1", stamp: string | null = null): Promise<PluginPanelSnapshot> =>
    panels.loadDraft({ path, workspaceId, stamp });

  test("绝对路径与相对工作区根的路径都行：样例渲染 + 说明 + 同一套 iframe 协议", async () => {
    for (const path of [draft, "plugins/lit-draft", "./plugins/lit-draft/"]) {
      const snapshot = await loadDraft(path);
      assert.equal(snapshot.kind, "ready", path);
      if (snapshot.kind !== "ready") continue;
      assert.equal(snapshot.usingSample, true);
      assert.equal(snapshot.spec, "# 草稿说明");
      assert.equal(snapshot.title, "文献追踪");
      assert.equal(frames.respond(snapshot.frameUrl ?? "").status, 200);
    }
  });

  test("轮询：stamp 没变回 unchanged；agent 往数据目录写出真数据 → 换成真数据；改说明 → 刷新", async () => {
    const first = await loadDraft(draft);
    assert.equal(first.kind, "ready");
    if (first.kind !== "ready") return;
    assert.deepEqual(await loadDraft(draft, "ws-1", first.stamp), { kind: "unchanged" });
    // 草稿的 ${CLAUDE_PLUGIN_DATA} 就是装上之后那个插件的数据目录（按清单里的名字）
    await mkdir(join(dataRoot, "lit-draft"), { recursive: true });
    await writeFile(join(dataRoot, "lit-draft", "panel.json"), '{"papers":[{"pid":"P9"}]}');
    const second = await loadDraft(draft, "ws-1", first.stamp);
    assert.equal(second.kind, "ready");
    if (second.kind !== "ready") return;
    assert.equal(second.usingSample, false);
    assert.equal(second.frameUrl, null);
    await writeFile(join(draft, "panel", "spec.md"), "# 改了");
    await utimes(join(draft, "panel", "spec.md"), new Date(), new Date(Date.now() + 5000));
    const third = await loadDraft(draft, "ws-1", second.stamp);
    assert.equal(third.kind === "ready" && third.spec, "# 改了");
  });

  test("工作区之外一律拒（不管那里有没有东西）：绝对路径、`..`、同名前缀的兄弟目录、插件根本身往上走", async () => {
    const sibling = `${workspaceRoot}-evil`;
    await cp(FIXTURE, join(sibling, "p"), { recursive: true });
    await cp(FIXTURE, join(dir, "outside-plugin"), { recursive: true });
    const outsiders = [
      join(dir, "outside-plugin"),
      "../outside-plugin",
      "plugins/../../outside-plugin",
      join(sibling, "p"),
      "../ws-evil/p",
      "/etc",
      dir,
      join(dir, "no-such-place"),
      "../no-such-place",
    ];
    for (const path of outsiders) {
      const snapshot = await loadDraft(path);
      assert.equal(snapshot.kind === "unavailable" && snapshot.reason, "outside-workspace", path);
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
      const snapshot = await loadDraft(draft, workspaceId);
      assert.equal(snapshot.kind === "unavailable" && snapshot.reason, "outside-workspace", String(workspaceId));
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

  test("还没有面板（没清单 / 清单没声明 / 声明写歪）：no-panel 或 invalid，写出来之后下一次轮询就出现", async () => {
    await mkdir(join(workspaceRoot, "plugins", "early"), { recursive: true });
    const bare = await loadDraft("plugins/early");
    assert.equal(bare.kind === "unavailable" && bare.reason, "no-panel");
    await writeFile(join(workspaceRoot, "plugins", "early", "plugin.json"), "{}");
    await mkdir(join(workspaceRoot, "plugins", "early", ".claude-plugin"), { recursive: true });
    await writeFile(join(workspaceRoot, "plugins", "early", ".claude-plugin", "plugin.json"), '{"name":"early"');
    const broken = await loadDraft("plugins/early", "ws-1", bare.kind === "unavailable" ? bare.stamp : null);
    assert.equal(broken.kind === "unavailable" || broken.kind === "unchanged", true, "写到一半的清单按「还没有面板」");
    await writePanelManifest(join(workspaceRoot, "plugins", "early"), { template: "./t.html" }, "early");
    await writeFile(join(workspaceRoot, "plugins", "early", "t.html"), "<p>t</p>");
    const ready = await loadDraft("plugins/early");
    assert.equal(ready.kind, "ready");
  });

  test("草稿里的模板 / 说明 / 样例路径逃逸照拒；data 指到允许范围之外照拒", async () => {
    await writePanelManifest(draft, { template: "../../../outside.html" }, "lit-draft");
    const escaped = await loadDraft(draft);
    assert.equal(escaped.kind === "unavailable" && escaped.problems[0]?.kind, "template-escape");
    await writePanelManifest(draft, { data: join(dir, "secret.json") }, "lit-draft");
    const dataOut = await loadDraft(draft);
    assert.equal(dataOut.kind === "unavailable" && dataOut.problems[0]?.kind, "data-escape");
    await writePanelManifest(draft, { spec: "../../../x.md", sample: "/etc/hosts" }, "lit-draft");
    const aux = await loadDraft(draft);
    assert.equal(aux.kind, "ready");
    assert.deepEqual(aux.kind === "ready" && aux.problems.map((problem) => problem.kind), ["sample-escape", "spec-escape"]);
  });

  test("草稿清单里的名字不合规：数据目录退回文件夹名，再不行退回草稿自己的 data/（路径穿越进不来）", async () => {
    await writePanelManifest(draft, { data: "${CLAUDE_PLUGIN_DATA}/panel.json" }, "../../../etc");
    await mkdir(join(draft, "data"), { recursive: true });
    const viaFolder = await loadDraft(draft);
    assert.equal(viaFolder.kind, "ready");
    // 文件夹名也不合规（大写 + 空格）
    const odd = join(workspaceRoot, "plugins", "Odd Name");
    await cp(FIXTURE, odd, { recursive: true });
    await writePanelManifest(odd, {}, "../../x");
    await mkdir(join(odd, "data"), { recursive: true });
    await writeFile(join(odd, "data", "panel.json"), '{"papers":[{"pid":"inside"}]}');
    const snapshot = await loadDraft(odd);
    assert.equal(snapshot.kind, "ready");
    assert.equal(snapshot.kind === "ready" && snapshot.data.kind, "ready", "读的是草稿根下的 data/panel.json");
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

  test("解析问题列在 problems（模板逃逸 / data 变量不认得）", async () => {
    await writeFile(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "lit-tracker", orbita: { panel: { title: "x", template: "../out.html", data: "${NOPE}/p.json" } } }),
    );
    const info = await panels.info("lit-tracker", "ws-1");
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
