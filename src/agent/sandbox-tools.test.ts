/**
 * sandbox_* 工具层的账：参数 → computerUseRequest → pi 工具结果。
 *
 * 沙箱与 CDP 的行为在 guest 桥与 main/computer-use/cdp.ts（bridge.test.mjs、cdp.test.ts），
 * 这里用假 broker 测这一层独有的东西：工具名、只读桶、参数怎么翻成请求、
 * 描述里有没有把「这是沙箱浏览器 / 网页优先 sandbox_* / 像素工具兜底」讲给模型。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RequestBroker } from "./request-broker.ts";
import { SANDBOX_BROWSER_TOOL_NAMES, createSandboxBrowserTools } from "./sandbox-tools.ts";
import { COMPUTER_USE_READ_TOOLS, decidePermission } from "../shared/permission.ts";
import {
  COMPUTER_USE_CDP_TIMEOUT_MS,
  type ComputerUseShot,
  type ComputerUseToolOutcome,
} from "../shared/computer-use.ts";

const setup = () => {
  const sent: Record<string, unknown>[] = [];
  const timeouts: Array<number | undefined> = [];
  const broker = new RequestBroker((event) => sent.push(event as Record<string, unknown>));
  // RequestBroker.request 的超时是第二参；包一层只为了记下来（工具层的等待必须比主进程长）
  const original = broker.request.bind(broker);
  broker.request = ((event: Record<string, unknown>, timeoutMs?: number) => {
    timeouts.push(timeoutMs);
    return original(event as never, ...(timeoutMs === undefined ? [] : [timeoutMs]));
  }) as typeof broker.request;

  const tools = new Map(createSandboxBrowserTools(broker, "session-1").map((tool) => [tool.name, tool]));
  const answer = (index: number, outcome: ComputerUseToolOutcome): void =>
    broker.resolve(String(sent[index]?.["requestId"]), outcome);
  const run = (name: string, params: unknown) =>
    tools.get(name)!.execute("call", params as never, undefined, undefined, undefined as never);
  /** 发一个工具调用，立刻用给定回执结掉，返回工具结果 */
  const runWith = async (name: string, params: unknown, outcome: ComputerUseToolOutcome = { ok: true, text: "done" }) => {
    const pending = run(name, params);
    const index = sent.length - 1;
    answer(index, outcome);
    return pending;
  };
  /** 只看请求：发一个调用、结掉回执、返回 request 载荷 */
  const requestOf = async (name: string, params: unknown): Promise<Record<string, unknown>> => {
    await runWith(name, params);
    const event = sent[sent.length - 1];
    return event?.["request"] as Record<string, unknown>;
  };
  return { sent, timeouts, broker, tools, run, runWith, requestOf };
};

describe("sandbox_* 工具注册", () => {
  test("十个工具一个不少，名字与导出清单一致", () => {
    const { tools } = setup();
    assert.deepEqual([...tools.keys()].sort(), [...SANDBOX_BROWSER_TOOL_NAMES].sort());
    assert.equal(SANDBOX_BROWSER_TOOL_NAMES.length, 10);
  });

  test("只读桶：observe / extract / screenshot / wait 三档放行；navigate / click / type / upload / download 过写闸门", () => {
    for (const name of ["sandbox_observe", "sandbox_extract", "sandbox_screenshot", "sandbox_wait"]) {
      assert.equal((COMPUTER_USE_READ_TOOLS as readonly string[]).includes(name), true, name);
      for (const mode of ["plan", "manual", "skip"] as const) {
        assert.deepEqual(decidePermission(mode, name), { behavior: "allow" }, `${mode} ${name}`);
      }
    }
    for (const name of [
      "sandbox_navigate",
      "sandbox_click",
      "sandbox_type",
      "sandbox_upload",
      "sandbox_download",
      "sandbox_tabs",
    ]) {
      assert.equal((COMPUTER_USE_READ_TOOLS as readonly string[]).includes(name), false, name);
      assert.equal(decidePermission("plan", name).behavior, "deny", name);
      assert.equal(decidePermission("manual", name).behavior, "ask", name);
      assert.equal(decidePermission("skip", name).behavior, "allow", name);
    }
    // wait 在只读桶里（只等、不改页面），但写动作一个都不许漏：
    for (const name of ["sandbox_navigate", "sandbox_click", "sandbox_type"]) {
      assert.equal(decidePermission("plan", name).behavior, "deny", name);
    }
  });

  test("每个描述都说清「操作的是隔离沙箱里的 Edge」，navigate/observe 还写明网页优先 sandbox_*、像素工具兜底", () => {
    const { tools } = setup();
    for (const [name, tool] of tools) {
      assert.match(tool.description, /inside the isolated Windows sandbox/, name);
      assert.match(tool.description, /DOM level/, name);
    }
    assert.match(tools.get("sandbox_navigate")!.description, /Prefer these sandbox_\* tools over computer_\*/);
    assert.match(tools.get("sandbox_observe")!.description, /computer_screenshot/);
    // 网页内容是不可信输入：交互类工具必须写
    for (const name of ["sandbox_click", "sandbox_type", "sandbox_upload", "sandbox_download"]) {
      assert.match(tools.get(name)!.description, /untrusted input written by the website/, name);
    }
  });
});

