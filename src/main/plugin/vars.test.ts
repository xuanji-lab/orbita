import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { McpServer } from "../../shared/mcp.ts";
import type { PluginConfigField } from "../../shared/plugin.ts";
import { formatCommandLine, MASKED_VALUE, substituteServer, substituteString, type VarContext } from "./vars.ts";

const field = (over: Partial<PluginConfigField> & { key: string }): PluginConfigField => ({
  type: "string",
  title: over.key,
  description: "",
  required: false,
  sensitive: false,
  default: null,
  options: null,
  multiple: false,
  min: null,
  max: null,
  ...over,
});

const context = (over: Partial<VarContext> = {}): VarContext => ({
  root: "/plugins/p",
  dataDir: "/data/p",
  fields: [],
  values: {},
  mask: false,
  ...over,
});

describe("substituteString", () => {
  test("换 ${CLAUDE_PLUGIN_ROOT} 与 ${CLAUDE_PLUGIN_DATA}，同一串里可出现多次", () => {
    const result = substituteString("${CLAUDE_PLUGIN_ROOT}/a:${CLAUDE_PLUGIN_ROOT}/b:${CLAUDE_PLUGIN_DATA}", context());
    assert.equal(result.value, "/plugins/p/a:/plugins/p/b:/data/p");
    assert.equal(result.problem, null);
  });

  test("ZCode 的 ZCODE_ 前缀按同义认", () => {
    const result = substituteString("${ZCODE_PLUGIN_ROOT}|${ZCODE_PLUGIN_DATA}", context());
    assert.equal(result.value, "/plugins/p|/data/p");
  });

  test("项目根变量换成已有的 ${workspaceFolder} 占位，交给开轮装配统一解析", () => {
    assert.equal(substituteString("${CLAUDE_PROJECT_DIR}/x", context()).value, "${workspaceFolder}/x");
    assert.equal(substituteString("${ZCODE_PROJECT_DIR}", context()).value, "${workspaceFolder}");
    assert.equal(substituteString("${workspaceFolder}/y", context()).value, "${workspaceFolder}/y");
  });

  test("${user_config.KEY}：取已存的值；没存取默认；非必填缺省是空串", () => {
    const fields = [field({ key: "a" }), field({ key: "b", default: "dflt" }), field({ key: "c" })];
    const ctx = context({ fields, values: { a: "va" } });
    assert.equal(substituteString("${user_config.a}-${user_config.b}-[${user_config.c}]", ctx).value, "va-dflt-[]");
  });

  test("必填而没填：报 config-missing，变量原样留着", () => {
    const ctx = context({ fields: [field({ key: "token", required: true })] });
    const result = substituteString("t=${user_config.token}", ctx);
    assert.deepEqual(result.problem, { kind: "config-missing", key: "token" });
    assert.equal(result.value, "t=${user_config.token}");
  });

  test("敏感值：装配时给明文，展示时掩码", () => {
    const fields = [field({ key: "k", sensitive: true })];
    const real = context({ fields, values: { k: "secret" } });
    assert.equal(substituteString("${user_config.k}", real).value, "secret");
    assert.equal(substituteString("${user_config.k}", { ...real, mask: true }).value, MASKED_VALUE);
  });

  test("数组与布尔 / 数字按字面渲染", () => {
    const fields = [field({ key: "l", multiple: true }), field({ key: "n", type: "number" }), field({ key: "b", type: "boolean" })];
    const ctx = context({ fields, values: { l: ["x", "y"], n: 3, b: false } });
    assert.equal(substituteString("${user_config.l}|${user_config.n}|${user_config.b}", ctx).value, "x,y|3|false");
  });

  test("没声明的配置键、不认识的变量：原样留着并报 unknown-variable，不猜", () => {
    const a = substituteString("${user_config.ghost}", context());
    assert.deepEqual(a.problem, { kind: "unknown-variable", variable: "user_config.ghost" });
    const b = substituteString("${ZCODE_BASE_URL}/api", context());
    assert.deepEqual(b.problem, { kind: "unknown-variable", variable: "ZCODE_BASE_URL" });
    assert.equal(b.value, "${ZCODE_BASE_URL}/api");
  });

  test("多个问题只报第一个，已知变量照常替换", () => {
    const result = substituteString("${CLAUDE_PLUGIN_ROOT} ${A} ${B}", context());
    assert.equal(result.value, "/plugins/p ${A} ${B}");
    assert.deepEqual(result.problem, { kind: "unknown-variable", variable: "A" });
  });
});

describe("substituteServer", () => {
  test("stdio：command / args / env / cwd 全覆盖，不改入参", () => {
    const server: McpServer = {
      transport: "stdio",
      command: "${CLAUDE_PLUGIN_ROOT}/bin/run",
      args: ["--data", "${CLAUDE_PLUGIN_DATA}", "plain"],
      env: { A: "${CLAUDE_PLUGIN_ROOT}", B: "x" },
      cwd: "${CLAUDE_PROJECT_DIR}",
    };
    const snapshot = JSON.stringify(server);
    const { server: out, problem } = substituteServer(server, context());
    assert.equal(problem, null);
    assert.deepEqual(out, {
      transport: "stdio",
      command: "/plugins/p/bin/run",
      args: ["--data", "/data/p", "plain"],
      env: { A: "/plugins/p", B: "x" },
      cwd: "${workspaceFolder}",
    });
    assert.equal(JSON.stringify(server), snapshot);
  });

  test("http：url 与 headers 全覆盖", () => {
    const server: McpServer = {
      transport: "http",
      url: "https://x/${user_config.path}",
      headers: { Authorization: "Bearer ${user_config.token}" },
    };
    const ctx = context({ fields: [field({ key: "path" }), field({ key: "token", sensitive: true })], values: { path: "mcp", token: "t0k" } });
    const { server: out } = substituteServer(server, { ...ctx, mask: true });
    assert.deepEqual(out, { transport: "http", url: "https://x/mcp", headers: { Authorization: `Bearer ${MASKED_VALUE}` } });
  });

  test("任何一个字段里的未知变量都会让整台 server 带上问题", () => {
    const { problem } = substituteServer({ transport: "stdio", command: "ok", env: { K: "${NOPE}" } }, context());
    assert.deepEqual(problem, { kind: "unknown-variable", variable: "NOPE" });
  });
});

describe("formatCommandLine", () => {
  test("含空格或引号的参数加双引号，路径里的空格（ZCode Helper）不被拆开", () => {
    const line = formatCommandLine({
      transport: "stdio",
      command: "/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper",
      args: ["server.js", "--name", 'a "b"'],
    });
    assert.equal(
      line,
      '"/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper" server.js --name "a \\"b\\""',
    );
  });
  test("http 就是 URL", () => {
    assert.equal(formatCommandLine({ transport: "http", url: "https://x/mcp" }), "https://x/mcp");
  });
});
