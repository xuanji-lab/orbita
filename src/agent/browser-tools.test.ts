/**
 * 浏览器工具这一层只是翻译：参数 → browserRequest（带发起会话），回执 → pi 工具结果。
 * 浏览器行为本身在主进程（main/browser/），这里用假主进程回执。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RequestBroker } from "./request-broker.ts";
import { createBrowserTools } from "./browser-tools.ts";
import type { BrowserToolOutcome } from "../shared/browser.ts";
import { BROWSER_READ_TOOLS } from "../shared/permission.ts";

const setup = () => {
  const sent: Record<string, unknown>[] = [];
  const broker = new RequestBroker((event) => sent.push(event as Record<string, unknown>));
  const tools = new Map(createBrowserTools(broker, "session-1").map((tool) => [tool.name, tool]));
  const answer = (index: number, outcome: BrowserToolOutcome): void =>
    broker.resolve(String(sent[index]?.["requestId"]), outcome);
  const run = (name: string, params: unknown) =>
    tools.get(name)!.execute("call", params as never, undefined, undefined, undefined as never);
  return { sent, tools, answer, run };
};

const card = { tabId: "t1", url: "https://example.com/", title: "Example" };

describe("browser_* 工具", () => {
  test("名单就是只读四件——与 BROWSER_READ_TOOLS 对齐，免审批的范围不会悄悄变大", () => {
    const { tools } = setup();
    assert.deepEqual([...tools.keys()].sort(), [...BROWSER_READ_TOOLS].sort());
  });

  test("navigate：url 上船，带发起会话；text 进 content、card 进 details", async () => {
    const { sent, answer, run } = setup();
    const pending = run("browser_navigate", { url: "scopus.com" });
    assert.equal(sent[0]?.["type"], "browserRequest");
    assert.equal(sent[0]?.["sessionId"], "session-1");
    assert.deepEqual(sent[0]?.["request"], { action: "navigate", url: "scopus.com" });
    answer(0, { ok: true, text: "Loaded", card });
    const result = await pending;
    assert.deepEqual(result.content, [{ type: "text", text: "Loaded" }]);
    assert.deepEqual(result.details, { browser: card });
  });

  test("navigate 缺 url 当场报错，不发请求", async () => {
    const { sent, run } = setup();
    await assert.rejects(run("browser_navigate", {}), /url is required/);
    assert.equal(sent.length, 0);
  });

  test("extract：只带给了的参数；非 true 的 links 不上船", async () => {
    const { sent, answer, run } = setup();
    const first = run("browser_extract", { offset: 100, links: true });
    assert.deepEqual(sent[0]?.["request"], { action: "extract", offset: 100, links: true });
    answer(0, { ok: true, text: "…", card });
    await first;
    const second = run("browser_extract", { links: "yes" });
    assert.deepEqual(sent[1]?.["request"], { action: "extract" });
    answer(1, { ok: true, text: "…", card });
    await second;
  });

  test("screenshot：图片块跟在文字后面", async () => {
    const { answer, run } = setup();
    const pending = run("browser_screenshot", {});
    answer(0, { ok: true, text: "Screenshot", image: { data: "AAAA", mimeType: "image/jpeg" }, card });
    const result = await pending;
    assert.deepEqual(result.content, [
      { type: "text", text: "Screenshot" },
      { type: "image", data: "AAAA", mimeType: "image/jpeg" },
    ]);
  });

  test("主进程回 ok:false → 工具失败，error 原话给模型", async () => {
    const { answer, run } = setup();
    const pending = run("browser_observe", {});
    answer(0, { ok: false, error: "Page did not respond" });
    await assert.rejects(pending, /Page did not respond/);
  });
});