describe("sandbox_* → computerUseRequest", () => {
  test("broker 兜底比主进程的浏览器命令线更长：否则主进程还在等，agent 先判「失联」", async () => {
    const { requestOf, timeouts } = setup();
    await requestOf("sandbox_observe", {});
    const timeout = timeouts[timeouts.length - 1] ?? 0;
    assert.ok(
      timeout > COMPUTER_USE_CDP_TIMEOUT_MS,
      `broker（${timeout}ms）必须长于主进程等一条 cdp 命令的 ${COMPUTER_USE_CDP_TIMEOUT_MS}ms`,
    );
  });

  test("navigate：url 去空白、走 sandbox-navigate，broker 等待给两次 guest 命令留余量", async () => {
    const { requestOf, timeouts } = setup();
    const request = await requestOf("sandbox_navigate", { url: "  example.com  " });
    assert.deepEqual(request, { action: "sandbox-navigate", url: "example.com" });
    const timeout = timeouts[timeouts.length - 1];
    // cdp-start 与 cdp-nav 都走浏览器命令那条线（70s），两跳都要容下
    assert.ok(
      (timeout ?? 0) >= COMPUTER_USE_CDP_TIMEOUT_MS * 2,
      `导航等待应覆盖 cdp-start + cdp-nav（各 ${COMPUTER_USE_CDP_TIMEOUT_MS}ms），实际 ${timeout}`,
    );
  });

  test("navigate：空 url 当场拒绝，不发请求", async () => {
    const { run, sent } = setup();
    await assert.rejects(run("sandbox_navigate", { url: "   " }), /url is required/);
    assert.equal(sent.length, 0);
  });

  test("observe：maxElements 取整下发；不给就省略（让桥用缺省值）", async () => {
    const { requestOf } = setup();
    assert.deepEqual(await requestOf("sandbox_observe", { maxElements: 42.7 }), {
      action: "sandbox-observe",
      maxElements: 43,
    });
    assert.deepEqual(await requestOf("sandbox_observe", {}), { action: "sandbox-observe" });
  });

  test("click：selector 必填，element 的人话随请求走（PR4 审批卡要这句话）", async () => {
    const { requestOf } = setup();
    assert.deepEqual(await requestOf("sandbox_click", { selector: "#submit", element: "Save button" }), {
      action: "sandbox-click",
      selector: "#submit",
      element: "Save button",
    });
    const { run, sent } = setup();
    await assert.rejects(run("sandbox_click", { element: "Save button" }), /selector is required/);
    assert.equal(sent.length, 0);
  });

  test("type：clear 缺省 true、submit 缺省 false；显式值原样下发", async () => {
    const { requestOf } = setup();
    assert.deepEqual(await requestOf("sandbox_type", { selector: "#q", text: "你好" }), {
      action: "sandbox-type",
      selector: "#q",
      text: "你好",
      submit: false,
      clear: true,
    });
    assert.deepEqual(await requestOf("sandbox_type", { selector: "#q", text: "x", submit: true, clear: false }), {
      action: "sandbox-type",
      selector: "#q",
      text: "x",
      submit: true,
      clear: false,
    });
  });

  test("type：text 不是字符串就拒绝（不把 undefined 变成 \"undefined\" 打进页面）", async () => {
    const { run } = setup();
    await assert.rejects(run("sandbox_type", { selector: "#q" }), /text is required/);
  });

  test("extract：selector 可选，不给就不带字段", async () => {
    const { requestOf } = setup();
    assert.deepEqual(await requestOf("sandbox_extract", {}), { action: "sandbox-extract" });
    assert.deepEqual(await requestOf("sandbox_extract", { selector: "article" }), {
      action: "sandbox-extract",
      selector: "article",
    });
  });

  test("wait：selector 与 ms 至少给一个；两个都给就都传下去", async () => {
    const { run, requestOf } = setup();
    await assert.rejects(run("sandbox_wait", {}), /Pass a selector, or ms/);
    assert.deepEqual(await requestOf("sandbox_wait", { selector: "#done", timeoutMs: 5000 }), {
      action: "sandbox-wait",
      selector: "#done",
      timeoutMs: 5000,
    });
    assert.deepEqual(await requestOf("sandbox_wait", { ms: 300 }), { action: "sandbox-wait", ms: 300 });
  });

  test("screenshot：正文与图片块都交给模型（几何用页面视图尺寸）", async () => {
    const { runWith } = setup();
    const shot: ComputerUseShot = {
      data: "anBlZw==",
      width: 1000,
      height: 600,
      nativeWidth: 1366,
      nativeHeight: 820,
    };
    const result = (await runWith("sandbox_screenshot", {}, { ok: true, text: "page shot", shot })) as {
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    };
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0]?.type, "text");
    assert.equal(result.content[1]?.type, "image");
    assert.equal(result.content[1]?.data, "anBlZw==");
    assert.equal(result.content[1]?.mimeType, "image/jpeg");
  });

  test("upload：selector + 宿主任路径原样下发（拷进映射目录是主进程的活）", async () => {
    const { requestOf } = setup();
    const file = "C:\\Users\\me\\Desktop\\report.pdf";
    assert.deepEqual(await requestOf("sandbox_upload", { selector: "input[file]", path: file }), {
      action: "sandbox-upload",
      selector: "input[file]",
      path: file,
    });
  });

  test("download：selector + 可选子目录名；等待比普通命令更长（guest 内要等文件落盘）", async () => {
    const { requestOf, timeouts } = setup();
    assert.deepEqual(await requestOf("sandbox_download", { selector: "#export", dir: "run1" }), {
      action: "sandbox-download",
      selector: "#export",
      dir: "run1",
    });
    const timeout = timeouts[timeouts.length - 1];
    assert.ok((timeout ?? 0) > COMPUTER_USE_CDP_TIMEOUT_MS, `下载要留出 20s 落盘等待，实际 ${timeout}`);
  });

  test("tabs：list / switch 的 op 与 index 下发；非法 op 当场拒绝", async () => {
    const { requestOf, run } = setup();
    assert.deepEqual(await requestOf("sandbox_tabs", {}), { action: "sandbox-tabs", op: "list" });
    assert.deepEqual(await requestOf("sandbox_tabs", { op: "switch", index: 2 }), {
      action: "sandbox-tabs",
      op: "switch",
      index: 2,
    });
    await assert.rejects(run("sandbox_tabs", { op: "close" }), /op must be/);
  });

  test("失败回执翻成工具错误（pi 侧 throw），错误原话不吞", async () => {
    const { runWith } = setup();
    await assert.rejects(
      runWith("sandbox_click", { selector: "#gone" }, { ok: false, error: "选择器「#gone」没有匹配到元素" }),
      /选择器「#gone」没有匹配到元素/,
    );
  });

  test("信号已 abort 时立刻放手（停止按钮不许失灵）", async () => {
    const { tools, sent } = setup();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      tools.get("sandbox_observe")!.execute("call", {} as never, controller.signal, undefined, undefined as never),
      /Stopped/,
    );
    assert.equal(sent.length, 0);
  });
});
