import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { PluginConfigField } from "../../shared/plugin.ts";
import { PANEL_DATA_MAX_BYTES, PANEL_TEMPLATE_MAX_BYTES } from "../../shared/plugin-panel.ts";
import {
  ActionLimiter,
  appendActionLine,
  itemCountOf,
  locatePanelTemplate,
  parsePanelSpec,
  readActionsInfo,
  readPanelData,
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

describe("parsePanelSpec", () => {
  test("没有 orbita.panel：不算声明，不报问题", () => {
    assert.deepEqual(parsePanelSpec({}, "T"), { declared: false, spec: null, problems: [] });
    assert.deepEqual(parsePanelSpec({ orbita: { workflow: [] } }, "T"), { declared: false, spec: null, problems: [] });
    assert.equal(parsePanelSpec({ orbita: "x" }, "T").declared, false);
  });

  test("正常：标题、模板、数据原样（去首尾空白）", () => {
    const parsed = parsePanelSpec({ orbita: { panel: { title: " 文献追踪 ", template: "./panel/index.html", data: "${CLAUDE_PLUGIN_DATA}/panel.json" } } }, "fallback");
    assert.deepEqual(parsed.spec, { title: "文献追踪", template: "./panel/index.html", data: "${CLAUDE_PLUGIN_DATA}/panel.json" });
    assert.deepEqual(parsed.problems, []);
  });

  test("标题缺省退回显示名；template / data 缺了或类型不对报 shape 并不给 spec", () => {
    assert.equal(parsePanelSpec({ orbita: { panel: { template: "a.html", data: "d.json" } } }, "显示名").spec?.title, "显示名");
    const missing = parsePanelSpec({ orbita: { panel: { title: "x", template: 3 } } }, "T");
    assert.equal(missing.declared, true);
    assert.equal(missing.spec, null);
    assert.deepEqual(missing.problems, [
      { kind: "shape", detail: "template" },
      { kind: "shape", detail: "data" },
    ]);
    assert.deepEqual(parsePanelSpec({ orbita: { panel: "oops" } }, "T").problems, [{ kind: "shape", detail: "panel" }]);
  });
});

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

describe("locatePanelTemplate", () => {
  test("正常：给绝对路径与 stamp", async () => {
    await mkdir(join(root, "panel"));
    await writeFile(join(root, "panel", "index.html"), "<p>hi</p>");
    const result = await locatePanelTemplate(root, "./panel/index.html");
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
      const result = await locatePanelTemplate(root, raw);
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

describe("itemCountOf", () => {
  test("顶层数组取长度；顶层对象取最长的数组属性；别的为 null", () => {
    assert.equal(itemCountOf([1, 2, 3]), 3);
    assert.equal(itemCountOf({ round: { no: 1 }, papers: [1, 2], notes: [1] }), 2);
    assert.equal(itemCountOf({ a: 1 }), null);
    assert.equal(itemCountOf("x"), null);
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

  test("readActionsInfo：不存在 = 0 条；有内容数非空行并给 mtime", async () => {
    const file = join(dataDir, "actions.jsonl");
    assert.deepEqual(await readActionsInfo(file), { updatedAt: null, count: 0 });
    await writeFile(file, '{"a":1}\n\n{"a":2}\n');
    const info = await readActionsInfo(file);
    assert.equal(info.count, 2);
    assert.ok((info.updatedAt ?? 0) > 0);
  });
});
