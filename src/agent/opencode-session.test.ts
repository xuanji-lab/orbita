import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { withOpencodeSession } from "./opencode-session.ts";

/** OpenCode Go 预设同形的 provider：静态占位头 + 一个自定义头 */
const opencodeGo = {
  id: "opencode-go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  headers: { "x-opencode-session": "orbita", "x-custom": "keep-me" },
};

/** 官方 DeepSeek：不该被这条链路碰到 */
const deepseek = {
  id: "deepseek",
  baseUrl: "https://api.deepseek.com",
  headers: { "x-opencode-session": "orbita" },
};

describe("withOpencodeSession", () => {
  test("OpenCode 端点：会话 id 换掉占位值，自定义头原样保留", () => {
    const wrapped = withOpencodeSession(opencodeGo, "sess-abc");
    assert.notEqual(wrapped, opencodeGo);
    assert.equal(wrapped.headers["x-opencode-session"], "sess-abc");
    assert.equal(wrapped.headers["x-custom"], "keep-me");
    // 原对象不被原地改写（配置是共用的）
    assert.equal(opencodeGo.headers["x-opencode-session"], "orbita");
    // 其余字段照抄
    assert.equal(wrapped.id, opencodeGo.id);
    assert.equal(wrapped.baseUrl, opencodeGo.baseUrl);
  });

  test("同一个 provider 两个会话 → 两个不同的头值（按会话，不是常量）", () => {
    const first = withOpencodeSession(opencodeGo, "sess-1");
    const second = withOpencodeSession(opencodeGo, "sess-2");
    assert.equal(first.headers["x-opencode-session"], "sess-1");
    assert.equal(second.headers["x-opencode-session"], "sess-2");
    assert.notEqual(first.headers["x-opencode-session"], second.headers["x-opencode-session"]);
  });

  test("官方 DeepSeek：原样返回（引用相同），不受影响", () => {
    assert.equal(withOpencodeSession(deepseek, "sess-abc"), deepseek);
  });

  test("baseUrl 不是合法 URL：原样返回", () => {
    const broken = { id: "自制网关", baseUrl: "not a url", headers: { "x-opencode-session": "orbita" } };
    assert.equal(withOpencodeSession(broken, "sess-abc"), broken);
  });

  test("没有 headers 的 provider：补出会话头", () => {
    const bare: { id: string; baseUrl: string; headers?: Record<string, string> } = {
      id: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
    };
    const wrapped = withOpencodeSession(bare, "sess-abc");
    assert.equal(wrapped.headers?.["x-opencode-session"], "sess-abc");
  });
});
