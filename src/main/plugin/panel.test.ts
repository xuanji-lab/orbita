import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { PluginConfigField } from "../../shared/plugin.ts";
import { PANEL_DATA_MAX_BYTES, PANEL_SPEC_MAX_BYTES, PANEL_TEMPLATE_MAX_BYTES, type PluginPanelData } from "../../shared/plugin-panel.ts";
import {
  ActionLimiter,
  appendActionLine,
  draftIdentity,
  expandRepeat,
  locatePanelFile,
  readPanelData,
  readPanelSample,
  readPanelSpec,
  resolveDataPath,
  statDataFile,
  type PanelPathContext,
} from "./panel.ts";

let dir = "";
let root = "";
let dataDir = "";
let workspace = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-plugin-panel-"));
  root = join(dir, "plugin");
  dataDir = join(dir, "plugin-data");
  workspace = join(dir, "ws");
  await mkdir(root, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function field(partial: Partial<PluginConfigField> & { key: string }): PluginConfigField {
  return {
    type: "string",
    title: partial.key,
    description: "",
    required: false,
    sensitive: false,
    default: null,
    options: null,
    multiple: false,
    min: null,
    max: null,
    ...partial,
  };
}

function context(partial: Partial<PanelPathContext> = {}): PanelPathContext {
  return { root, dataDir, fields: [], values: {}, workspaceRoot: workspace, ...partial };
}

describe("resolveDataPath 变量替换", () => {
  test("CLAUDE_PLUGIN_DATA / CLAUDE_PLUGIN_ROOT / ZCODE 前缀同义", async () => {
    assert.deepEqual(await resolveDataPath("${CLAUDE_PLUGIN_DATA}/panel.json", context()), { ok: true, path: join(dataDir, "panel.json") });
    assert.deepEqual(await resolveDataPath("${CLAUDE_PLUGIN_ROOT}/data/p.json", context()), { ok: true, path: join(root, "data", "p.json") });
    assert.deepEqual(await resolveDataPath("${ZCODE_PLUGIN_DATA}/p.json", context()), { ok: true, path: join(dataDir, "p.json") });
  });

  test("${workspaceFolder}（与 CLAUDE_PROJECT_DIR 同义）换成工作区根；Home 会话没有工作区根时报 data-needs-workspace", async () => {
    assert.deepEqual(await resolveDataPath("${workspaceFolder}/文献追踪/panel.json", context()), { ok: true, path: join(workspace, "文献追踪", "panel.json") });
    assert.deepEqual(await resolveDataPath("${CLAUDE_PROJECT_DIR}/p.json", context()), { ok: true, path: join(workspace, "p.json") });
    assert.deepEqual(await resolveDataPath("${workspaceFolder}/p.json", context({ workspaceRoot: null })), {
      ok: false,
      problem: { kind: "data-needs-workspace", detail: "workspaceFolder" },
    });
  });

  test("${user_config.KEY}：取已存值，没存取默认值；必填没填报 data-config-missing；不认得的键报 data-variable", async () => {
    const fields = [field({ key: "NAME" }), field({ key: "WITH_DEFAULT", default: "fallback" }), field({ key: "REQ", required: true })];
    assert.deepEqual(await resolveDataPath("${CLAUDE_PLUGIN_DATA}/${user_config.NAME}.json", context({ fields, values: { NAME: "round" } })), {
      ok: true,
      path: join(dataDir, "round.json"),
    });
    assert.deepEqual(await resolveDataPath("${CLAUDE_PLUGIN_DATA}/${user_config.WITH_DEFAULT}.json", context({ fields })), {
      ok: true,
      path: join(dataDir, "fallback.json"),
    });
    assert.deepEqual(await resolveDataPath("${CLAUDE_PLUGIN_DATA}/${user_config.REQ}.json", context({ fields })), {
      ok: false,
      problem: { kind: "data-config-missing", detail: "REQ" },
    });
    assert.deepEqual(await resolveDataPath("${CLAUDE_PLUGIN_DATA}/${user_config.NOPE}.json", context({ fields })), {
      ok: false,
      problem: { kind: "data-variable", detail: "user_config.NOPE" },
    });
  });

  test("敏感配置项不许进数据路径（路径会出现在详情页和日志里）", async () => {
    const fields = [field({ key: "TOKEN", sensitive: true })];
    assert.deepEqual(await resolveDataPath("${CLAUDE_PLUGIN_DATA}/${user_config.TOKEN}.json", context({ fields, values: { TOKEN: "s3cret" } })), {
      ok: false,
      problem: { kind: "data-sensitive", detail: "TOKEN" },
    });
  });

  test("认不得的变量不猜：报 data-variable（含 HOME 之类环境变量写法）", async () => {
    assert.deepEqual(await resolveDataPath("${HOME}/p.json", context()), { ok: false, problem: { kind: "data-variable", detail: "HOME" } });
    assert.deepEqual(await resolveDataPath("${CLAUDE_PLUGIN_DATA}/${oops}.json", context()), { ok: false, problem: { kind: "data-variable", detail: "oops" } });
  });
});

describe("resolveDataPath 只许读允许的目录", () => {
  test("相对路径按插件根解析；`..` 走出去、绝对路径指到别处都拒（data-escape）", async () => {
    assert.deepEqual(await resolveDataPath("./data/p.json", context()), { ok: true, path: join(root, "data", "p.json") });
    for (const bad of ["../secret.json", "${CLAUDE_PLUGIN_DATA}/../../etc/passwd", "/etc/passwd", "${CLAUDE_PLUGIN_DATA}/a/../../b.json"]) {
      const result = await resolveDataPath(bad, context());
      assert.equal(result.ok, false, bad);
      if (!result.ok) assert.equal(result.problem.kind, "data-escape", bad);
    }
  });

  test("空串与含 NUL 的路径拒", async () => {
    assert.equal((await resolveDataPath("${user_config.X}", context({ fields: [field({ key: "X", default: " " })] }))).ok, false);
    assert.equal((await resolveDataPath("a\u0000b", context())).ok, false);
  });

  test("符号链接：数据目录里的链接指到根外，真实位置不在允许的目录里就拒", async () => {
    const outside = join(dir, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.json"), '{"secret":1}');
    await symlink(join(outside, "secret.json"), join(dataDir, "panel.json"));
    const result = await resolveDataPath("${CLAUDE_PLUGIN_DATA}/panel.json", context());
    assert.equal(result.ok, false);
    // 目录链接同理
    await symlink(outside, join(dataDir, "linked"));
    assert.equal((await resolveDataPath("${CLAUDE_PLUGIN_DATA}/linked/secret.json", context())).ok, false);
  });

  test("链接指回允许的目录之内是可以的", async () => {
    await mkdir(join(dataDir, "real"));
    await symlink(join(dataDir, "real"), join(dataDir, "alias"));
    assert.equal((await resolveDataPath("${CLAUDE_PLUGIN_DATA}/alias/p.json", context())).ok, true);
  });

  test("directory 型配置值是用户亲手选的位置：引用它时允许落在它之下；string 型不算", async () => {
    const elsewhere = join(dir, "elsewhere");
    await mkdir(elsewhere);
    const fields = [field({ key: "OUT", type: "directory" }), field({ key: "S", type: "string" })];
    assert.deepEqual(await resolveDataPath("${user_config.OUT}/panel.json", context({ fields, values: { OUT: elsewhere } })), {
      ok: true,
      path: join(elsewhere, "panel.json"),
    });
    const asString = await resolveDataPath("${user_config.S}/panel.json", context({ fields, values: { S: elsewhere } }));
    assert.equal(asString.ok, false);
  });

  test("数据文件还不存在（第一轮之前）也能解析通过", async () => {
    assert.equal((await resolveDataPath("${CLAUDE_PLUGIN_DATA}/not/yet/there.json", context())).ok, true);
  });
});

describe("locatePanelFile：template", () => {
  test("正常：给绝对路径与 stamp", async () => {
    await mkdir(join(root, "panel"));
    await writeFile(join(root, "panel", "index.html"), "<p>hi</p>");
    const result = await locatePanelFile(root, "./panel/index.html", "template");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.abs, join(root, "panel", "index.html"));
  });

  test("`..`、绝对路径、符号链接逃逸报 template-escape；不存在报 template-missing；目录报 unreadable；超限报 too-large", async () => {
    await writeFile(join(dir, "outside.html"), "x");
    await symlink(join(dir, "outside.html"), join(root, "link.html"));
    await mkdir(join(root, "d"));
    await writeFile(join(root, "big.html"), "x".repeat(PANEL_TEMPLATE_MAX_BYTES + 1));
    const kinds: Record<string, string> = {};
    for (const raw of ["../outside.html", "/etc/hosts", "link.html", "nope.html", "d", "big.html"]) {
      const result = await locatePanelFile(root, raw, "template");
      kinds[raw] = result.ok ? "ok" : result.problem.kind;
    }
    assert.deepEqual(kinds, {
      "../outside.html": "template-escape",
      "/etc/hosts": "template-escape",
      "link.html": "template-escape",
      "nope.html": "template-missing",
      d: "template-unreadable",
      "big.html": "template-too-large",
    });
  });
});

describe("locatePanelFile：spec 与 sample 走和模板同一条路径规则", () => {
  test("逃逸（`..`、绝对路径、符号链接）/ 缺失 / 目录 / 超限，各报自己那一档的分类", async () => {
    await writeFile(join(dir, "outside.md"), "x");
    await symlink(join(dir, "outside.md"), join(root, "link.md"));
    await mkdir(join(root, "d"));
    await writeFile(join(root, "big.md"), "x".repeat(PANEL_SPEC_MAX_BYTES + 1));
    await writeFile(join(root, "ok.md"), "# hi");
    const kinds: Record<string, string> = {};
    for (const raw of ["../outside.md", "/etc/hosts", "link.md", "nope.md", "d", "big.md", "./ok.md"]) {
      const result = await locatePanelFile(root, raw, "spec");
      kinds[raw] = result.ok ? "ok" : result.problem.kind;
    }
    assert.deepEqual(kinds, {
      "../outside.md": "spec-escape",
      "/etc/hosts": "spec-escape",
      "link.md": "spec-escape",
      "nope.md": "spec-missing",
      d: "spec-unreadable",
      "big.md": "spec-too-large",
      "./ok.md": "ok",
    });
    const sample = await locatePanelFile(root, "../outside.md", "sample");
    assert.equal(sample.ok === false && sample.problem.kind, "sample-escape");
    assert.equal((await locatePanelFile(root, "nope.md", "sample")).ok, false);
  });

  test("样例的上限是数据文件的 2 MB，说明的上限是 64 KB——各用各的", async () => {
    await writeFile(join(root, "mid.json"), "x".repeat(PANEL_SPEC_MAX_BYTES + 1));
    assert.equal((await locatePanelFile(root, "mid.json", "sample")).ok, true);
    assert.equal((await locatePanelFile(root, "mid.json", "spec")).ok, false);
    await writeFile(join(root, "huge.json"), "x".repeat(PANEL_DATA_MAX_BYTES + 1));
    const huge = await locatePanelFile(root, "huge.json", "sample");
    assert.equal(huge.ok === false && huge.problem.kind, "sample-too-large");
  });

  test("文件在轮询之间被删 / 换成目录：以问题返回，不抛", async () => {
    await writeFile(join(root, "gone.md"), "x");
    await rm(join(root, "gone.md"));
    assert.equal((await locatePanelFile(root, "gone.md", "spec")).ok, false);
    assert.equal((await locatePanelFile(join(root, "no-such-root"), "a.md", "spec")).ok, false);
  });
});

describe("readPanelSpec / readPanelSample", () => {
  test("说明去 BOM；样例按数据文件的规则读，读不出来的原因换成 sample-* 分类", async () => {
    await writeFile(join(root, "s.md"), "\ufeff# 标题");
    const spec = await readPanelSpec(join(root, "s.md"));
    assert.deepEqual(spec, { ok: true, text: "# 标题" });

    await writeFile(join(root, "good.json"), '{"papers":[1]}');
    const good = await readPanelSample(join(root, "good.json"));
    assert.equal(good.ok && good.data.kind, "ready");
    await writeFile(join(root, "empty.json"), "[]");
    const empty = await readPanelSample(join(root, "empty.json"));
    assert.deepEqual(empty, { ok: true, data: { kind: "empty" } });
    await writeFile(join(root, "bad.json"), '{"a":');
    const bad = await readPanelSample(join(root, "bad.json"));
    assert.equal(bad.ok === false && bad.problem.kind, "sample-invalid");
    await writeFile(join(root, "big.json"), `"${"x".repeat(PANEL_DATA_MAX_BYTES)}"`);
    const big = await readPanelSample(join(root, "big.json"));
    assert.equal(big.ok === false && big.problem.kind, "sample-too-large");
    const missing = await readPanelSample(join(root, "none.json"));
    assert.deepEqual(missing, { ok: true, data: { kind: "empty" } }, "不存在 = 空（定位那一步才报 missing）");
  });
});

describe("readPanelData", () => {
  test("不存在 / 空文件 / 全空白 / null / {} / [] 都是空态", async () => {
    assert.deepEqual(await readPanelData(join(dataDir, "none.json")), { kind: "empty" });
    for (const [name, text] of [["empty.json", ""], ["blank.json", " \n "], ["null.json", "null"], ["obj.json", "{}"], ["arr.json", "[]"]] as const) {
      await writeFile(join(dataDir, name), text);
      assert.deepEqual(await readPanelData(join(dataDir, name)), { kind: "empty" }, name);
    }
  });

  test("有内容：返回解析后的值与 mtime；带 BOM 也认", async () => {
    await writeFile(join(dataDir, "p.json"), '\ufeff{"papers":[1,2,3]}');
    const result = await readPanelData(join(dataDir, "p.json"));
    assert.equal(result.kind, "ready");
    if (result.kind === "ready") {
      assert.deepEqual(result.value, { papers: [1, 2, 3] });
      assert.ok(result.updatedAt > 0);
    }
  });

  test("写坏的 JSON：invalid-json（不抛）", async () => {
    await writeFile(join(dataDir, "bad.json"), '{"papers": [');
    const result = await readPanelData(join(dataDir, "bad.json"));
    assert.equal(result.kind, "problem");
    if (result.kind === "problem") assert.equal(result.problem.kind, "invalid-json");
  });

  test("超过 2 MB 不读，直接 too-large 带字节数；恰好 2 MB 的合法 JSON 能读", async () => {
    const big = join(dataDir, "big.json");
    await writeFile(big, `"${"x".repeat(PANEL_DATA_MAX_BYTES)}"`);
    assert.deepEqual(await readPanelData(big), { kind: "problem", problem: { kind: "too-large", bytes: PANEL_DATA_MAX_BYTES + 2 } });
    const edge = join(dataDir, "edge.json");
    await writeFile(edge, `"${"x".repeat(PANEL_DATA_MAX_BYTES - 2)}"`);
    assert.equal((await readPanelData(edge)).kind, "ready");
  });

  test("路径是目录：unreadable", async () => {
    const result = await readPanelData(dataDir);
    assert.equal(result.kind, "problem");
  });

  test("statDataFile：签名随内容变化，不存在是 missing", async () => {
    const file = join(dataDir, "s.json");
    assert.equal((await statDataFile(file)).signature, "missing");
    await writeFile(file, "[1]");
    const first = await statDataFile(file);
    assert.equal(first.exists, true);
    await writeFile(file, "[1,2]");
    assert.notEqual((await statDataFile(file)).signature, first.signature);
  });
});

describe("expandRepeat", () => {
  test("有项：一项一张；空数组 / 没数据 / 数据有问题：none（画一张占位卡）；属性缺失或不是数组：not-array", () => {
    const ready = (value: unknown): PluginPanelData => ({ kind: "ready", value, updatedAt: 1 });
    assert.deepEqual(expandRepeat(ready({ items: [1, 2] }), "items"), { kind: "items", items: [1, 2] });
    assert.deepEqual(expandRepeat(ready({ items: [] }), "items"), { kind: "none" });
    assert.deepEqual(expandRepeat({ kind: "empty" }, "items"), { kind: "none" });
    assert.deepEqual(expandRepeat({ kind: "problem", problem: { kind: "invalid-json", message: "x" } }, "items"), { kind: "none" });
    assert.deepEqual(expandRepeat(ready({ items: "x" }), "items"), { kind: "not-array" });
    assert.deepEqual(expandRepeat(ready({ other: [1] }), "items"), { kind: "not-array" });
    assert.deepEqual(expandRepeat(ready([1, 2]), "items"), { kind: "not-array" }, "顶层是数组也不认：repeat 只认顶层属性");
    assert.deepEqual(expandRepeat(ready({ constructor: [1] }), "toString"), { kind: "not-array" }, "原型上的键不算");
  });
});

describe("ActionLimiter", () => {
  test("窗口内最多 max 条，超了拒且不记；窗口滑过去后恢复", () => {
    let now = 1000;
    const limiter = new ActionLimiter(3, 100, () => now);
    assert.deepEqual([limiter.allow("p"), limiter.allow("p"), limiter.allow("p"), limiter.allow("p")], [true, true, true, false]);
    assert.equal(limiter.allow("other"), true, "不同插件各算各的");
    now += 101;
    assert.equal(limiter.allow("p"), true);
  });
});

describe("appendActionLine", () => {
  test("追加完整的一行；多次追加每行都是独立 JSON", async () => {
    const file = join(dataDir, "actions.jsonl");
    assert.equal(await appendActionLine(file, '{"a":1}'), "ok");
    assert.equal(await appendActionLine(file, '{"a":2}'), "ok");
    assert.equal(await readFile(file, "utf8"), '{"a":1}\n{"a":2}\n');
  });

  test("目录还不存在也能建；上一行崩溃留下半行（没有结尾换行）时先补换行，不把两行接成一行", async () => {
    const file = join(dir, "fresh", "deep", "actions.jsonl");
    assert.equal(await appendActionLine(file, '{"a":1}'), "ok");
    await writeFile(file, '{"a":1}\n{"half":', "utf8");
    await appendActionLine(file, '{"b":2}');
    assert.equal(await readFile(file, "utf8"), '{"a":1}\n{"half":\n{"b":2}\n');
  });

  test("整份超过上限就拒（file-full），文件不变", async () => {
    const file = join(dataDir, "actions.jsonl");
    await appendActionLine(file, "x".repeat(20));
    assert.equal(await appendActionLine(file, "y".repeat(20), 30), "file-full");
    assert.equal(await readFile(file, "utf8"), `${"x".repeat(20)}\n`);
  });

  test("并发追加（串行化由调用方负责，这里单次 write 一整行）：100 行都在、每行完整", async () => {
    const file = join(dataDir, "actions.jsonl");
    const lines = Array.from({ length: 100 }, (_, index) => JSON.stringify({ n: index, pad: "p".repeat(500) }));
    await Promise.all(lines.map((line) => appendActionLine(file, line)));
    const read = (await readFile(file, "utf8")).split("\n").filter((line) => line !== "");
    assert.equal(read.length, 100);
    assert.deepEqual(read.map((line) => (JSON.parse(line) as { n: number }).n).sort((a, b) => a - b), lines.map((_, index) => index));
  });
});

describe("draftIdentity（右栏草稿预览与 show_plugin_board 共用的草稿身份）", () => {
  const dataDirOf = (name: string): string => join("/data", name);

  test("清单名合规：用清单名；显示名取清单 displayName，没有就是名字；数据目录按清单名", () => {
    assert.deepEqual(draftIdentity({ name: "lit-draft", displayName: "文献草稿" }, "/ws/plugins/folder", dataDirOf), {
      name: "lit-draft",
      displayName: "文献草稿",
      dataDir: join("/data", "lit-draft"),
    });
    assert.equal(draftIdentity({ name: "lit-draft" }, "/ws/plugins/folder", dataDirOf).displayName, "lit-draft");
  });

  test("清单名不合规 / 没写：退回文件夹名；两个都不合规：数据目录退回草稿自己的 data/（路径穿越进不来）", () => {
    assert.deepEqual(draftIdentity({ name: "../../x" }, "/ws/plugins/lit-draft", dataDirOf), {
      name: "lit-draft",
      displayName: "lit-draft",
      dataDir: join("/data", "lit-draft"),
    });
    assert.deepEqual(draftIdentity({ name: "../../x" }, "/ws/plugins/Odd Name", dataDirOf), {
      name: "Odd Name",
      displayName: "Odd Name",
      dataDir: join("/ws/plugins/Odd Name", "data"),
    });
  });
});
