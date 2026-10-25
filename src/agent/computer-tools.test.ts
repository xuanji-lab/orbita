/**
 * computer use 工具层这一层的账：参数 → computerUseRequest → pi 工具结果。
 *
 * 沙箱行为本身在 guest 桥与主进程（guest-bridge/bridge.test.mjs、
 * main/computer-use/sandbox.test.ts），这里用假主进程回执测**这一层独有的东西**：
 * 坐标换算（模型给的是截图的像素，下发的是物理像素）、没截图就先动手的拒绝、
 * 越界拒绝，以及图片块确实交给了模型。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RequestBroker } from "./request-broker.ts";
import { COMPUTER_USE_TOOL_NAMES, createComputerUseTools } from "./computer-tools.ts";
import { COMPUTER_USE_READ_TOOLS } from "../shared/permission.ts";
import { GUEST_COMMAND_TIMEOUT_MS, type ComputerUseShot, type ComputerUseToolOutcome } from "../shared/computer-use.ts";

const setup = () => {
  const sent: Record<string, unknown>[] = [];
  const broker = new RequestBroker((event) => sent.push(event as Record<string, unknown>));
  const tools = new Map(createComputerUseTools(broker, "session-1").map((tool) => [tool.name, tool]));
  const answer = (index: number, outcome: ComputerUseToolOutcome): void =>
    broker.resolve(String(sent[index]?.["requestId"]), outcome);
  const run = (name: string, params: unknown) =>
    tools.get(name)!.execute("call", params as never, undefined, undefined, undefined as never);
  /** 假沙箱的一张截图：回图 1280×720、物理屏 2560×1440（长边缩一半） */
  const shot: ComputerUseShot = {
    width: 1280,
    height: 720,
    nativeWidth: 2560,
    nativeHeight: 1440,
    data: "anBlZw==",
  };
  /** 跑一次 computer_screenshot 并把回执结掉，让工具层拿到几何 */
  const takeScreenshot = async (): Promise<void> => {
    const pending = run("computer_screenshot", {});
    const index = sent.length - 1;
    answer(index, { ok: true, text: `Screenshot of the sandbox desktop: the image is 1280×720.`, shot });
    await pending;
  };
  return { sent, tools, answer, run, shot, takeScreenshot };
};

