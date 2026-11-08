import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CONNECTORS, findConnector, type ConnectorEntry } from "../../../../shared/connectors.ts";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";
import {
  actionOf,
  configureRoute,
  filterConnectors,
  firstLine,
  loginFailureText,
  manageRoute,
  phaseOf,
  rowSubline,
  statusLine,
  textOf,
  tokenProblemText,
  type ProbeState,
} from "./connectors-view.ts";

const entry = (id: string): ConnectorEntry => {
  const found = findConnector(id);
  assert.ok(found);
  return found;
};

describe("文案齐全", () => {
  test("中英文案都有 11 家，名字 / 说明 / 能力词 / 接入方式不为空；token 型有取 token 的指路", () => {
    for (const messages of [zh, en]) {
      for (const each of CONNECTORS) {
        const text = textOf(messages.connectors, each.id);
        assert.ok(text.name !== "" && text.desc !== "" && text.how !== "", each.id);
        assert.ok(text.caps.length >= 2, each.id);
        if (each.kind === "mcp-token") assert.ok((text.tokenHint ?? "") !== "", `${each.id} 缺 tokenHint`);
      }
    }
  });

  test("品牌名中文界面用中文名（飞书 / 钉钉 / 企业微信 / 腾讯文档 / 携程问道 / 百度网盘）", () => {
    assert.deepEqual(
      ["feishu", "dingtalk", "wecom", "tencent-docs", "ctrip", "baidu-netdisk"].map((id) => textOf(zh.connectors, entry(id).id).name),
      ["飞书", "钉钉", "企业微信", "腾讯文档", "携程问道", "百度网盘"],
    );
  });
});

describe("按钮", () => {
  const t = zh.connectors;
  const checking: ProbeState = { kind: "checking" };
  const unset: ProbeState = { kind: "unset", reason: "no-config" };
  const failed: ProbeState = { kind: "failed", code: "mcp", message: "401" };

  test("OAuth 型：未连接 → 连接；检测中禁用；登录中 → 取消；已连接 → 断开；失败（含需要登录）→ 重新登录；每个阶段都有按钮", () => {
    for (const id of ["notion", "supabase", "pangram"]) {
      const e = entry(id);
      assert.deepEqual(actionOf(t, e, unset), { kind: "connect", disabled: false, tip: t.actionTip.connect });
      assert.deepEqual(actionOf(t, e, checking), { kind: "connect", disabled: true, tip: "检测中…" });
      assert.deepEqual(actionOf(t, e, { kind: "logging-in" }), { kind: "cancel", disabled: false, tip: t.actionTip.cancelLogin });
      assert.deepEqual(actionOf(t, e, { kind: "connected", by: "mcp", tools: 3 }), { kind: "disconnect", disabled: false, tip: t.actionTip.disconnect });
      assert.equal(actionOf(t, e, failed).kind, "login");
      assert.equal(actionOf(t, e, { kind: "failed", code: "login", message: "x" }).kind, "login");
    }
  });

  test("检测中：按钮禁用；未配置 → 配置；失败 → 重新配置；已连接 → 管理", () => {
    const tencent = entry("tencent-docs");
    assert.deepEqual(actionOf(t, tencent, checking), { kind: "configure", disabled: true, tip: "检测中…" });
    assert.equal(actionOf(t, tencent, unset).kind, "configure");
    assert.equal(actionOf(t, tencent, failed).kind, "reconfigure");
    assert.equal(actionOf(t, tencent, { kind: "connected", by: "mcp", tools: 3 }).kind, "manage");
    for (const state of [unset, failed, { kind: "connected", by: "cli" } as ProbeState]) assert.equal(actionOf(t, entry("feishu"), state).disabled, false);
  });

  test("「配置」去哪：命令行与引导型开会话，token 型卡内贴，OAuth 型不走「配置」", () => {
    assert.equal(configureRoute(entry("feishu")), "session");
    assert.equal(configureRoute(entry("github")), "session");
    assert.equal(configureRoute(entry("tabbit")), "session");
    assert.equal(configureRoute(entry("ctrip")), "session");
    assert.equal(configureRoute(entry("tencent-docs")), "token");
    assert.equal(configureRoute(entry("baidu-netdisk")), "token");
    assert.equal(configureRoute(entry("notion")), null);
  });

  test("「管理」去哪：靠远程 MCP 连上的去「已装」，命令行 / 本机的开会话复核", () => {
    assert.equal(manageRoute(entry("tencent-docs"), { kind: "connected", by: "mcp", tools: 1 }), "installed");
    assert.equal(manageRoute(entry("github"), { kind: "connected", by: "mcp", tools: 1 }), "installed");
    assert.equal(manageRoute(entry("github"), { kind: "connected", by: "cli" }), "session");
    assert.equal(manageRoute(entry("tabbit"), { kind: "connected", by: "local" }), "session");
    assert.equal(manageRoute(entry("feishu"), { kind: "connected", by: "cli" }), "session");
  });
});

