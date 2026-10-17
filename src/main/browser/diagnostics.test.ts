/**
 * 诊断缓冲（diagnostics.ts）——纯逻辑，直接测：
 *   RingBuffer      容量、丢弃顺序、清空
 *   TabDiagnostics  CDP 事件 → 条目（控制台三类来源、网络三类事件）、过滤
 *   format*Report   给模型的文字：空缓冲 / 采集刚打开 / 截断计数
 * CDP 的接线（懒 enable、事件监听）在 diagnostics-recorder.ts，靠真应用验收，这里不测。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  formatConsoleReport,
  formatNetworkReport,
  MainDocumentWatcher,
  RingBuffer,
  TabDiagnostics,
  type ConsoleEntry,
  type NetworkEntry,
} from "./diagnostics.ts";
import { BROWSER_DIAGNOSTICS_BUFFER_LIMIT } from "../../shared/browser.ts";

describe("RingBuffer", () => {
  test("容量必须正整数", () => {
    assert.throws(() => new RingBuffer<number>(0), /容量/);
    assert.throws(() => new RingBuffer<number>(1.5), /容量/);
  });

  test("未满时 push 回 undefined；满了之后回被挤掉的那条，顺序始终从旧到新", () => {
    const buffer = new RingBuffer<number>(3);
    assert.equal(buffer.push(1), undefined);
    assert.equal(buffer.push(2), undefined);
    assert.equal(buffer.push(3), undefined);
    assert.equal(buffer.size, 3);
    assert.deepEqual(buffer.toArray(), [1, 2, 3]);
    assert.equal(buffer.push(4), 1);
    assert.equal(buffer.push(5), 2);
    assert.deepEqual(buffer.toArray(), [3, 4, 5]);
    assert.equal(buffer.size, 3);
  });

  test("clear 之后回到空，push 重新从容量算起", () => {
    const buffer = new RingBuffer<string>(2);
    buffer.push("a");
    buffer.push("b");
    buffer.clear();
    assert.equal(buffer.size, 0);
    assert.deepEqual(buffer.toArray(), []);
    assert.equal(buffer.push("c"), undefined);
    assert.deepEqual(buffer.toArray(), ["c"]);
  });
});

describe("TabDiagnostics：控制台", () => {
  const consoleEvent = (type: string, args: unknown[], url = "https://x.test/app.js", line = 41): unknown => ({
    type,
    args,
    stackTrace: { callFrames: [{ url, lineNumber: line }] },
  });

  test("Runtime.consoleAPICalled：级别映射、参数拼成一行、堆栈首帧给出处（行号 1 起）", () => {
    const state = new TabDiagnostics();
    state.onConsoleApiCalled(consoleEvent("log", [{ type: "string", value: "hello" }, { type: "number", value: 42 }]));
    state.onConsoleApiCalled(consoleEvent("warning", [{ type: "string", value: "careful" }]));
    state.onConsoleApiCalled(consoleEvent("error", [{ type: "object", className: "Object", description: "Object" }]));
    state.onConsoleApiCalled(consoleEvent("assert", [{ type: "string", value: "boom" }]));
    state.onConsoleApiCalled(consoleEvent("table", [{ type: "string", value: "rows" }]));
    state.onConsoleApiCalled(consoleEvent("debug", [{ type: "string", value: "trace" }]));
    const entries = state.consoleMessages();
    assert.deepEqual(
      entries.map((entry) => [entry.level, entry.text, entry.where]),
      [
        ["log", "hello 42", "https://x.test/app.js:42"],
        ["warn", "careful", "https://x.test/app.js:42"],
        ["error", "Object", "https://x.test/app.js:42"],
        ["error", "boom", "https://x.test/app.js:42"],
        ["log", "rows", "https://x.test/app.js:42"],
        ["debug", "trace", "https://x.test/app.js:42"],
      ],
    );
  });

  test("参数文本：字符串原样、null / undefined / NaN 认得出、对象退回 description", () => {
    const state = new TabDiagnostics();
    state.onConsoleApiCalled(
      consoleEvent("log", [
        { type: "object", subtype: "null", value: null },
        { type: "undefined" },
        { type: "number", unserializableValue: "NaN" },
        { type: "object", className: "Array", description: "Array(3)" },
      ]),
    );
    assert.equal(state.consoleMessages()[0]?.text, "null undefined NaN Array(3)");
  });

  test("Runtime.exceptionThrown：算 error，优先用带栈的 description；没有 url 时出处留空", () => {
    const state = new TabDiagnostics();
    state.onExceptionThrown({
      exceptionDetails: { text: "Uncaught", url: "https://x.test/app.js", lineNumber: 9, exception: { description: "TypeError: nope\n  at app.js:10" } },
    });
    state.onExceptionThrown({ exceptionDetails: { text: "Uncaught ReferenceError", exception: {} } });
    const entries = state.consoleMessages();
    assert.deepEqual(entries[0], { level: "error", text: "TypeError: nope\n  at app.js:10", where: "https://x.test/app.js:10" });
    assert.deepEqual(entries[1], { level: "error", text: "Uncaught ReferenceError", where: "" });
  });

  test("Log.entryAdded：网络 / CORS 类浏览器级错误在这里，级别按 verbose/info/warning/error 映射", () => {
    const state = new TabDiagnostics();
    state.onLogEntryAdded({ entry: { level: "error", text: "Failed to load resource: net::ERR_FAILED", url: "https://x.test/api", lineNumber: 0 } });
    state.onLogEntryAdded({ entry: { level: "verbose", text: "deprecation" } });
    const entries = state.consoleMessages();
    assert.deepEqual(entries[0], { level: "error", text: "Failed to load resource: net::ERR_FAILED", where: "https://x.test/api:0" });
    assert.equal(entries[1]?.level, "debug");
    assert.equal(entries[1]?.where, "");
  });

  test("按最低级别过滤：error 只剩 error；缺席 = 全给", () => {
    const state = new TabDiagnostics();
    for (const type of ["log", "info", "warning", "error"]) state.onConsoleApiCalled(consoleEvent(type, [{ type: "string", value: type }]));
    assert.deepEqual(state.consoleMessages("warn").map((entry) => entry.level), ["warn", "error"]);
    assert.deepEqual(state.consoleMessages("error").map((entry) => entry.level), ["error"]);
    assert.equal(state.consoleMessages().length, 4);
  });

  test("超上限丢最旧，且单条正文被截断（异常栈不该撑爆一次结果）", () => {
    const state = new TabDiagnostics();
    for (let i = 0; i < BROWSER_DIAGNOSTICS_BUFFER_LIMIT + 5; i += 1) {
      state.onConsoleApiCalled(consoleEvent("log", [{ type: "string", value: `m${i}` }]));
    }
    assert.equal(state.consoleCount, BROWSER_DIAGNOSTICS_BUFFER_LIMIT);
    const entries = state.consoleMessages();
    assert.equal(entries[0]?.text, "m5");
    assert.equal(entries.at(-1)?.text, `m${BROWSER_DIAGNOSTICS_BUFFER_LIMIT + 4}`);

    const long = new TabDiagnostics();
    long.onExceptionThrown({ exceptionDetails: { text: "x", exception: { description: "y".repeat(2000) } } });
    const text = long.consoleMessages()[0]?.text ?? "";
    assert.equal(text.length, 401);
    assert.equal(text.endsWith("…"), true);
  });

  test("clear 清空两个域", () => {
    const state = new TabDiagnostics();
    state.onConsoleApiCalled(consoleEvent("log", [{ type: "string", value: "x" }]));
    state.onRequestWillBeSent({ requestId: "1", request: { url: "https://x.test/", method: "GET" } });
    state.clear();
    assert.equal(state.consoleCount, 0);
    assert.equal(state.networkCount, 0);
  });
});

describe("MainDocumentWatcher：主文档换页判定（CDP 侧）", () => {
  const frameTree = (id: string, loaderId: string): unknown => ({ frameTree: { frame: { id, loaderId } } });
  const documentRequest = (frameId: string, loaderId: string, requestId = "doc"): unknown => ({
    requestId,
    type: "Document",
    frameId,
    loaderId,
    request: { url: "https://x.test/", method: "GET" },
  });

  test("setFrameTree：认得根帧与 loaderId；形状不认识回 false 且保持未就绪", () => {
    const watcher = new MainDocumentWatcher();
    assert.equal(watcher.setFrameTree(frameTree("F1", "L1")), true);
    assert.equal(watcher.ready, true);

    const broken = new MainDocumentWatcher();
    assert.equal(broken.setFrameTree({ frameTree: {} }), false);
    assert.equal(broken.ready, false);
    assert.equal(broken.observe(documentRequest("F1", "L2")), false, "没就绪时绝不清缓冲，交给 did-navigate 兜底");
  });

  test("主帧新 Document 且 loaderId 变了 = 新一份主文档；同一 loaderId 的重定向不算", () => {
    const watcher = new MainDocumentWatcher();
    watcher.setFrameTree(frameTree("F1", "L1"));
    assert.equal(watcher.observe(documentRequest("F1", "L2")), true);
    assert.equal(watcher.observe(documentRequest("F1", "L2", "doc-redirect")), false, "重定向同 loaderId");
    assert.equal(watcher.observe(documentRequest("F1", "L3")), true, "再换一页也算");
  });

  test("子帧 Document、非 Document（XHR / 图片）都不算换页", () => {
    const watcher = new MainDocumentWatcher();
    watcher.setFrameTree(frameTree("F1", "L1"));
    assert.equal(watcher.observe(documentRequest("F2", "L2")), false, "iframe 自己的文档");
    assert.equal(
      watcher.observe({ requestId: "xhr", type: "XHR", frameId: "F1", loaderId: "L2", request: { url: "https://x.test/api", method: "GET" } }),
      false,
    );
    assert.equal(watcher.observe({ requestId: "img", type: "Image", frameId: "F1", request: { url: "https://x.test/i.png", method: "GET" } }), false);
  });

  test("换页顺序：先清再记，主文档 403 留在新缓冲里（评审情景回归）", () => {
    const state = new TabDiagnostics();
    state.onRequestWillBeSent({ requestId: "old", request: { url: "https://x.test/old", method: "GET" } });
    state.onConsoleApiCalled({ type: "log", args: [{ type: "string", value: "old page" }] });
    const watcher = new MainDocumentWatcher();
    watcher.setFrameTree(frameTree("F1", "L1"));

    const mainDocument = documentRequest("F1", "L2", "doc2");
    if (watcher.observe(mainDocument)) state.clear();
    state.onRequestWillBeSent(mainDocument);
    state.onResponseReceived({ requestId: "doc2", response: { status: 403, mimeType: "text/html" } });

    assert.deepEqual(state.networkRequests({ limit: 10 }), [
      { id: "doc2", method: "GET", url: "https://x.test/", status: 403, mimeType: "text/html" },
    ]);
    assert.equal(state.networkCount, 1);
    assert.equal(state.consoleCount, 0, "上一页的控制台消息不带到新页");
  });
});

describe("TabDiagnostics：网络", () => {
  test("requestWillBeSent → responseReceived：状态码与 MIME 落到同一条；没有响应的条目 status 缺席", () => {
    const state = new TabDiagnostics();
    state.onRequestWillBeSent({ requestId: "1", request: { url: "https://x.test/", method: "GET" } });
    state.onRequestWillBeSent({ requestId: "2", request: { url: "https://x.test/api", method: "POST" } });
    state.onResponseReceived({ requestId: "1", response: { url: "https://x.test/", status: 200, mimeType: "text/html" } });
    const entries = state.networkRequests({ limit: 10 });
    assert.deepEqual(entries[0], { id: "1", method: "GET", url: "https://x.test/", status: 200, mimeType: "text/html" });
    assert.deepEqual(entries[1], { id: "2", method: "POST", url: "https://x.test/api" });
  });

  test("重定向（同 requestId 再发一次 requestWillBeSent）在原条目上更新，不变成两条", () => {
    const state = new TabDiagnostics();
    state.onRequestWillBeSent({ requestId: "1", request: { url: "http://x.test/", method: "GET" } });
    state.onRequestWillBeSent({ requestId: "1", request: { url: "https://x.test/", method: "GET" } });
    state.onResponseReceived({ requestId: "1", response: { status: 200, mimeType: "text/html" } });
    assert.equal(state.networkCount, 1);
    assert.equal(state.networkRequests({ limit: 10 })[0]?.url, "https://x.test/");
  });

  test("loadingFailed 记失败原因；canceled 的丢掉（导航换页会取消在途请求，不是错误）", () => {
    const state = new TabDiagnostics();
    state.onRequestWillBeSent({ requestId: "1", request: { url: "https://x.test/api", method: "GET" } });
    state.onRequestWillBeSent({ requestId: "2", request: { url: "https://x.test/img.png", method: "GET" } });
    state.onLoadingFailed({ requestId: "1", errorText: "net::ERR_FAILED", blockedReason: "cors" });
    state.onLoadingFailed({ requestId: "2", errorText: "net::ERR_ABORTED", canceled: true });
    const entries = state.networkRequests({ limit: 10 });
    assert.equal(entries[0]?.failure, "net::ERR_FAILED (cors)");
    assert.equal(entries[1]?.failure, undefined);
  });

  test("响应 / 失败对不上 requestId 时静默忽略", () => {
    const state = new TabDiagnostics();
    state.onResponseReceived({ requestId: "missing", response: { status: 500 } });
    state.onLoadingFailed({ requestId: "missing", errorText: "net::ERR_FAILED" });
    assert.equal(state.networkCount, 0);
  });

  test("超上限丢最旧；被挤掉的条目不再接受响应", () => {
    const state = new TabDiagnostics();
    for (let i = 0; i < BROWSER_DIAGNOSTICS_BUFFER_LIMIT + 1; i += 1) {
      state.onRequestWillBeSent({ requestId: `r${i}`, request: { url: `https://x.test/${i}`, method: "GET" } });
    }
    assert.equal(state.networkCount, BROWSER_DIAGNOSTICS_BUFFER_LIMIT);
    assert.equal(state.networkRequests({ limit: 10 })[0]?.url, "https://x.test/1");
    state.onResponseReceived({ requestId: "r0", response: { status: 200 } });
    assert.equal(state.networkRequests({ limit: 10 }).some((entry) => entry.status === 200), false);
  });

  test("过滤：URL 子串不区分大小写；状态码闭区间；加载失败的条目在给了状态范围后不再匹配", () => {
    const state = new TabDiagnostics();
    state.onRequestWillBeSent({ requestId: "1", request: { url: "https://X.test/Api/Users", method: "GET" } });
    state.onRequestWillBeSent({ requestId: "2", request: { url: "https://x.test/style.css", method: "GET" } });
    state.onRequestWillBeSent({ requestId: "3", request: { url: "https://x.test/api/orders", method: "POST" } });
    state.onResponseReceived({ requestId: "1", response: { status: 401, mimeType: "application/json" } });
    state.onResponseReceived({ requestId: "2", response: { status: 200, mimeType: "text/css" } });
    state.onLoadingFailed({ requestId: "3", errorText: "net::ERR_FAILED" });

    assert.deepEqual(state.networkRequests({ url: "api", limit: 10 }).map((entry) => entry.id), ["1", "3"]);
    assert.deepEqual(state.networkRequests({ statusMin: 400, limit: 10 }).map((entry) => entry.id), ["1"]);
    assert.deepEqual(state.networkRequests({ statusMin: 200, statusMax: 299, limit: 10 }).map((entry) => entry.id), ["2"]);
    assert.deepEqual(state.networkRequests({ url: "api", statusMin: 500, limit: 10 }), []);
    // 不给状态范围时失败条目照给（CORS / 网络错误正是要看的）
    assert.deepEqual(state.networkRequests({ limit: 10 }).map((entry) => entry.id), ["1", "2", "3"]);
  });
});

describe("给模型的报告", () => {
  const page = { url: "https://x.test/", title: "Broken" };
  const consoleEntry = (level: ConsoleEntry["level"], text: string): ConsoleEntry => ({ level, text, where: "" });
  const networkEntry = (id: string, over: Partial<NetworkEntry> = {}): NetworkEntry => ({
    id,
    method: "GET",
    url: `https://x.test/${id}`,
    ...over,
  });

  test("控制台：URL / 标题 + 不可信标注 + 每条一行；limit 取最近的，计数如实说", () => {
    const entries = [consoleEntry("error", "boom"), consoleEntry("warn", "careful"), consoleEntry("log", "hi")];
    const text = formatConsoleReport(page, entries, { limit: 2 }, false, 3);
    assert.match(text, /^URL: https:\/\/x\.test\/\nTitle: Broken\n<console-messages untrusted>\n/);
    assert.match(text, /\[warn\] careful\n\[log\] hi\n<\/console-messages>/);
    assert.match(text, /2 of 3 message\(s\) shown \(most recent\)\./);
  });

  test("控制台：空缓冲 + 采集刚打开 → 说清只记从现在起的事，并让模型重载", () => {
    const text = formatConsoleReport(page, [], { limit: 100 }, true, 0);
    assert.match(text, /Capture was just turned on/);
    assert.match(text, /reload the page/);
  });

  test("控制台：空缓冲但不是刚打开 → 只说没有；都被级别滤掉时说清还剩几条", () => {
    assert.match(formatConsoleReport(page, [], { limit: 100 }, false, 0), /No console messages in the buffer\./);
    const filtered = formatConsoleReport(page, [], { level: "error", limit: 100 }, false, 7);
    assert.match(filtered, /No console messages at level error or above \(7 lower-level message\(s\) in the buffer\)\./);
  });

  test("网络：状态码 / MIME / FAILED / 未响应四种行；过滤器与计数在脚注", () => {
    const entries = [
      networkEntry("1", { status: 200, mimeType: "text/html" }),
      networkEntry("2", { status: 401, mimeType: "application/json" }),
      networkEntry("3", { failure: "net::ERR_FAILED" }),
      networkEntry("4"),
    ];
    const text = formatNetworkReport(page, entries, { url: "x.test", statusMin: 400, limit: 100 }, false, 4);
    assert.match(text, /GET https:\/\/x\.test\/1 → 200 text\/html/);
    assert.match(text, /GET https:\/\/x\.test\/2 → 401 application\/json/);
    assert.match(text, /GET https:\/\/x\.test\/3 → FAILED net::ERR_FAILED/);
    assert.match(text, /GET https:\/\/x\.test\/4 → \(no response yet\)/);
    assert.match(text, /4 of 4 request\(s\) shown matching url contains "x\.test", status 400–…\./);
  });

  test("网络：空缓冲 + 采集刚打开 → 同样提示重载", () => {
    const text = formatNetworkReport(page, [], { limit: 100 }, true, 0);
    assert.match(text, /Capture was just turned on/);
    assert.match(text, /reload the page/);
  });

  test("网络：都被过滤器滤掉时说清过滤器与缓冲里的条数", () => {
    const text = formatNetworkReport(page, [], { statusMin: 500, limit: 100 }, false, 12);
    assert.match(text, /No network requests matched the filter matching status 500–… \(12 in the buffer\)\./);
  });
});
