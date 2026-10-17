/**
 * 浏览器工具这一层只是翻译：参数 → browserRequest（带发起会话），回执 → pi 工具结果。
 * 浏览器行为本身在主进程（main/browser/），这里用假主进程回执。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RequestBroker } from "./request-broker.ts";
import { createBrowserTools } from "./browser-tools.ts";
import type { BrowserToolOutcome } from "../shared/browser.ts";
import { BROWSER_READ_TOOLS, USER_ACTION_TOOL } from "../shared/permission.ts";

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
  test("名单 = 免审批的读取类 + 交接 + 三件交互；交互三件不在免审批名单里——免审批的范围不会悄悄变大", () => {
    const { tools } = setup();
    const actions = ["browser_click", "browser_type", "browser_press"];
    assert.deepEqual([...tools.keys()].sort(), [...BROWSER_READ_TOOLS, USER_ACTION_TOOL, ...actions].sort());
    for (const name of actions) assert.equal((BROWSER_READ_TOOLS as readonly string[]).includes(name), false, name);
  });

  test("request_user_action：带上 toolCallId 与去掉首尾空白的 reason；缺 reason 当场报错", async () => {
    const { sent, tools, answer } = setup();
    const tool = tools.get("request_user_action")!;
    const pending = tool.execute("call-42", { reason: "  Sign in to Scopus  " } as never, undefined, undefined, undefined as never);
    assert.deepEqual(sent[0]?.["request"], { action: "handoff", toolCallId: "call-42", reason: "Sign in to Scopus" });
    answer(0, { ok: true, text: "The user finished", card });
    await pending;
    await assert.rejects(tool.execute("c", {} as never, undefined, undefined, undefined as never), /reason is required/);
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

  test("schema 写明了执行逻辑认的可选参数——模型只看 schema，漏写就等于没有这个选项", () => {
    const { tools } = setup();
    const props = (name: string): string[] =>
      Object.keys((tools.get(name)!.parameters as { properties: Record<string, unknown> }).properties).sort();
    assert.deepEqual(props("browser_screenshot"), ["region", "save", "tab"]);
    assert.deepEqual(props("browser_observe"), ["maxNodes", "tab"]);
    assert.deepEqual(props("browser_extract"), ["format", "links", "maxChars", "offset", "ref", "tab"]);
    assert.deepEqual(props("browser_click"), ["element", "ref", "x", "y"]);
    assert.deepEqual(props("browser_type"), ["clear", "element", "ref", "submit", "text"]);
    assert.deepEqual(props("browser_press"), ["key", "repeat"]);
    assert.deepEqual(props("browser_scroll"), ["amount", "direction", "ref", "x", "y"]);
  });

  test("click：ref 优先；没有 ref 时 x、y 都给了才算坐标（字符串数字也认）；都没有当场报错", async () => {
    const { sent, answer, run } = setup();
    const first = run("browser_click", { element: "Search", ref: " e12 ", x: 5, y: 6 });
    assert.deepEqual(sent[0]?.["request"], { action: "click", target: { ref: "e12" } });
    answer(0, { ok: true, text: "Clicked", card });
    await first;
    const second = run("browser_click", { element: "Chart bar", x: "120", y: 48.5 });
    assert.deepEqual(sent[1]?.["request"], { action: "click", target: { x: 120, y: 48.5 } });
    answer(1, { ok: true, text: "Clicked", card });
    await second;
    await assert.rejects(run("browser_click", { element: "Somewhere", x: 3 }), /Pass ref/);
    assert.equal(sent.length, 2);
  });

  test("type：text 必填；clear 只在明确 false 时上船，submit 只在 true 时上船；空 ref 当没给", async () => {
    const { sent, answer, run } = setup();
    const first = run("browser_type", { element: "Search box", text: "llm review", ref: "e3", submit: true });
    assert.deepEqual(sent[0]?.["request"], { action: "type", text: "llm review", ref: "e3", submit: true });
    answer(0, { ok: true, text: "Typed", card });
    await first;
    const second = run("browser_type", { element: "Focused", text: "", ref: "", clear: false, submit: "yes" });
    assert.deepEqual(sent[1]?.["request"], { action: "type", text: "", clear: false });
    answer(1, { ok: true, text: "Typed", card });
    await second;
    await assert.rejects(run("browser_type", { element: "Box" }), /text is required/);
  });

  test("press：key 必填，repeat 可选", async () => {
    const { sent, answer, run } = setup();
    const pending = run("browser_press", { key: "ArrowDown", repeat: 3 });
    assert.deepEqual(sent[0]?.["request"], { action: "press", key: "ArrowDown", repeat: 3 });
    answer(0, { ok: true, text: "Pressed", card });
    await pending;
    await assert.rejects(run("browser_press", { key: " " }), /key is required/);
  });

  test("scroll：方向必须是四个之一；amount 与落点可选", async () => {
    const { sent, answer, run } = setup();
    const pending = run("browser_scroll", { direction: "down", amount: 2, ref: "e40" });
    assert.deepEqual(sent[0]?.["request"], { action: "scroll", direction: "down", amount: 2, target: { ref: "e40" } });
    answer(0, { ok: true, text: "Scrolled", card });
    await pending;
    await assert.rejects(run("browser_scroll", { direction: "sideways" }), /direction must be/);
  });

  test("navigate：back / forward（不分大小写）走历史，不当搜索词", async () => {
    const { sent, answer, run } = setup();
    const pending = run("browser_navigate", { url: " Back " });
    assert.deepEqual(sent[0]?.["request"], { action: "history", direction: "back" });
    answer(0, { ok: true, text: "Went back", card });
    await pending;
  });

  test("screenshot：region 四个数都给了才上船", async () => {
    const { sent, answer, run } = setup();
    const first = run("browser_screenshot", { region: { x: 10, y: 20, width: 300, height: 200 } });
    assert.deepEqual(sent[0]?.["request"], { action: "screenshot", region: { x: 10, y: 20, width: 300, height: 200 } });
    answer(0, { ok: true, text: "Zoomed", card });
    await first;
    const second = run("browser_screenshot", { region: { x: 10, y: 20 } });
    assert.deepEqual(sent[1]?.["request"], { action: "screenshot" });
    answer(1, { ok: true, text: "Shot", card });
    await second;
  });

  test("browser_tabs：无参上船", async () => {
    const { sent, answer, run } = setup();
    const pending = run("browser_tabs", {});
    assert.deepEqual(sent[0]?.["request"], { action: "tabs" });
    answer(0, { ok: true, text: "tabs", card });
    await pending;
  });

  test("navigate 缺 url 当场报错，不发请求", async () => {
    const { sent, run } = setup();
    await assert.rejects(run("browser_navigate", {}), /url is required/);
    assert.equal(sent.length, 0);
  });

  test("tab 参数：非空字符串才上船（去掉首尾空白），空串与非字符串当没给", async () => {
    const { sent, answer, run } = setup();
    const first = run("browser_observe", { tab: " 5c1e2a90 " });
    assert.deepEqual(sent[0]?.["request"], { action: "observe", tab: "5c1e2a90" });
    answer(0, { ok: true, text: "…", card });
    await first;
    const second = run("browser_extract", { tab: "" });
    assert.deepEqual(sent[1]?.["request"], { action: "extract" });
    answer(1, { ok: true, text: "…", card });
    await second;
    const third = run("browser_observe", { tab: 3 });
    assert.deepEqual(sent[2]?.["request"], { action: "observe" });
    answer(2, { ok: true, text: "…", card });
    await third;
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

  test("extract：format 只认 markdown，ref 去空白后上船（空串与非字符串当没给）", async () => {
    const { sent, answer, run } = setup();
    const first = run("browser_extract", { format: "markdown", ref: " e12 " });
    assert.deepEqual(sent[0]?.["request"], { action: "extract", format: "markdown", ref: "e12" });
    answer(0, { ok: true, text: "…", card });
    await first;
    const second = run("browser_extract", { format: "text", ref: "" });
    assert.deepEqual(sent[1]?.["request"], { action: "extract" });
    answer(1, { ok: true, text: "…", card });
    await second;
  });

  test("screenshot：save 与用户 tab 的 id 上船；图片块跟在文字后面", async () => {
    const { sent, answer, run } = setup();
    const first = run("browser_screenshot", { save: true, tab: "5c1e2a90" });
    assert.deepEqual(sent[0]?.["request"], { action: "screenshot", save: true, tab: "5c1e2a90" });
    answer(0, { ok: true, text: "Screenshot", image: { data: "AAAA", mimeType: "image/jpeg" }, card });
    const result = await first;
    assert.deepEqual(result.content, [
      { type: "text", text: "Screenshot" },
      { type: "image", data: "AAAA", mimeType: "image/jpeg" },
    ]);
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

  test("这一轮被停掉：不等主进程回执，立刻放手（交接可能要等半小时）", async () => {
    const { tools } = setup();
    const controller = new AbortController();
    const pending = tools
      .get("request_user_action")!
      .execute("c", { reason: "Sign in" } as never, controller.signal, undefined, undefined as never);
    controller.abort();
    await assert.rejects(pending, /Stopped/);
    const already = new AbortController();
    already.abort();
    await assert.rejects(
      tools.get("browser_observe")!.execute("c", {} as never, already.signal, undefined, undefined as never),
      /Stopped/,
    );
  });

  test("主进程回 ok:false → 工具失败，error 原话给模型", async () => {
    const { answer, run } = setup();
    const pending = run("browser_observe", {});
    answer(0, { ok: false, error: "Page did not respond" });
    await assert.rejects(pending, /Page did not respond/);
  });
});