describe("状态行", () => {
  const t = zh.connectors;
  test("每种状态都有图标 + 文字（颜色只是第二信号）", () => {
    const cases: [ProbeState, string, string][] = [
      [{ kind: "checking" }, "loader-circle", "检测中…"],
      [{ kind: "unset", reason: "no-config" }, "circle-dashed", "未配置"],
      [{ kind: "connected", by: "local" }, "circle-check", "已连接"],
      [{ kind: "failed", code: "mcp", message: "401 unauthorized" }, "triangle-alert", "连接失败"],
      [{ kind: "logging-in" }, "loader-circle", "登录中…"],
      [{ kind: "failed", code: "login", message: "x" }, "triangle-alert", "需要登录"],
    ];
    for (const [state, icon, text] of cases) {
      const line = statusLine(t, entry("tencent-docs"), state);
      assert.deepEqual([line.icon, line.text], [icon, text]);
    }
  });

  test("OAuth 型没连的时候说「未连接」（按钮是「连接」），其余仍是「未配置」", () => {
    assert.equal(statusLine(zh.connectors, entry("notion"), { kind: "unset", reason: "no-config" }).text, "未连接");
    assert.equal(statusLine(zh.connectors, entry("tencent-docs"), { kind: "unset", reason: "no-config" }).text, "未配置");
    assert.equal(statusLine(en.connectors, entry("pangram"), { kind: "unset", reason: "no-config" }).text, "Not connected");
  });

  test("未配置带实测得来的原因：没找到命令（写命令名）/ 未登录 / 已停用；没原因就空", () => {
    assert.equal(statusLine(t, entry("feishu"), { kind: "unset", reason: "cli-missing" }).note, "没找到 lark-cli");
    assert.equal(statusLine(t, entry("feishu"), { kind: "unset", reason: "not-logged-in" }).note, "未登录");
    assert.equal(statusLine(t, entry("tencent-docs"), { kind: "unset", reason: "disabled" }).note, "已停用");
    assert.equal(statusLine(t, entry("tencent-docs"), { kind: "unset", reason: "no-config" }).note, "");
  });

  test("已连接写它是怎么测通的；失败写原因第一行，超时用本地话", () => {
    assert.equal(statusLine(t, entry("tabbit"), { kind: "connected", by: "local" }).note, "已检测到本机安装");
    assert.equal(statusLine(t, entry("tencent-docs"), { kind: "connected", by: "mcp", tools: 7 }).note, "已连通，7 个工具");
    assert.equal(statusLine(t, entry("feishu"), { kind: "failed", code: "timeout", message: "" }).note, "检测超时");
    assert.equal(statusLine(t, entry("feishu"), { kind: "failed", code: "error", message: "EACCES\nstack..." }).note, "EACCES");
    // 服务端回 401 / 403：说成「token 被拒绝」，不摆英文原文；别的错误照原样
    assert.equal(statusLine(t, entry("tencent-docs"), { kind: "failed", code: "mcp", message: "SSE error: Non-200 status code (401)" }).note, "token 被拒绝");
    assert.equal(statusLine(t, entry("tencent-docs"), { kind: "failed", code: "mcp", message: "HTTP 403 Forbidden" }).note, "token 被拒绝");
    // 百度网盘对不对的 token 回 400（实测）：贴 token 的卡把 400 也算被拒；GitHub 这类的 400 不算
    assert.equal(statusLine(t, entry("baidu-netdisk"), { kind: "failed", code: "mcp", message: "SSE error: Non-200 status code (400)" }).note, "token 被拒绝");
    assert.equal(statusLine(t, entry("github"), { kind: "failed", code: "mcp", message: "Non-200 status code (400)" }).note, "Non-200 status code (400)");
    assert.equal(statusLine(t, entry("tencent-docs"), { kind: "failed", code: "mcp", message: "connect ECONNREFUSED 127.0.0.1:9" }).note, "connect ECONNREFUSED 127.0.0.1:9");
    assert.equal(statusLine(t, entry("feishu"), { kind: "failed", code: "error", message: "exit 401" }).note, "exit 401");
  });

  test("原文第一行并限长", () => {
    assert.equal(firstLine("a\nb"), "a");
    assert.equal(firstLine("x".repeat(200)).length, 118);
    assert.equal(firstLine(""), "");
  });

  test("窄档行的小字：已连接 / 失败 / 有原因写具体情形，否则写接入方式", () => {
    assert.equal(rowSubline(t, entry("feishu"), { kind: "unset", reason: "no-config" }), "官方 CLI");
    assert.equal(rowSubline(t, entry("feishu"), { kind: "unset", reason: "cli-missing" }), "没找到 lark-cli");
    assert.equal(rowSubline(t, entry("tabbit"), { kind: "connected", by: "local" }), "已检测到本机安装");
    assert.equal(rowSubline(t, entry("baidu-netdisk"), { kind: "failed", code: "mcp", message: "timeout waiting" }), "timeout waiting");
    assert.equal(rowSubline(t, entry("notion"), { kind: "unset", reason: "no-config" }), "远程 MCP · OAuth");
    assert.equal(rowSubline(t, entry("notion"), { kind: "logging-in" }), "在浏览器里完成授权");
    assert.equal(rowSubline(t, entry("pangram"), { kind: "failed", code: "login", message: "pangram 还没有登录" }), "授权失效或还没登录");
    assert.equal(rowSubline(t, entry("tencent-docs"), { kind: "checking" }), "远程 MCP · token");
  });

  test("phase 就是状态本身（含登录中）", () => {
    assert.equal(phaseOf({ kind: "logging-in" }), "logging-in");
    assert.equal(phaseOf({ kind: "checking" }), "checking");
  });

  test("需要登录的失败：状态行写「需要登录」+ 一句本地话，不摆服务端原文；别的 mcp 失败仍是「连接失败」", () => {
    const line = statusLine(t, entry("notion"), { kind: "failed", code: "login", message: "notion 要求登录（服务端返回 401 并要求 OAuth 授权）" });
    assert.deepEqual([line.text, line.note], ["需要登录", "授权失效或还没登录"]);
    assert.equal(statusLine(t, entry("notion"), { kind: "failed", code: "mcp", message: "ECONNREFUSED" }).text, "连接失败");
    // OAuth 卡的 401 不是「token 被拒绝」（没有 token 可言）
    assert.equal(statusLine(t, entry("notion"), { kind: "failed", code: "mcp", message: "HTTP 401" }).note, "token 被拒绝");
  });
});

