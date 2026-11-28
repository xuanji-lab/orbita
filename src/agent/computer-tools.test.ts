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
import { COMPUTER_USE_TOOL_NAMES, computerUseTurnPlan, createComputerUseTools } from "./computer-tools.ts";
import { COMPUTER_USE_READ_TOOLS } from "../shared/permission.ts";
import { GUEST_COMMAND_TIMEOUT_MS, COMPUTER_USE_DELIVERIES, COMPUTER_USE_DELIVERY_HINTS, type ComputerUseShot, type ComputerUseToolOutcome } from "../shared/computer-use.ts";

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
  test("工具 schema 的动作集里没有 focus（模型看到的就是这份，不能比实现松）", () => {
    const { tools } = setup();
    const parameters = tools.get("computer_uia")!.parameters as {
      properties: { action: { enum: string[] } };
    };
    assert.deepEqual(parameters.properties.action.enum, ["list", "invoke", "setValue", "selection"]);
  });

  test("list：window 原样下发；没给 maxItems 就按描述里的默认 60 显式下发", async () => {
    const { sent, run, answer } = setup();
    const pending = run("computer_uia", { action: "list", window: " 记事本 " });
    assert.deepEqual(sent[0]?.["request"], { action: "uia-list", window: "记事本", maxItems: 60 });
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

  test("act：perform 与 ref（带代次的 token）/ name / value 各就各位", async () => {
    const { sent, run, answer } = setup();
    const byRef = run("computer_uia", { action: "invoke", hwnd: 4321, ref: "g12:r2" });
    assert.deepEqual(sent[0]?.["request"], { action: "uia-act", window: 4321, ref: "g12:r2", perform: "invoke" });
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
    const clear = run("computer_uia", { action: "setValue", hwnd: 7, ref: "g1:r1", value: "" });
    assert.deepEqual(sent[2]?.["request"], {
      action: "uia-act",
      window: 7,
      ref: "g1:r1",
      perform: "setValue",
      value: "",
    });
    answer(2, { ok: true, text: "Cleared" });
    await clear;
  });

  test("参数缺了当场拒绝：不说清要怎么指窗口 / 控件，模型会乱猜", async () => {
    const { run } = setup();
    await assert.rejects(run("computer_uia", { action: "list" }), /Pass window .* or hwnd/);
    await assert.rejects(run("computer_uia", { action: "invoke", hwnd: 1 }), /Pass ref .* or name/);
    await assert.rejects(run("computer_uia", { action: "setValue", hwnd: 1, ref: "g1:r1" }), /setValue needs value/);
    await assert.rejects(run("computer_uia", { action: "click", hwnd: 1, ref: "g1:r1" }), /action must be one of/);
    // ref 现在是**不透明 token**：裸数字 / 缺代次的写法当场就拒（不用跑一趟沙箱才知道）
    await assert.rejects(run("computer_uia", { action: "invoke", hwnd: 1, ref: 0 }), /not a ref any more/);
    await assert.rejects(run("computer_uia", { action: "invoke", hwnd: 1, ref: "r3" }), /not a ref any more/);
    await assert.rejects(run("computer_uia", { action: "invoke", hwnd: 1, ref: "g0:r1" }), /not a ref any more/);
  });

  test("已删除的 focus：schema 里没有它，发了就回一句带替代路径的人话", async () => {
    const { run, sent } = setup();
    // 模型可能凭旧记忆发 focus：拒得比普通未知动作更具体（它是「删了」而不是「拼错了」）
    await assert.rejects(run("computer_uia", { action: "focus", hwnd: 1, ref: "g1:r1" }), /computer_click/);
    await assert.rejects(run("computer_uia", { action: "focus", hwnd: 1, ref: "g1:r1" }), /已删除/);
    assert.deepEqual(sent, [], "被拒的 focus 一个字节都不该往下发");
  });

  test("主进程的错误原话带出（含「改用 computer_click / computer_type 的像素路径」）", async () => {
    const { run, answer } = setup();
    const pending = run("computer_uia", { action: "invoke", hwnd: 1, ref: "g1:r3" });
    answer(0, {
      ok: false,
      error: "这个控件不支持 invoke（edit，它支持：value）。改用 computer_click / computer_type 的像素路径",
    });
    await assert.rejects(pending, /改用 computer_click \/ computer_type 的像素路径/);
  });
});