describe("computer_* 工具", () => {
  test("六个工具一个不少；截图是免审批的只读件，其余五件照写操作过闸", () => {
    const { tools } = setup();
    assert.deepEqual([...tools.keys()].sort(), [...COMPUTER_USE_TOOL_NAMES].sort());
    // 只读桶里也有 sandbox_* 的读取件（见 sandbox-tools.test.ts），这里只查像素组自己：
    // 六个里只有 screenshot 免审批，其余五件真的动沙箱（键鼠或 UIA 模式）。
    assert.equal((COMPUTER_USE_READ_TOOLS as readonly string[]).includes("computer_screenshot"), true);
    for (const name of COMPUTER_USE_TOOL_NAMES) {
      assert.equal(
        (COMPUTER_USE_READ_TOOLS as readonly string[]).includes(name),
        name === "computer_screenshot",
        name,
      );
    }
  });

  test("broker 等待比主进程的 guest 命令线更长：45 秒内到的回执不许被兑底判死", async () => {
    // 假 broker：记下 request 收到的超时，回执由测试控制（不真等时钟）。settle 放盒子里：
    // 闭包里的赋值 TS 看不见，直接 let 会被收窄成 null（属性 narrowing 会被函数调用重置）
    const timeouts: Array<number | undefined> = [];
    const box: { settle?: (outcome: ComputerUseToolOutcome) => void } = {};
    const broker = {
      request(_event: Record<string, unknown>, timeoutMs?: number): Promise<ComputerUseToolOutcome> {
        timeouts.push(timeoutMs);
        return new Promise((resolve) => {
          box.settle = resolve;
        });
      },
    } as unknown as RequestBroker;
    const tools = createComputerUseTools(broker, "session-1");
    const pending = tools
      .find((tool) => tool.name === "computer_screenshot")!
      .execute("call", {}, undefined, undefined, undefined as never);
    assert.equal(timeouts.length, 1);
    const timeout = timeouts[0];
    assert.ok(timeout !== undefined, "call() 必须显式给 broker 传超时，不能吃 30s 默认");
    assert.ok(
      timeout > GUEST_COMMAND_TIMEOUT_MS,
      `broker 兑底（${timeout}ms）必须长于主进程等 guest 命令的 ${GUEST_COMMAND_TIMEOUT_MS}ms，否则主进程还在等、agent 先把真成功判成失败`,
    );
    box.settle?.({ ok: true, text: "ok", shot: { width: 1280, height: 720, nativeWidth: 2560, nativeHeight: 1440, data: "anBlZw==" } });
    await pending;
  });

  test("screenshot：请求带 maxWidth 1280，回执的图与正文都进 content", async () => {
    const { sent, run, answer } = setup();
    const pending = run("computer_screenshot", {});
    assert.equal(sent[0]?.["type"], "computerUseRequest");
    assert.equal(sent[0]?.["sessionId"], "session-1");
    assert.deepEqual(sent[0]?.["request"], { action: "screenshot", maxWidth: 1280 });
    answer(0, {
      ok: true,
      text: "Screenshot of the sandbox desktop: the image is 1280×720.",
      shot: { width: 1280, height: 720, nativeWidth: 2560, nativeHeight: 1440, data: "anBlZw==" },
    });
    const result = await pending;
    assert.deepEqual(result.content, [
      { type: "text", text: "Screenshot of the sandbox desktop: the image is 1280×720." },
      { type: "image", data: "anBlZw==", mimeType: "image/jpeg" },
    ]);
  });

  test("screenshot + window：按窗口下发，图交给模型，但**不覆盖**最近一次整桌面截图的几何", async () => {
    const { sent, run, answer, takeScreenshot } = setup();
    await takeScreenshot(); // 桌面几何：1280×720 → 屏 2560×1440

    const pending = run("computer_screenshot", { hwnd: 4321 });
    assert.deepEqual(sent[1]?.["request"], { action: "screenshot", maxWidth: 1280, window: 4321 });
    answer(1, {
      ok: true,
      text: "Screenshot of the window …",
      // 窗口自己的几何：400×300 的图对 400×300 的窗口（比例 1:1）
      shot: { width: 400, height: 300, nativeWidth: 400, nativeHeight: 300, data: "d2luZG93" },
    });
    const result = await pending;
    assert.deepEqual(result.content[1], { type: "image", data: "d2luZG93", mimeType: "image/jpeg" });

    // 点击仍按整桌面的比例换算：窗口图的 400×300 没有把比例偷换掉
    const click = run("computer_click", { x: 100, y: 200 });
    assert.deepEqual(sent[2]?.["request"], { action: "click", x: 200, y: 400 });
    answer(2, { ok: true, text: "Sent a left click at (200, 400) on the sandbox desktop." });
    await click;

    // 标题两端空白去掉；hwnd 优先于 window
    const byTitle = run("computer_screenshot", { window: "  Edge  " });
    assert.deepEqual(sent[3]?.["request"], { action: "screenshot", maxWidth: 1280, window: "Edge" });
    answer(3, {
      ok: true,
      text: "window",
      shot: { width: 800, height: 600, nativeWidth: 800, nativeHeight: 600, data: "ZQ==" },
    });
    await byTitle;

    const both = run("computer_screenshot", { window: "Edge", hwnd: 77 });
    assert.deepEqual(sent[4]?.["request"], { action: "screenshot", maxWidth: 1280, window: 77 });
    answer(4, {
      ok: true,
      text: "window",
      shot: { width: 800, height: 600, nativeWidth: 800, nativeHeight: 600, data: "ZQ==" },
    });
    await both;

    // 空 window / 没给 window = 整桌面截图（不能把空串当成一个要匹配的标题）
    const desktopAgain = run("computer_screenshot", { window: "   " });
    assert.deepEqual(sent[5]?.["request"], { action: "screenshot", maxWidth: 1280 });
    answer(5, {
      ok: true,
      text: "desktop",
      shot: { width: 1280, height: 720, nativeWidth: 2560, nativeHeight: 1440, data: "ZQ==" },
    });
    await desktopAgain;
  });

  test("只拍过窗口时点击照样拒绝：窗口图的坐标不能当桌面像素用", async () => {
    const { sent, run, answer } = setup();
    const pending = run("computer_screenshot", { window: "Edge" });
    assert.deepEqual(sent[0]?.["request"], { action: "screenshot", maxWidth: 1280, window: "Edge" });
    answer(0, {
      ok: true,
      text: "window",
      shot: { width: 800, height: 600, nativeWidth: 800, nativeHeight: 600, data: "ZQ==" },
    });
    await pending;
    await assert.rejects(run("computer_click", { x: 10, y: 20 }), /computer_screenshot first/);
  });

  test("没截图就点击 / 滚动：当场拒绝，并指名先调 computer_screenshot", async () => {
    const { sent, run } = setup();
    await assert.rejects(run("computer_click", { x: 10, y: 20 }), /computer_screenshot first/);
    await assert.rejects(run("computer_scroll", { deltaY: 120 }), /computer_screenshot first/);
    assert.deepEqual(sent, [], "拒绝发生在下发之前，一个请求都不该发出去");
  });

  test("点击：图像坐标换算成物理像素后下发（回图 1280×720 → 屏 2560×1440）", async () => {
    const { sent, run, answer, takeScreenshot } = setup();
    await takeScreenshot();
    const pending = run("computer_click", { x: 100, y: 200 });
    assert.deepEqual(sent[1]?.["request"], { action: "click", x: 200, y: 400 });
    answer(1, { ok: true, text: "Sent a left click at (200, 400) on the sandbox desktop." });
    const result = await pending;
    assert.deepEqual(result.content, [{ type: "text", text: "Sent a left click at (200, 400) on the sandbox desktop." }]);
  });

  test("点击：button 与 double 只在给了才上船；字符串数字也认", async () => {
    const { sent, run, answer, takeScreenshot } = setup();
    await takeScreenshot();
    const pending = run("computer_click", { x: "10", y: 20, button: "middle", double: true });
    assert.deepEqual(sent[1]?.["request"], { action: "click", x: 20, y: 40, button: "middle", double: true });
    answer(1, { ok: true, text: "ok" });
    await pending;
    // 缺 x / y 当场报错，不发请求
    await assert.rejects(run("computer_click", { x: 10 }), /Pass x and y/);
    assert.equal(sent.length, 2);
  });

  test("点击：坐标落在图外 → 拒绝并报出图的尺寸（不钳到边缘）", async () => {
    const { run, takeScreenshot } = setup();
    await takeScreenshot();
    await assert.rejects(run("computer_click", { x: 1281, y: 10 }), /outside the screenshot.*1280×720/s);
    await assert.rejects(run("computer_click", { x: -1, y: 10 }), /outside the screenshot/);
  });

  test("滚动：x、y 都给了按它们换算；都没给落在屏幕正中；只给一个算错", async () => {
    const { sent, run, answer, takeScreenshot } = setup();
    await takeScreenshot();
    const centered = run("computer_scroll", { deltaY: -240 });
    assert.deepEqual(sent[1]?.["request"], { action: "scroll", x: 1280, y: 720, deltaY: -240 });
    answer(1, { ok: true, text: "ok" });
    await centered;

    const pointed = run("computer_scroll", { deltaY: 120, x: 0, y: 0 });
    assert.deepEqual(sent[2]?.["request"], { action: "scroll", x: 0, y: 0, deltaY: 120 });
    answer(2, { ok: true, text: "ok" });
    await pointed;

    await assert.rejects(run("computer_scroll", { deltaY: 120, x: 5 }), /Pass both x and y/);
    await assert.rejects(run("computer_scroll", {}), /deltaY is required/);
    assert.equal(sent.length, 3);
  });

  test("打字与按键：原样下发；缺参数当场报错", async () => {
    const { sent, run, answer } = setup();
    const typing = run("computer_type", { text: "你好 \"world\"" });
    assert.deepEqual(sent[0]?.["request"], { action: "type", text: "你好 \"world\"" });
    answer(0, { ok: true, text: "Typed 12 characters." });
    await typing;

    const pressing = run("computer_key", { key: "  ctrl+a  " });
    assert.deepEqual(sent[1]?.["request"], { action: "key", key: "ctrl+a" });
    answer(1, { ok: true, text: "Pressed ctrl+a." });
    await pressing;

    await assert.rejects(run("computer_type", {}), /text is required/);
    await assert.rejects(run("computer_key", { key: "   " }), /key is required/);
  });

  test("主进程的错误原话带出（沙箱没在跑时模型要能照抄给用户）", async () => {
    const { run, answer } = setup();
    const pending = run("computer_type", { text: "x" });
    answer(0, {
      ok: false,
      error: "沙箱没有在运行（当前状态：off），沙箱操作不可用——先在「设置 › 实验功能 › 电脑使用」里启动沙箱",
    });
    await assert.rejects(pending, /设置 › 实验功能 › 电脑使用/);
  });
});

