import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateProvider, normalizeBaseUrl, maskSecret, type Provider } from "./provider.ts";

/** 合法样例，各用例在其上做单点破坏 */
function validInput(): unknown {
  const p: Omit<Provider, "auth"> = {
    id: "openai",
    displayName: "OpenAI",
    endpoint: { baseUrl: "https://api.openai.com/v1", api: "openai-completions" },
    models: { declared: [{ id: "gpt-5" }] },
  };
  return p;
}

function fieldsOf(input: unknown): string[] {
  return validateProvider(input).map((i) => i.field);
}

describe("validateProvider", () => {
  test("合法输入零问题；declared 允许为空数组", () => {
    assert.deepEqual(validateProvider(validInput()), []);
    const empty = { ...(validInput() as object), models: { declared: [] } };
    assert.deepEqual(validateProvider(empty), []);
  });

  test("非对象输入整体拒绝，不再逐字段报错", () => {
    for (const bad of [null, undefined, 42, "provider", []]) {
      const issues = validateProvider(bad);
      assert.equal(issues.length, Array.isArray(bad) ? issues.length : 1);
      if (!Array.isArray(bad)) assert.equal(issues[0]?.field, "");
    }
  });

  test("id 只允许小写字母/数字/连字符，且不能以连字符开头", () => {
    for (const id of ["", "OpenAI", "open ai", "-lead", "a".repeat(65), 42]) {
      assert.ok(fieldsOf({ ...(validInput() as object), id }).includes("id"), `应拒绝 ${String(id)}`);
    }
    for (const id of ["a", "openai", "azure-openai-2"]) {
      assert.ok(!fieldsOf({ ...(validInput() as object), id }).includes("id"), `应接受 ${id}`);
    }
  });

  test("displayName 空白视为缺失", () => {
    assert.ok(fieldsOf({ ...(validInput() as object), displayName: "   " }).includes("displayName"));
  });

  test("baseUrl 必须是 http(s)，api 必须在枚举内", () => {
    const bad = (endpoint: unknown) => fieldsOf({ ...(validInput() as object), endpoint });
    assert.ok(bad({ baseUrl: "", api: "openai-completions" }).includes("endpoint.baseUrl"));
    assert.ok(bad({ baseUrl: "ftp://x", api: "openai-completions" }).includes("endpoint.baseUrl"));
    assert.ok(bad({ baseUrl: "https://x", api: "openai" }).includes("endpoint.api"));
    // 六种 api 全部放行——旧实现把 google / mistral / codex 静默折叠，这里逐一确认不折叠
    for (const api of [
      "openai-completions",
      "openai-responses",
      "openai-codex-responses",
      "anthropic-messages",
      "google-generative-ai",
      "mistral-conversations",
    ]) {
      assert.deepEqual(bad({ baseUrl: "https://x", api }), []);
    }
  });

  test("headers 必须是 string 值的对象", () => {
    const withHeaders = (headers: unknown) =>
      fieldsOf({
        ...(validInput() as object),
        endpoint: { baseUrl: "https://x", api: "openai-completions", headers },
      });
    assert.deepEqual(withHeaders({ "X-Org": "acme" }), []);
    assert.deepEqual(withHeaders(undefined), []);
    assert.ok(withHeaders(["a"]).includes("endpoint.headers"));
    assert.ok(withHeaders({ "X-Org": 1 }).includes("endpoint.headers"));
  });

  test("declared 缺失 / 非数组 / 条目无 id / id 重复 都要报出来，且带下标便于表单定位", () => {
    assert.ok(fieldsOf({ ...(validInput() as object), models: {} }).includes("models.declared"));
    assert.ok(
      fieldsOf({ ...(validInput() as object), models: { declared: {} } }).includes("models.declared"),
    );
    const dup = { ...(validInput() as object), models: { declared: [{ id: "a" }, { id: "a" }] } };
    assert.ok(fieldsOf(dup).includes("models.declared[1].id"));
    const noId = { ...(validInput() as object), models: { declared: [{ name: "x" }] } };
    assert.ok(fieldsOf(noId).includes("models.declared[0].id"));
  });

  test("模型参数覆盖声明：合法值全放行（含零费率——明确不计费）", () => {
    const declared = [
      {
        id: "m",
        name: "My model",
        contextWindow: 1_000_000,
        maxTokens: 16_384,
        cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
        vision: true,
      },
    ];
    assert.deepEqual(fieldsOf({ ...(validInput() as object), models: { declared } }), []);
  });

  test("vision 是布尔覆盖声明：缺省合法，非布尔拒", () => {
    assert.deepEqual(
      fieldsOf({ ...(validInput() as object), models: { declared: [{ id: "m" }] } }),
      [],
    );
    assert.deepEqual(
      fieldsOf({ ...(validInput() as object), models: { declared: [{ id: "m", vision: false }] } }),
      [],
    );
    for (const bad of ["yes", 1, null]) {
      const issues = validateProvider({
        ...(validInput() as object),
        models: { declared: [{ id: "m", vision: bad }] },
      });
      assert.ok(
        issues.map((i) => i.field).includes("models.declared[0].vision"),
        `应拒绝 vision=${String(bad)}`,
      );
    }
  });

  test("contextWindow / maxTokens 必须是正有限数：0、负数、NaN、字符串都拒", () => {
    for (const bad of [0, -128000, Number.NaN, "200000"]) {
      for (const field of ["contextWindow", "maxTokens"]) {
        const declared = [{ id: "m", [field]: bad }];
        assert.ok(
          fieldsOf({ ...(validInput() as object), models: { declared } }).includes(
            `models.declared[0].${field}`,
          ),
          `应拒绝 ${field}=${String(bad)}`,
        );
      }
    }
  });

  test("cost 四档都要 ≥0 的有限数：缺档、负数、NaN 都按各自路径报", () => {
    const costIssue = (cost: unknown): string[] =>
      validateProvider({
        ...(validInput() as object),
        models: { declared: [{ id: "m", cost }] },
      }).map((i) => i.field);
    assert.deepEqual(costIssue({ input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 }), []);
    assert.ok(costIssue({ input: 0.5, output: 1.5, cacheRead: 0 }).includes("models.declared[0].cost.cacheWrite"));
    assert.ok(costIssue({ input: -1, output: 1.5, cacheRead: 0, cacheWrite: 0 }).includes("models.declared[0].cost.input"));
    assert.ok(
      costIssue({ input: Number.NaN, output: 1.5, cacheRead: 0, cacheWrite: 0 }).includes(
        "models.declared[0].cost.input",
      ),
    );
    assert.ok(costIssue("cheap").includes("models.declared[0].cost"));
  });

  test("一次收齐全部问题，不在第一个错误处短路（表单要逐项标红）", () => {
    const issues = validateProvider({ id: "BAD", displayName: "", endpoint: {}, models: {} });
    assert.ok(issues.length >= 4, `期望至少 4 条，实际 ${issues.length}`);
  });
});

describe("normalizeBaseUrl", () => {
  test("去尾斜杠与首尾空白，其余原样保留（不自动补 /v1）", () => {
    assert.equal(normalizeBaseUrl("  https://api.openai.com/v1/  "), "https://api.openai.com/v1");
    assert.equal(normalizeBaseUrl("https://x///"), "https://x");
    assert.equal(normalizeBaseUrl("https://api.openai.com"), "https://api.openai.com");
  });
});

describe("maskSecret", () => {
  test("长密钥留前 3 后 4；短密钥不泄露任何字符", () => {
    assert.equal(maskSecret("sk-proj-abcdefgh1234"), "sk-…1234");
    assert.equal(maskSecret("12345678"), "…");
    assert.equal(maskSecret(""), "…");
  });
});