describe("computer_* 的审计载荷（details.computerUse）", () => {
  test("五个动作都带 action / args / at；坐标是模型给的截图像素，不是换算后的物理像素", async () => {
    const { run, answer, sent, takeScreenshot } = setup();
    await takeScreenshot();

    const click = run("computer_click", { x: 100, y: 200, button: "right" });
    answer(sent.length - 1, { ok: true, text: "clicked" });
    const clicked = await click;
    const clickAudit = (clicked.details as { computerUse: { action: string; args: Record<string, unknown>; at: number } }).computerUse;
    assert.equal(clickAudit.action, "click");
    assert.deepEqual(clickAudit.args, { x: 100, y: 200, button: "right" });
    assert.equal(typeof clickAudit.at, "number");

    const typed = run("computer_type", { text: "hello" });
    answer(sent.length - 1, { ok: true, text: "typed" });
    const typedAudit = ((await typed).details as { computerUse: { action: string; args: Record<string, unknown> } }).computerUse;
    assert.equal(typedAudit.action, "type");
    // 明文留在 details 与转录里（renderer 默认折叠显示）
    assert.deepEqual(typedAudit.args, { text: "hello" });

    const key = run("computer_key", { key: "ctrl+a" });
    answer(sent.length - 1, { ok: true, text: "pressed" });
    assert.equal(((await key).details as { computerUse: { action: string } }).computerUse.action, "key");

    const scroll = run("computer_scroll", { deltaY: 3, x: 10, y: 20 });
    answer(sent.length - 1, { ok: true, text: "scrolled" });
    const scrollAudit = ((await scroll).details as { computerUse: { action: string; args: Record<string, unknown> } }).computerUse;
    assert.equal(scrollAudit.action, "scroll");
    assert.deepEqual(scrollAudit.args, { x: 10, y: 20, deltaY: 3 });
  });

  test("截图：details 记 maxWidth，图仍在 content 里（details 不进模型上下文）", async () => {
    const { run, answer, sent } = setup();
    const pending = run("computer_screenshot", {});
    answer(sent.length - 1, {
      ok: true,
      text: "shot",
      shot: { width: 1280, height: 720, nativeWidth: 2560, nativeHeight: 1440, data: "anBlZw==" },
    });
    const result = await pending;
    const audit = (result.details as { computerUse: { action: string; args: Record<string, unknown> } }).computerUse;
    assert.equal(audit.action, "screenshot");
    assert.equal(audit.args["maxWidth"], 1280);
    assert.equal(result.content.some((block) => block.type === "image"), true);
  });
});

describe("computer_* 的工具描述：交付口径写进模型读得到的地方", () => {
  // 模型只读工具描述，不读源码、也不看 UI。若五档不在描述里说清，它读到 ok:true 就会当成
  // 「我点到了」接着往下走，或者在出错后重放同一个动作（双击 / 双份文字）。
  test("四个像素工具都从 COMPUTER_USE_DELIVERY_HINTS 取齐五档（同一句话，不是另写一套）", () => {
    const { tools } = setup();
    for (const name of ["computer_click", "computer_type", "computer_key", "computer_scroll"]) {
      const description = tools.get(name)?.description ?? "";
      for (const tier of COMPUTER_USE_DELIVERIES) {
        assert.ok(
          description.includes(`${tier} = ${COMPUTER_USE_DELIVERY_HINTS[tier]}`),
          `${name} 的 ${tier} 一档应逐字来自 shared 的 COMPUTER_USE_DELIVERY_HINTS`,
        );
      }
      // 证据边界也写在描述里：截图变了 / API 成功 / 事件收到都不算证据
      assert.match(description, /only an exact read-back/);
    }
  });

  test("unverifiable 明确说「先看一眼再决定、不要立刻重放」，截图工具是核验入口", () => {
    const { tools } = setup();
    assert.match(COMPUTER_USE_DELIVERY_HINTS.unverifiable, /先截一张图/);
    assert.match(COMPUTER_USE_DELIVERY_HINTS.unverifiable, /不要立刻重放/);
    const screenshot = tools.get("computer_screenshot")?.description ?? "";
    // 关系断言：截图描述里的那句话就是单一来源里那一句（不是复述）
    assert.ok(screenshot.includes(COMPUTER_USE_DELIVERY_HINTS.unverifiable));
    assert.match(screenshot, /This tool is how you check/);
  });

  test("UIA 通道（不走 SendInput）不背这套：它的失败文案自己点名路", () => {
    const { tools } = setup();
    const description = tools.get("computer_uia")?.description ?? "";
    for (const tier of COMPUTER_USE_DELIVERIES) {
      assert.equal(description.includes(COMPUTER_USE_DELIVERY_HINTS[tier]), false, tier);
    }
  });
});