describe("computer_uia 工具（UIA 车道）", () => {
  test("list：window 原样下发；没给 maxItems 就不编字段（吃桥的缺省值）", async () => {
    const { sent, run, answer } = setup();
    const pending = run("computer_uia", { action: "list", window: " 记事本 " });
    assert.deepEqual(sent[0]?.["request"], { action: "uia-list", window: "记事本" });
    answer(0, { ok: true, text: "1 · button \"Close\" · supports invoke" });
    const result = await pending;
    assert.deepEqual(result.content, [{ type: "text", text: "1 · button \"Close\" · supports invoke" }]);
  });

  test("list：给了 maxItems 就取整下发；纯数字 hwnd 优先于 window 标题", async () => {
    const { sent, run, answer } = setup();
    const pending = run("computer_uia", { action: "list", hwnd: 4321, window: "Edge", maxItems: 60.4 });
    assert.deepEqual(sent[0]?.["request"], { action: "uia-list", window: 4321, maxItems: 60 });
    answer(0, { ok: true, text: "ok" });
    await pending;
  });

  test("act：perform 与 ref / name / value 各就各位", async () => {
    const { sent, run, answer } = setup();
    const byRef = run("computer_uia", { action: "invoke", hwnd: 4321, ref: 2 });
    assert.deepEqual(sent[0]?.["request"], { action: "uia-act", window: 4321, ref: 2, perform: "invoke" });
    answer(0, { ok: true, text: "Invoked" });
    await byRef;

    const byName = run("computer_uia", { action: "setValue", hwnd: 7, name: " Search ", value: "orbita" });
    assert.deepEqual(sent[1]?.["request"], {
      action: "uia-act",
      window: 7,
      name: "Search",
      perform: "setValue",
      value: "orbita",
    });
    answer(1, { ok: true, text: "Set" });
    await byName;

    // 空字符串是合法 value（清空输入框），不能被当成「没给」
    const clear = run("computer_uia", { action: "setValue", hwnd: 7, ref: 1, value: "" });
    assert.deepEqual(sent[2]?.["request"], { action: "uia-act", window: 7, ref: 1, perform: "setValue", value: "" });
    answer(2, { ok: true, text: "Cleared" });
    await clear;
  });

  test("参数缺了当场拒绝：不说清要怎么指窗口 / 控件，模型会乱猜", async () => {
    const { run } = setup();
    await assert.rejects(run("computer_uia", { action: "list" }), /Pass window .* or hwnd/);
    await assert.rejects(run("computer_uia", { action: "invoke", hwnd: 1 }), /Pass ref .* or name/);
    await assert.rejects(run("computer_uia", { action: "setValue", hwnd: 1, ref: 1 }), /setValue needs value/);
    await assert.rejects(run("computer_uia", { action: "click", hwnd: 1, ref: 1 }), /action must be one of/);
    await assert.rejects(run("computer_uia", { action: "invoke", hwnd: 1, ref: 0 }), /ref must be a positive integer/);
  });

  test("主进程的错误原话带出（含「改用 computer_click / computer_type 的像素路径」）", async () => {
    const { run, answer } = setup();
    const pending = run("computer_uia", { action: "invoke", hwnd: 1, ref: 3 });
    answer(0, {
      ok: false,
      error: "这个控件不支持 invoke（edit，它支持：value）。改用 computer_click / computer_type 的像素路径",
    });
    await assert.rejects(pending, /改用 computer_click \/ computer_type 的像素路径/);
  });
});
