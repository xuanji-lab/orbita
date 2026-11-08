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
  test("中英文案都有 10 家，名字 / 说明 / 能力词 / 接入方式不为空；token 型有取 token 的指路", () => {
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

  test("即将支持的没有按钮（不是灰着一个「配置」）", () => {
    assert.equal(actionOf(t, entry("notion"), { kind: "coming-soon" }), null);
    assert.equal(actionOf(t, entry("supabase"), { kind: "coming-soon" }), null);
  });

  test("检测中：按钮禁用；未配置 → 配置；失败 → 重新配置；已连接 → 管理", () => {
    const tencent = entry("tencent-docs");
    assert.deepEqual(actionOf(t, tencent, checking), { kind: "configure", disabled: true, tip: "检测中…" });
    assert.equal(actionOf(t, tencent, unset)?.kind, "configure");
    assert.equal(actionOf(t, tencent, failed)?.kind, "reconfigure");
    assert.equal(actionOf(t, tencent, { kind: "connected", by: "mcp", tools: 3 })?.kind, "manage");
    for (const state of [unset, failed, { kind: "connected", by: "cli" } as ProbeState]) assert.equal(actionOf(t, entry("feishu"), state)?.disabled, false);
  });

  test("「配置」去哪：命令行与引导型开会话，token 型卡内贴，即将支持没有", () => {
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
      [{ kind: "coming-soon" }, "clock", "即将支持"],
    ];
    for (const [state, icon, text] of cases) {
      const line = statusLine(t, entry("tencent-docs"), state);
      assert.deepEqual([line.icon, line.text], [icon, text]);
    }
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
    assert.equal(rowSubline(t, entry("baidu-netdisk"), { kind: "failed", code: "mcp", message: "401" }), "401");
    assert.equal(rowSubline(t, entry("notion"), { kind: "coming-soon" }), "远程 MCP · OAuth");
    assert.equal(rowSubline(t, entry("tencent-docs"), { kind: "checking" }), "远程 MCP · token");
  });

  test("phase 把 coming-soon 归成 soon", () => {
    assert.equal(phaseOf({ kind: "coming-soon" }), "soon");
    assert.equal(phaseOf({ kind: "checking" }), "checking");
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
    assert.equal(filterConnectors(t, CONNECTORS, "").length, 10);
    assert.deepEqual(filterConnectors(t, CONNECTORS, "飞书").map((e) => e.id), ["feishu"]);
    assert.deepEqual(filterConnectors(t, CONNECTORS, "GITHUB").map((e) => e.id), ["github"]);
    assert.ok(filterConnectors(t, CONNECTORS, "token").map((e) => e.id).includes("baidu-netdisk"));
    assert.deepEqual(filterConnectors(t, CONNECTORS, "不存在的词"), []);
    const ids = filterConnectors(t, CONNECTORS, "文档").map((e) => e.id);
    assert.deepEqual(ids, CONNECTORS.map((e) => e.id).filter((id) => ids.includes(id)));
  });
});