// ── 审计归属：这一下是谁干的、截图时人在不在输入（桥 0.12.0）──────────────────
//
// 会话 JSONL 里的 details.computerUse 要能回答两个事后问题：
//   ① 这一下是谁做的 → 每条写动作都有 inputOrigin（现在只有 agent）；
//   ② 那张进了模型上下文的图，当时用户在不在里面打字 / 有没有遮密码框。
describe("computer_* 的审计归属（inputOrigin / maskedRegions / userTypingAtCapture）", () => {
  test("五个写动作都带 inputOrigin：agent（截图也算 agent 发起的观察）", async () => {
    const { run, answer, sent, takeScreenshot } = setup();
    await takeScreenshot();
    const cases: Array<[string, unknown]> = [
      ["computer_click", { x: 1, y: 2 }],
      ["computer_type", { text: "hi" }],
      ["computer_key", { key: "enter" }],
      ["computer_scroll", { deltaY: 1 }],
    ];
    for (const [name, params] of cases) {
      const pending = run(name, params);
      answer(sent.length - 1, { ok: true, text: "ok" });
      const audit = ((await pending).details as { computerUse: { inputOrigin?: string } }).computerUse;
      assert.equal(audit.inputOrigin, "agent", name);
    }
  });

  test("截图：inputOrigin + 遮罩块数 + 当时用户在不在输入", async () => {
    const { run, answer, sent } = setup();
    const pending = run("computer_screenshot", {});
    answer(sent.length - 1, {
      ok: true,
      text: "shot",
      shot: { width: 1280, height: 720, nativeWidth: 2560, nativeHeight: 1440, data: "anBlZw==" },
      capture: { maskedRegions: 2, maskListed: true, maskStale: false, maskCacheAgeMs: 500, userTyping: true },
    });
    const audit = (
      (await pending).details as {
        computerUse: { inputOrigin?: string; maskedRegions?: number; userTypingAtCapture?: boolean; args: Record<string, unknown> };
      }
    ).computerUse;
    assert.equal(audit.inputOrigin, "agent");
    assert.equal(audit.maskedRegions, 2);
    assert.equal(audit.userTypingAtCapture, true);
    // 整桌面截图不该记 window（那会让事后回看误以为是某个窗口的图）
    assert.equal("window" in audit.args, false);
  });

  test("窗口截图：审计记下拍的是哪个窗口", async () => {
    const { run, answer, sent } = setup();
    const pending = run("computer_screenshot", { hwnd: 4321 });
    answer(sent.length - 1, {
      ok: true,
      text: "shot",
      shot: { width: 800, height: 600, nativeWidth: 800, nativeHeight: 600, data: "d2luZG93" },
      capture: { maskedRegions: 0, maskListed: true, maskStale: false, maskCacheAgeMs: 10, userTyping: false },
    });
    const audit = (
      (await pending).details as { computerUse: { args: Record<string, unknown>; maskedRegions?: number; userTypingAtCapture?: boolean } }
    ).computerUse;
    assert.equal(audit.args["window"], 4321);
    // «遮了 0 块» 与 «当时没人打字» 也要落下来：0/false 是有信息量的
    assert.equal(audit.maskedRegions, 0);
    assert.equal(audit.userTypingAtCapture, false);
  });

  test("老桥不带 capture：两个键都不写（不知道就不编 false）", async () => {
    const { run, answer, sent, takeScreenshot } = setup();
    const pending = run("computer_screenshot", {});
    answer(sent.length - 1, {
      ok: true,
      text: "shot",
      shot: { width: 1280, height: 720, nativeWidth: 2560, nativeHeight: 1440, data: "anBlZw==" },
    });
    const audit = (
      (await pending).details as { computerUse: Record<string, unknown> }
    ).computerUse;
    assert.equal("maskedRegions" in audit, false);
    assert.equal("userTypingAtCapture" in audit, false);
    await takeScreenshot();
  });

  test("uia-act：写动作也有归属，入参里带 perform / ref / window", async () => {
    const { run, answer, sent } = setup();
    const pending = run("computer_uia", { action: "invoke", ref: "g12:r3", hwnd: 4321 });
    answer(sent.length - 1, { ok: true, text: "Invoked" });
    const audit = (
      (await pending).details as { computerUse: { action: string; inputOrigin?: string; args: Record<string, unknown> } }
    ).computerUse;
    assert.equal(audit.action, "uia-act");
    assert.equal(audit.inputOrigin, "agent");
    assert.deepEqual(audit.args, { action: "invoke", ref: "g12:r3", window: 4321 });
  });
});

