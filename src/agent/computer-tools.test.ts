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
  test("五个工具一个不少；截图是免审批的只读件，其余四件照写操作过闸", () => {
    const { tools } = setup();
    assert.deepEqual([...tools.keys()].sort(), [...COMPUTER_USE_TOOL_NAMES].sort());
    assert.deepEqual([...COMPUTER_USE_READ_TOOLS], ["computer_screenshot"]);
    for (const name of COMPUTER_USE_TOOL_NAMES) {
      assert.equal((COMPUTER_USE_READ_TOOLS as readonly string[]).includes(name), name === "computer_screenshot");
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
