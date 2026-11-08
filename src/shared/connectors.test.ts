import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  CONNECTORS,
  CONNECTOR_IDS,
  connectorServerConfig,
  connectorSetupPrompt,
  deriveConnectorStatus,
  findConnector,
  normalizeConnectorToken,
  opensSetupSession,
  type CliRun,
  type ConnectorEntry,
} from "./connectors.ts";
import { isMcpServerName, parseServer } from "./mcp.ts";

function entry(id: string): ConnectorEntry {
  const found = findConnector(id);
  assert.ok(found, `目录里没有 ${id}`);
  return found;
}

const logoDir = new URL("../../design-system/assets/connector-logos/", import.meta.url);

describe("目录数据完整性", () => {
  test("10 家、id 不重复、顺序固定（即将支持的沉底）", () => {
    assert.deepEqual(CONNECTORS.map((each) => each.id), [...CONNECTOR_IDS]);
    assert.equal(new Set(CONNECTORS.map((each) => each.id)).size, 10);
    assert.deepEqual(CONNECTORS.filter((each) => each.kind === "coming-soon").map((each) => each.id), ["notion", "supabase"]);
    assert.deepEqual(CONNECTORS.slice(-2).map((each) => each.kind), ["coming-soon", "coming-soon"]);
  });

  test("每家有官方入口（https）、核验日期、接入小标、能找到的品牌标文件", () => {
    for (const each of CONNECTORS) {
      assert.match(each.officialUrl, /^https:\/\//, each.id);
      assert.match(each.verifiedOn, /^\d{4}-\d{2}-\d{2}$/, each.id);
      assert.ok(each.via.length > 0, each.id);
      assert.ok(existsSync(new URL(each.logo.file, logoDir)), `${each.id} 的标 ${each.logo.file} 不在 connector-logos/`);
    }
  });

  test("单色标只有 GitHub / Notion（暗色下跟字色），且文件里没有写死颜色", () => {
    assert.deepEqual(CONNECTORS.filter((each) => each.logo.mono).map((each) => each.id), ["github", "notion"]);
    for (const each of CONNECTORS.filter((c) => c.logo.mono)) {
      const svg = readFileSync(new URL(each.logo.file, logoDir), "utf8");
      assert.match(svg, /fill="currentColor"/, each.id);
      assert.doesNotMatch(svg, /width="1em"|<title>/, each.id);
    }
  });

  test("kind 与字段对得上：cli 有命令、mcp-token 有 token 头与合法 server 名、coming-soon 没有可配置面", () => {
    for (const each of CONNECTORS) {
      if (each.kind === "cli") assert.ok(each.cli, `${each.id} 缺 cli`);
      if (each.kind === "mcp-token") {
        assert.ok(each.mcp?.tokenHeader, `${each.id} 缺 tokenHeader`);
        assert.match(each.mcp.url, /^https:\/\//);
      }
      if (each.mcp !== undefined) assert.ok(isMcpServerName(each.mcp.serverName), each.id);
      if (each.kind === "coming-soon") assert.equal(opensSetupSession(each), false);
    }
    // mcp.json 里的 server 名不能撞
    const names = CONNECTORS.flatMap((each) => (each.mcp === undefined ? [] : [each.mcp.serverName]));
    assert.equal(new Set(names).size, names.length);
  });

  test("接入方式与事实一致：百度网盘是 SSE + Bearer，腾讯文档是 Streamable HTTP + 原样 token", () => {
    assert.deepEqual(entry("baidu-netdisk").mcp, {
      serverName: "baidu-netdisk",
      url: "https://mcp-pan.baidu.com/sse",
      transport: "sse",
      tokenHeader: { name: "Authorization", prefix: "Bearer " },
    });
    assert.deepEqual(entry("tencent-docs").mcp?.tokenHeader, { name: "Authorization", prefix: "" });
    assert.equal(entry("tencent-docs").mcp?.transport, "http");
  });

  test("状态命令都是只读的认证状态查询，没有会打开浏览器的登录命令", () => {
    for (const each of CONNECTORS) {
      const args = each.cli?.statusArgs;
      if (args === undefined) continue;
      assert.ok(!args.some((arg) => /login|init|install|open|launch/i.test(arg)), `${each.id}: ${args.join(" ")}`);
    }
    assert.deepEqual(entry("feishu").cli?.statusArgs, ["auth", "status"]);
    assert.deepEqual(entry("dingtalk").cli?.statusArgs, ["auth", "status"]);
    assert.deepEqual(entry("wecom").cli?.statusArgs, ["auth", "show"]);
    assert.deepEqual(entry("github").cli?.statusArgs, ["auth", "status"]);
  });
});

const run = (over: Partial<CliRun> = {}): CliRun => ({ found: true, exitCode: 0, output: "", timedOut: false, spawnError: null, ...over });

describe("状态推导（只认实测）", () => {
  test("命令行：没找到 → 未配置（没装）；退出 0 → 已连接；退出非 0 → 未配置（没登录）", () => {
    const feishu = entry("feishu");
    assert.deepEqual(deriveConnectorStatus(feishu, { cli: run({ found: false, exitCode: null }) }), { kind: "unset", reason: "cli-missing" });
    assert.deepEqual(deriveConnectorStatus(feishu, { cli: run({ output: "logged in as x" }) }), { kind: "connected", by: "cli" });
    assert.deepEqual(deriveConnectorStatus(feishu, { cli: run({ exitCode: 1, output: "not logged in" }) }), { kind: "unset", reason: "not-logged-in" });
  });

  test("命令行：退出 0 但输出说没登录（有的 CLI 就是这样）不算已连接", () => {
    for (const output of ["Not logged in", "未登录，请先运行 login", "no credentials found", "Not authenticated"]) {
      assert.deepEqual(deriveConnectorStatus(entry("dingtalk"), { cli: run({ output }) }), { kind: "unset", reason: "not-logged-in" }, output);
    }
  });

  test("命令行：超时 / 启动失败 → 检测失败（不冒充未配置，也不冒充已连接）", () => {
    assert.deepEqual(deriveConnectorStatus(entry("wecom"), { cli: run({ exitCode: null, timedOut: true }) }), { kind: "failed", code: "timeout", message: "" });
    assert.deepEqual(deriveConnectorStatus(entry("wecom"), { cli: run({ exitCode: null, spawnError: "EACCES" }) }), { kind: "failed", code: "error", message: "EACCES" });
  });

  test("Tabbit：命令在 + skill 文件在才算接好；缺任一都不算", () => {
    const tabbit = entry("tabbit");
    assert.deepEqual(deriveConnectorStatus(tabbit, { cli: run({ exitCode: null }), filesOk: true }), { kind: "connected", by: "local" });
    assert.deepEqual(deriveConnectorStatus(tabbit, { cli: run({ exitCode: null }), filesOk: false }), { kind: "unset", reason: "no-config" });
    assert.deepEqual(deriveConnectorStatus(tabbit, { cli: run({ found: false, exitCode: null }), filesOk: true }), { kind: "unset", reason: "cli-missing" });
  });

  test("远程 MCP：没条目 / 停用 → 未配置；真连通 → 已连接带工具数；连不上 → 检测失败带原因", () => {
    const tencent = entry("tencent-docs");
    assert.deepEqual(deriveConnectorStatus(tencent, { mcp: { present: false, disabled: false, probe: null } }), { kind: "unset", reason: "no-config" });
    assert.deepEqual(deriveConnectorStatus(tencent, { mcp: { present: true, disabled: true, probe: null } }), { kind: "unset", reason: "disabled" });
    assert.deepEqual(deriveConnectorStatus(tencent, { mcp: { present: true, disabled: false, probe: { ok: true, tools: 7 } } }), { kind: "connected", by: "mcp", tools: 7 });
    assert.deepEqual(deriveConnectorStatus(tencent, { mcp: { present: true, disabled: false, probe: { ok: false, message: "401" } } }), { kind: "failed", code: "mcp", message: "401" });
  });

  test("GitHub 两条路任一通就是已连接；一条坏一条没配时报失败；都没配是未配置（原因取命令行）", () => {
    const github = entry("github");
    const mcpOk = { present: true, disabled: false, probe: { ok: true as const, tools: 3 } };
    const mcpBad = { present: true, disabled: false, probe: { ok: false as const, message: "401" } };
    const mcpNone = { present: false, disabled: false, probe: null };
    assert.equal(deriveConnectorStatus(github, { cli: run({ found: false, exitCode: null }), mcp: mcpOk }).kind, "connected");
    assert.equal(deriveConnectorStatus(github, { cli: run(), mcp: mcpBad }).kind, "connected");
    assert.equal(deriveConnectorStatus(github, { cli: run({ found: false, exitCode: null }), mcp: mcpBad }).kind, "failed");
    assert.deepEqual(deriveConnectorStatus(github, { cli: run({ exitCode: 1 }), mcp: mcpNone }), { kind: "unset", reason: "not-logged-in" });
  });

  test("即将支持的永远是即将支持；引导型（携程）没有可测通路，恒为未配置", () => {
    assert.deepEqual(deriveConnectorStatus(entry("notion"), {}), { kind: "coming-soon" });
    assert.deepEqual(deriveConnectorStatus(entry("supabase"), { mcp: { present: true, disabled: false, probe: { ok: true, tools: 1 } } }), { kind: "coming-soon" });
    assert.deepEqual(deriveConnectorStatus(entry("ctrip"), {}), { kind: "unset", reason: "no-config" });
  });
});

describe("token 校验与 mcp.json 条目", () => {
  const tencent = entry("tencent-docs");
  const baidu = entry("baidu-netdisk");

  test("去首尾空白与成对引号；空串、中间有空白 / 换行 / 中文、超长都拒绝", () => {
    assert.deepEqual(normalizeConnectorToken(tencent, "  abc123  "), { ok: true, token: "abc123" });
    assert.deepEqual(normalizeConnectorToken(tencent, '"abc123"'), { ok: true, token: "abc123" });
    assert.deepEqual(normalizeConnectorToken(tencent, "   "), { ok: false, problem: "empty" });
    assert.deepEqual(normalizeConnectorToken(tencent, ""), { ok: false, problem: "empty" });
    assert.deepEqual(normalizeConnectorToken(tencent, "ab cd"), { ok: false, problem: "invalid" });
    assert.deepEqual(normalizeConnectorToken(tencent, "ab\r\nX-Evil: 1"), { ok: false, problem: "invalid" });
    assert.deepEqual(normalizeConnectorToken(tencent, "令牌abc"), { ok: false, problem: "invalid" });
    assert.deepEqual(normalizeConnectorToken(tencent, "a".repeat(4097)), { ok: false, problem: "too-long" });
    assert.deepEqual(normalizeConnectorToken(tencent, "a".repeat(4096)), { ok: true, token: "a".repeat(4096) });
  });

  test("百度网盘容忍连 Bearer 前缀一起贴（不变成 Bearer Bearer）；腾讯文档不动前缀", () => {
    assert.deepEqual(normalizeConnectorToken(baidu, "Bearer abc"), { ok: true, token: "abc" });
    assert.deepEqual(normalizeConnectorToken(baidu, "bearer   abc"), { ok: true, token: "abc" });
    assert.deepEqual(normalizeConnectorToken(baidu, "Bearer"), { ok: true, token: "Bearer" });
    assert.deepEqual(normalizeConnectorToken(tencent, "Bearer abc"), { ok: false, problem: "invalid" });
  });

  test("写进 mcp.json 的条目：腾讯文档原样 token + http；百度网盘 Bearer + sse；都能被 parseServer 读回", () => {
    const t = connectorServerConfig(tencent, "tok");
    assert.deepEqual(t, { transport: "http", url: "https://docs.qq.com/openapi/mcp", headers: { Authorization: "tok" } });
    const b = connectorServerConfig(baidu, "tok");
    assert.deepEqual(b, { transport: "sse", url: "https://mcp-pan.baidu.com/sse", headers: { Authorization: "Bearer tok" } });
    assert.deepEqual(parseServer(t), t);
    assert.deepEqual(parseServer(b), b);
  });

  test("不是 mcp-token 的卡不给条目", () => {
    for (const id of ["feishu", "github", "ctrip", "notion", "tabbit"]) assert.equal(connectorServerConfig(entry(id), "tok"), null, id);
  });
});

describe("配置引导文字", () => {
  test("setup：带官方入口、核验日期、「先核验、凭据交用户、实测才算连上」四条规矩；中英都有", () => {
    for (const locale of ["zh", "en"] as const) {
      for (const each of CONNECTORS.filter((c) => opensSetupSession(c))) {
        const text = connectorSetupPrompt(each, each.id, locale);
        assert.ok(text.includes(each.officialUrl), `${each.id}/${locale} 缺官方入口`);
        assert.ok(text.includes(each.verifiedOn), `${each.id}/${locale} 缺核验日期`);
        assert.ok(text.includes("add_mcp_server"), `${each.id}/${locale}`);
        assert.match(text, locale === "zh" ? /不要凭记忆猜/ : /Don't guess/);
        assert.match(text, locale === "zh" ? /只认实测/ : /only counts when tested/);
        assert.match(text, locale === "zh" ? /内置浏览器/ : /built-in browser/);
        assert.match(text, locale === "zh" ? /不要写进日志/ : /out of logs/);
      }
    }
  });

  test("线索按条目来：飞书带命令与状态命令；GitHub 先问选哪条路；携程提示申请 token", () => {
    assert.match(connectorSetupPrompt(entry("feishu"), "飞书", "zh"), /`lark-cli auth status`/);
    const gh = connectorSetupPrompt(entry("github"), "GitHub", "zh");
    assert.match(gh, /先问我选哪条/);
    assert.match(gh, /https:\/\/api\.githubcopilot\.com\/mcp\//);
    assert.match(connectorSetupPrompt(entry("ctrip"), "携程问道", "zh"), /申请 token/);
    assert.match(connectorSetupPrompt(entry("tabbit"), "Tabbit", "zh"), /~\/\.agents\/skills\/tabbit\/SKILL\.md/);
  });

  test("manage：不重新配，只复核现状、讲用法、讲怎么断开", () => {
    const text = connectorSetupPrompt(entry("tabbit"), "Tabbit", "zh", "manage");
    assert.match(text, /已经接好了/);
    assert.match(text, /先别动手/);
    assert.doesNotMatch(text, /add_mcp_server/);
  });
});