/**
 * 开轮装配的唯一判定点（computerUseTurnPlan）：runtime 的四处都读它，所以这四条组合就是
 * 「非 Windows 不注册 computer_* / sandbox_*」那条改动的守护测试。
 * 2026-11-27 独立验收发现：把 runtime 的注册点改回旧的 `command.computerUse?.enabled === true`，
 * 全部测试仍绿——因为判定当时散在四处、没有可测的入口。把判定收成一个纯函数之后，
 * 「改回只认 enabled」会让下面第三条当场变红。
 */
describe("computerUseTurnPlan（这一轮装配什么）", () => {
  test("enabled=false：不注册工具、也不讲那两段提示词（allowNetwork / networkControlled 如实带着）", () => {
    assert.deepEqual(
      computerUseTurnPlan({ enabled: false, platformSupported: true, allowNetwork: false, networkControlled: false }),
      { tools: false, allowNetwork: false, networkControlled: false },
    );
  });

  test("enabled=true + win32：注册工具、讲提示词，出网与「能不能真断」两个事实各取各的", () => {
    assert.deepEqual(
      computerUseTurnPlan({ enabled: true, platformSupported: true, allowNetwork: true, networkControlled: true }),
      { tools: true, allowNetwork: true, networkControlled: true },
    );
    // L2b：开关关着，但这个后端断不了——两条事实必须各自如实下去，不能合并成一个布尔
    assert.deepEqual(
      computerUseTurnPlan({ enabled: true, platformSupported: true, allowNetwork: false, networkControlled: false }),
      { tools: true, allowNetwork: false, networkControlled: false },
    );
  });

  test("enabled=true + darwin：开关开着也不注册（这就是改回只认 enabled 会红的那一条）", () => {
    assert.deepEqual(
      computerUseTurnPlan({ enabled: true, platformSupported: false, allowNetwork: true, networkControlled: true }),
      { tools: false, allowNetwork: true, networkControlled: true },
    );
  });

  test("computerUse 缺席（旧命令形状 / 开关从没打开）：不注册；缺了 networkControlled 一格就按「做不到」算", () => {
    // 缺席不能按 true（wsb 能断）：同一轮的提示词把缺格当「做不到」、工具描述若按 true 就会说
    // 「This sandbox has no outbound network」——两个消费者当场互相打脸（验收实测过）。
    assert.deepEqual(computerUseTurnPlan(undefined), { tools: false, allowNetwork: true, networkControlled: false });
  });
});