describe("token 错误文案与筛选", () => {
  test("校验与写盘错误都有人话，写盘错误带原因", () => {
    const t = zh.connectors.token;
    assert.equal(tokenProblemText(t, "empty", ""), "先贴上 token。");
    assert.match(tokenProblemText(t, "invalid", ""), /空格、换行或中文/);
    assert.match(tokenProblemText(t, "too-long", ""), /太长/);
    assert.equal(tokenProblemText(t, "write-failed", "EACCES"), "没能保存：EACCES");
    assert.match(tokenProblemText(t, "unsupported", ""), /不用贴 token/);
  });

  test("筛选：按名字 / 说明 / 能力词 / id 搜，大小写不敏感；空串全留；顺序不变", () => {
    const t = zh.connectors;
    assert.equal(filterConnectors(t, CONNECTORS, "").length, 11);
    assert.deepEqual(filterConnectors(t, CONNECTORS, "飞书").map((e) => e.id), ["feishu"]);
    assert.deepEqual(filterConnectors(t, CONNECTORS, "GITHUB").map((e) => e.id), ["github"]);
    assert.ok(filterConnectors(t, CONNECTORS, "token").map((e) => e.id).includes("baidu-netdisk"));
    assert.deepEqual(filterConnectors(t, CONNECTORS, "不存在的词"), []);
    const ids = filterConnectors(t, CONNECTORS, "文档").map((e) => e.id);
    assert.deepEqual(ids, CONNECTORS.map((e) => e.id).filter((id) => ids.includes(id)));
  });
});

describe("登录没成时卡上的话", () => {
  const t = zh.connectors.oauth;
  test("取消不算失败（不留话）；超时 / 拒绝说本地话；发现失败与其余带原因第一行", () => {
    assert.equal(loginFailureText(t, { ok: false, code: "cancelled", message: "登录已取消" }), null);
    assert.match(loginFailureText(t, { ok: false, code: "timeout", message: "x" }) ?? "", /5 分钟/);
    assert.match(loginFailureText(t, { ok: false, code: "denied", message: "x" }) ?? "", /拒绝/);
    assert.match(loginFailureText(t, { ok: false, code: "discovery", message: "no dcr\nstack" }) ?? "", /授权信息读不到.*no dcr$/);
    assert.equal(loginFailureText(t, { ok: false, code: "failed", message: "boom\nstack" }), "登录没有成功：boom");
    assert.equal(loginFailureText(t, { ok: false, code: "unsupported", message: "只有远程 MCP" }), "登录没有成功：只有远程 MCP");
  });

  test("中英的 oauth 文案同形状（函数对函数、字符串对字符串）", () => {
    for (const key of Object.keys(zh.connectors.oauth) as (keyof typeof zh.connectors.oauth)[]) {
      assert.equal(typeof en.connectors.oauth[key], typeof zh.connectors.oauth[key], key);
    }
  });
});
