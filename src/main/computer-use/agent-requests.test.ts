/**
 * computerUseRequest → guest 命令 → 回执载荷 的账（main/computer-use/agent-requests.ts）。
 *
 * 沙箱状态机与文件协议在 sandbox.test.ts 里用真 controller + 假桥测；这里用一个只有两个
 * 方法的假沙箱，测**这一层自己的活**：动作翻成哪个 guest 命令、字段对不对、给模型的人话
 * 里有没有它下一步要的信息。坐标换算不在这里（工具层做），所以这里的 x/y 都是物理像素，
 * 原样下发即可。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applyComputerUseRequest, type ComputerUseGuest } from "./agent-requests.ts";
import type {
  ComputerUseGuestCommand,
  ComputerUseScreenshotResult,
  ComputerUseToolRequest,
  ComputerUseUiaActResult,
  ComputerUseUiaListResult,
  ComputerUseWindowListResult,
  ComputerUseWindowShotResult,
} from "../../shared/computer-use.ts";
import type { GuestCommandReply } from "./sandbox.ts";

interface WindowShotFields {
  hwnd?: number;
  title?: string;
  maxWidth?: number;
}

interface UiaListFields {
  hwnd?: number;
  title?: string;
  maxItems?: number;
}

interface UiaActFields {
  hwnd?: number;
  title?: string;
  ref?: number;
  name?: string;
  perform: string;
  value?: string;
  timeoutMs?: number;
}

interface Calls {
  screenshot: number[];
  commands: Array<{ command: ComputerUseGuestCommand; fields: Record<string, unknown> }>;
  windowShots: WindowShotFields[];
  /** 每次 listWindows 收到的超时（未传 = undefined） */
  listWindows: Array<number | undefined>;
  uiaLists: UiaListFields[];
  uiaActs: UiaActFields[];
}

function fakeGuest(options: {
  shot?: ComputerUseScreenshotResult;
  windowShot?: ComputerUseWindowShotResult;
  windowList?: ComputerUseWindowListResult;
  uiaList?: ComputerUseUiaListResult;
  uiaAct?: ComputerUseUiaActResult;
  commandResult?: GuestCommandReply;
  throwOn?: "screenshot" | "command";
}): { guest: ComputerUseGuest; calls: Calls } {
  const calls: Calls = { screenshot: [], commands: [], windowShots: [], listWindows: [], uiaLists: [], uiaActs: [] };
  const guest: ComputerUseGuest = {
    async screenshot(maxWidth?: number): Promise<ComputerUseScreenshotResult> {
      if (options.throwOn === "screenshot") throw new Error("文件协议炸了");
      calls.screenshot.push(maxWidth ?? 0);
      return (
        options.shot ?? {
          ok: true,
          jpegBase64: "anBlZw==",
          width: 1280,
          height: 720,
          nativeWidth: 2560,
          nativeHeight: 1440,
          takenAt: 1,
        }
      );
    },
    async guestCommand(command, fields): Promise<GuestCommandReply> {
      if (options.throwOn === "command") throw new Error("文件协议炸了");
      calls.commands.push({ command, fields });
      return options.commandResult ?? { ok: true, resp: { ok: true, delivery: "dispatched" } };
    },
    async windowShot(fields): Promise<ComputerUseWindowShotResult> {
      calls.windowShots.push(fields);
      return (
        options.windowShot ?? {
          ok: true,
          jpegBase64: "d2luZG93",
          width: 800,
          height: 600,
          nativeWidth: 800,
          nativeHeight: 600,
          hwnd: 4321,
          title: "Edge - 新建标签页",
          restoredFromMinimized: false,
          takenAt: 2,
        }
      );
    },
    async listWindows(timeoutMs?: number): Promise<ComputerUseWindowListResult> {
      calls.listWindows.push(timeoutMs);
      return (
        options.windowList ?? {
          ok: true,
          windows: [
            {
              hwnd: 4321,
              title: "Edge - 新建标签页",
              process: "msedge",
              className: "Chrome_WidgetWin_1",
              x: 0,
              y: 0,
              w: 800,
              h: 600,
              minimized: false,
              visible: true,
            },
          ],
        }
      );
    },
    async uiaList(fields): Promise<ComputerUseUiaListResult> {
      calls.uiaLists.push(fields);
      return (
        options.uiaList ?? {
          ok: true,
          hwnd: 4321,
          window: { title: "Untitled - Notepad", className: "Notepad" },
          items: [
            {
              ref: 1,
              name: "Text editor",
              controlType: "document",
              automationId: "15",
              className: "Edit",
              x: 10,
              y: 40,
              w: 700,
              h: 500,
              patterns: ["value"],
              enabled: true,
              offscreen: false,
            },
            {
              ref: 2,
              name: "Close",
              controlType: "button",
              automationId: "Close",
              className: "Button",
              x: 730,
              y: 0,
              w: 45,
              h: 30,
              patterns: ["invoke"],
              enabled: true,
              offscreen: false,
            },
          ],
          truncated: false,
        }
      );
    },
    async uiaAct(fields): Promise<ComputerUseUiaActResult> {
      calls.uiaActs.push(fields);
      return (
        options.uiaAct ?? {
          ok: true,
          hwnd: 4321,
          action: fields.perform,
          usedPattern: fields.perform === "setValue" ? "value" : "invoke",
          name: "Close",
          controlType: "button",
          autoSetFocus: true,
          elapsedMs: 7,
        }
      );
    },
  };
  return { guest, calls };
}

/** sessionId 只进日志（不改变命令）：这一层不关心它是什么，测试里固定一个 */
const run = (guest: ComputerUseGuest, request: ComputerUseToolRequest) =>
  applyComputerUseRequest(guest, "s1", request);

describe("applyComputerUseRequest", () => {
  test("screenshot：正文带两套尺寸与「动手前先看屏幕」的指引，shot 带上图与几何", async () => {
    const { guest, calls } = fakeGuest({});
    const outcome = await run(guest, { action: "screenshot", maxWidth: 1280 });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(calls.screenshot, [1280]);
    assert.match(outcome.text, /image is 1280×720/);
    assert.match(outcome.text, /physical screen is 2560×1440/);
    assert.deepEqual(outcome.shot, {
      width: 1280,
      height: 720,
      nativeWidth: 2560,
      nativeHeight: 1440,
      data: "anBlZw==",
    });
  });

  test("screenshot：沙箱没在跑的错误原话带出（工具层负责翻给模型）", async () => {
    const { guest } = fakeGuest({ shot: { ok: false, error: "沙箱没有在运行（当前状态：off）" } });
    const outcome = await run(guest, { action: "screenshot" });
    assert.deepEqual(outcome, { ok: false, error: "沙箱没有在运行（当前状态：off）" });
  });

  test("click：button 缺省 left、double 缺省 false，坐标原样下发（换算在工具层）", async () => {
    const { guest, calls } = fakeGuest({});
    const outcome = await run(guest, { action: "click", x: 200, y: 400 });
    assert.equal(outcome.ok, true);
    assert.deepEqual(calls.commands, [
      { command: "click", fields: { x: 200, y: 400, button: "left", double: false } },
    ]);
    if (outcome.ok) assert.match(outcome.text, /left click at \(200, 400\)/);

    const right = fakeGuest({});
    await run(right.guest, { action: "click", x: 1, y: 2, button: "right", double: true });
    assert.deepEqual(right.calls.commands[0]?.fields, { x: 1, y: 2, button: "right", double: true });
  });

  test("type / key / scroll：字段一一对上 guest 桥认的名字", async () => {
    const { guest, calls } = fakeGuest({});
    await run(guest, { action: "type", text: "你好" });
    await run(guest, { action: "key", key: "ctrl+a" });
    await run(guest, { action: "scroll", x: 640, y: 360, deltaY: -120 });
    assert.deepEqual(calls.commands, [
      { command: "type", fields: { text: "你好" } },
      { command: "key", fields: { key: "ctrl+a" } },
      { command: "scroll", fields: { x: 640, y: 360, deltaY: -120 } },
    ]);
  });

  test("准入信息进回执正文：bypassed 要说清「打在了谁身上」且明说不拦；没有字段时正文一字不变", async () => {
    const bypassed = fakeGuest({
      commandResult: {
        ok: true,
        resp: {},
        admission: { admission: "bypassed", targetExe: "notepad.exe", targetPid: 400 },
      },
    });
    const outcome = await run(bypassed.guest, { action: "click", x: 200, y: 400 });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.match(outcome.text, /"admission":"bypassed","targetExe":"notepad.exe"/);
      assert.match(outcome.text, /only observes and logs it/);
      // 原有那句不能丢：模型仍要知道「去看一张图」
      assert.match(outcome.text, /computer_screenshot/);
    }

    const owned = fakeGuest({
      commandResult: { ok: true, resp: {}, admission: { admission: "owned", targetExe: "msedge.exe" } },
    });
    const own = await run(owned.guest, { action: "scroll", x: 1, y: 2, deltaY: 1 });
    if (own.ok) assert.match(own.text, /"admission":"owned","targetExe":"msedge.exe"/);

    // 老桥（回执没有 admission）：正文与以前完全一样，不多一个字
    const plain = fakeGuest({});
    const before = await run(plain.guest, { action: "click", x: 200, y: 400 });
    if (before.ok) {
      assert.equal(before.text.includes("Admission (guest-side)"), false);
    }
  });

  test("guest 命令失败：错误原话带出，不吞成成功", async () => {
    const { guest } = fakeGuest({ commandResult: { ok: false, error: "不认识的按键名：hyper" } });
    const outcome = await run(guest, { action: "key", key: "hyper+x" });
    assert.deepEqual(outcome, { ok: false, error: "不认识的按键名：hyper" });
  });

  test("交付三档：dispatched 带「不要重放」，applied 带生效证据，failed 原样带出", async () => {
    // dispatched：SendInput 成功入队但无法确认生效——**模型不许重放**
    const dispatched = fakeGuest({ commandResult: { ok: true, resp: { ok: true, delivery: "dispatched" } } });
    const dispatchedOutcome = await run(dispatched.guest, { action: "click", x: 10, y: 20 });
    assert.equal(dispatchedOutcome.ok && dispatchedOutcome.delivery, "dispatched");
    if (dispatchedOutcome.ok) {
      assert.match(dispatchedOutcome.text, /do not replay the same action/);
      assert.match(dispatchedOutcome.text, /computer_screenshot/);
    }

    // applied：有生效证据，就不该再说「无法确认」
    const applied = fakeGuest({ commandResult: { ok: true, resp: { ok: true, delivery: "applied" } } });
    const appliedOutcome = await run(applied.guest, { action: "type", text: "x" });
    assert.equal(appliedOutcome.ok && appliedOutcome.delivery, "applied");
    if (appliedOutcome.ok) {
      assert.match(appliedOutcome.text, /confirmed to have taken effect/);
      assert.doesNotMatch(appliedOutcome.text, /do not replay/);
    }

    // 老桥 / 桥没说 / 不认识的档位：一律按「已派发、未验证」——像素命令拿到 ok 回执
    // 本来就只能说明事件入了队（不能凭缺失就把「未验证」升级成「已生效」）
    for (const resp of [{ ok: true }, { ok: true, delivery: "possibly" }]) {
      const silent = fakeGuest({ commandResult: { ok: true, resp } });
      const outcome = await run(silent.guest, { action: "key", key: "enter" });
      assert.equal(outcome.ok && outcome.delivery, "dispatched");
    }

    // failed：桥明确拒绝（「确定没做成」，可以放心重试）
    const failed = fakeGuest({
      commandResult: { ok: false, error: "button 只能是 left / right / middle，收到：wheel", delivery: "failed" },
    });
    const failedOutcome = await run(failed.guest, { action: "click", x: 1, y: 2 });
    assert.deepEqual(failedOutcome, {
      ok: false,
      error: "button 只能是 left / right / middle，收到：wheel",
      delivery: "failed",
    });

    // 超时 / 沙箱没在跑：没有那一档——「不知道成没成」不能写成 failed（会鼓励重放）
    const unknown = fakeGuest({ commandResult: { ok: false, error: "沙箱里的桌面没有响应（click 超时 45s）" } });
    const unknownOutcome = await run(unknown.guest, { action: "click", x: 3, y: 4 });
    assert.equal(unknownOutcome.ok, false);
    assert.equal("delivery" in unknownOutcome, false);
  });

  test("控制器抛异常：收成 ok:false（挂着不回会让那次工具调用永远等下去）", async () => {
    const { guest } = fakeGuest({ throwOn: "screenshot" });
    assert.deepEqual(await run(guest, { action: "screenshot" }), { ok: false, error: "文件协议炸了" });
    const throwing = fakeGuest({ throwOn: "command" });
    assert.deepEqual(await run(throwing.guest, { action: "type", text: "x" }), {
      ok: false,
      error: "文件协议炸了",
    });
  });
});

describe("applyComputerUseRequest：用户优先的让路回执（桥 0.11.0）", () => {
  /** 四条像素命令的请求（让路只对它们生效） */
  const pixelRequests: ComputerUseToolRequest[] = [
    { action: "click", x: 10, y: 20 },
    { action: "type", text: "hi" },
    { action: "key", key: "enter" },
    { action: "scroll", x: 10, y: 20, deltaY: 1 },
  ];

  test("click / type / key / scroll 都补上「为什么慢了」的说明，带上具体毫秒数", async () => {
    for (const request of pixelRequests) {
      const { guest } = fakeGuest({ commandResult: { ok: true, resp: {}, yielded: true, waitedMs: 850 } });
      const outcome = await run(guest, request);
      assert.equal(outcome.ok, true, `${request.action} 应成功`);
      if (!outcome.ok) continue;
      assert.match(outcome.text, /held back for 850ms/, `${request.action} 应点名等了多久`);
      // 模型必须知道「为了让路」而不是「桥卡了」：点出人、点出用户优先
      assert.match(outcome.text, /a person was typing or clicking in the sandbox/);
      assert.match(outcome.text, /takes priority over the agent's/);
      // 以及接着该怎么做：换不占桌面的车道
      assert.match(outcome.text, /sandbox_\* browser commands/);
      assert.match(outcome.text, /computer_uia/);
    }
  });

  test("没让路（回执里没有 yielded）→ 文案一个字都不加", async () => {
    const { guest } = fakeGuest({});
    const outcome = await run(guest, { action: "click", x: 1, y: 2 });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.doesNotMatch(outcome.text, /held back/);
      assert.doesNotMatch(outcome.text, /priority/);
    }
  });

  test("让路但桥没给 waitedMs → 按 0ms 说，不吞掉「让过路」这件事", async () => {
    const { guest } = fakeGuest({ commandResult: { ok: true, resp: {}, yielded: true } });
    const outcome = await run(guest, { action: "type", text: "x" });
    assert.equal(outcome.ok, true);
    if (outcome.ok) assert.match(outcome.text, /held back for 0ms/);
  });

  test("让路等到上限（放弃）→ 桥的人话原样带出，不当成成功", async () => {
    const giveUp = "用户正在使用沙箱桌面，click 已暂缓 4000ms 仍未等到停手，已放弃（一个输入事件都没送）。";
    const { guest } = fakeGuest({ commandResult: { ok: false, error: giveUp } });
    const outcome = await run(guest, { action: "click", x: 1, y: 2 });
    assert.deepEqual(outcome, { ok: false, error: giveUp });
  });

  test("窗口截图 / UIA 不带让路说明（它们不占桌面，不会被推迟）", async () => {
    const { guest } = fakeGuest({});
    const shot = await run(guest, { action: "screenshot", window: 4321 });
    assert.equal(shot.ok, true);
    if (shot.ok) assert.doesNotMatch(shot.text, /held back/);
    const uia = await run(guest, { action: "uia-act", window: 4321, ref: 2, perform: "invoke" });
    assert.equal(uia.ok, true);
    if (uia.ok) assert.doesNotMatch(uia.text, /held back/);
  });
});

describe("applyComputerUseRequest：按窗口截图（win-shot / win-list，桥 0.9.0）", () => {
  test("window 是数字：下发 hwnd（hwnd 优先于 title），回执带窗口几何与「坐标不能用于点击」", async () => {
    const { guest, calls } = fakeGuest({});
    const outcome = await run(guest, { action: "screenshot", maxWidth: 640, window: 4321 });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(calls.windowShots, [{ hwnd: 4321, maxWidth: 640 }]);
    // 整桌面那条路径一个字都不该被碰
    assert.deepEqual(calls.screenshot, []);
    assert.deepEqual(outcome.shot, {
      width: 800,
      height: 600,
      nativeWidth: 800,
      nativeHeight: 600,
      data: "d2luZG93",
    });
    assert.match(outcome.text, /window "Edge - 新建标签页" \(hwnd 4321\)/);
    assert.match(outcome.text, /covering it do not matter/);
    assert.match(outcome.text, /do not pass them to computer_click/);
    assert.equal(calls.listWindows.length, 0, "成功时不该去列窗口");
  });

  test("window 是字符串：按标题下发 title；最小化恢复要在正文里说清楚", async () => {
    const { guest, calls } = fakeGuest({
      windowShot: {
        ok: true,
        jpegBase64: "d2luZG93",
        width: 400,
        height: 300,
        nativeWidth: 800,
        nativeHeight: 600,
        hwnd: 7,
        title: "记事本",
        restoredFromMinimized: true,
        takenAt: 3,
      },
    });
    const outcome = await run(guest, { action: "screenshot", window: "记事" });
    assert.equal(outcome.ok, true);
    assert.deepEqual(calls.windowShots, [{ title: "记事" }]);
    if (outcome.ok) assert.match(outcome.text, /had been minimized and has been restored/);
  });

  test("拍不到：桥的人话原样带出（hwnd 路径不列候选——那就是那个窗口本身拍不到）", async () => {
    const { guest, calls } = fakeGuest({
      windowShot: { ok: false, error: "这个窗口拍不到（…）——改用整桌面截图或 computer_screenshot" },
    });
    const outcome = await run(guest, { action: "screenshot", window: 9 });
    assert.deepEqual(outcome, { ok: false, error: "这个窗口拍不到（…）——改用整桌面截图或 computer_screenshot" });
    assert.deepEqual(calls.listWindows, []);
  });

  test("按标题拍不到：保留原话并追加候选窗口（模型下一步要传 hwnd 或换标题）", async () => {
    const { guest, calls } = fakeGuest({
      windowShot: { ok: false, error: "没找到标题包含「不存在的」的窗口" },
    });
    const outcome = await run(guest, { action: "screenshot", window: "不存在的" });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.match(outcome.error, /^没找到标题包含「不存在的」的窗口/, "原话必须在前，不得改写");
    assert.match(outcome.error, /Windows you can capture right now/);
    assert.match(outcome.error, /hwnd 4321 "Edge - 新建标签页" \(msedge\)/);
    // 列候选有独立预算：不能吃默认 45s（那条路刚白等过一次）
    assert.deepEqual(calls.listWindows, [5_000]);
  });

  test("列候选自己失败：不影响原错误（不能让「列失败」顶掉真正的失败原因）", async () => {
    const { guest } = fakeGuest({
      windowShot: { ok: false, error: "没找到那个窗口" },
      windowList: { ok: false, error: "桥死了" },
    });
    const outcome = await run(guest, { action: "screenshot", window: "x" });
    assert.deepEqual(outcome, { ok: false, error: "没找到那个窗口" });
  });

  test("不带 window 的 screenshot 仍然走整桌面那条路（没被新分支吃掉）", async () => {
    const { guest, calls } = fakeGuest({});
    const outcome = await run(guest, { action: "screenshot" });
    assert.equal(outcome.ok, true);
    assert.deepEqual(calls.windowShots, []);
    assert.equal(calls.screenshot.length, 1);
  });
});

describe("applyComputerUseRequest：UIA 车道（uia-list / uia-act，桥 0.10.0）", () => {
  test("uia-list：窗口数字 = hwnd、maxItems 原样下发；正文带 ref / patterns / 几何与「不占桌面」", async () => {
    const { guest, calls } = fakeGuest({});
    const outcome = await run(guest, { action: "uia-list", window: 4321, maxItems: 60 });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(calls.uiaLists, [{ hwnd: 4321, maxItems: 60 }]);
    assert.deepEqual(calls.uiaActs, []);
    assert.match(outcome.text, /window "Untitled - Notepad" \(hwnd 4321\): 2 listed/);
    // 每一行都要让模型能直接拿去 act：ref、控件类型、名字、支持的模式
    assert.match(outcome.text, /1 · document "Text editor" · supports value/);
    assert.match(outcome.text, /2 · button "Close" · supports invoke/);
    assert.match(outcome.text, /at 730,0 45×30 id=Close/);
    assert.match(outcome.text, /does not need the foreground/);
    assert.match(outcome.text, /There is no "focus" action/, "动作集变了，回执就得跟着说清");
    assert.match(outcome.text, /click the target with computer_click/, "不提供 focus 就要给替代路径");
    assert.match(outcome.text, /refs belong to the latest list/);
  });

  test("uia-list：标题片段原样下发；截断时告诉模型调大 maxItems；空列表给一句人话", async () => {
    const truncated = fakeGuest({
      uiaList: {
        ok: true,
        hwnd: 7,
        window: { title: "记事本", className: "Notepad" },
        items: [],
        truncated: true,
      },
    });
    const outcome = await run(truncated.guest, { action: "uia-list", window: "记事", maxItems: 1 });
    assert.deepEqual(truncated.calls.uiaLists, [{ title: "记事", maxItems: 1 }]);
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.match(outcome.text, /raise maxItems/);
      assert.match(outcome.text, /No actionable controls were found/);
    }
  });

  test("uia-list 失败：桥的人话原样带出（不改写成「没有响应」之类）", async () => {
    const human = "没找到标题包含「不存在的」的窗口——先用 win-list 看现在有哪些窗口";
    const { guest } = fakeGuest({ uiaList: { ok: false, error: human } });
    assert.deepEqual(await run(guest, { action: "uia-list", window: "不存在的" }), { ok: false, error: human });
  });

  test("uia-act：perform / ref / name / value / timeoutMs 都原样到控制器；正文点明模式与不抢前台", async () => {
    const { guest, calls } = fakeGuest({});
    const outcome = await run(guest, {
      action: "uia-act",
      window: 4321,
      ref: 2,
      perform: "invoke",
      timeoutMs: 1500,
    });
    assert.equal(outcome.ok, true);
    assert.deepEqual(calls.uiaActs, [{ hwnd: 4321, ref: 2, perform: "invoke", timeoutMs: 1500 }]);
    if (outcome.ok) {
      assert.match(outcome.text, /Invoked "Close" \(button\) in window hwnd 4321/);
      assert.match(outcome.text, /pattern invoke, 7ms/);
      assert.match(outcome.text, /did not need the foreground/);
      assert.match(outcome.text, /To move the keyboard focus, click the target with computer_click/);
      assert.match(outcome.text, /computer_screenshot \(window 4321\)/);
    }

    const typed = fakeGuest({});
    await run(typed.guest, { action: "uia-act", window: "记事本", name: "Text editor", perform: "setValue", value: "hello" });
    assert.deepEqual(typed.calls.uiaActs, [
      { title: "记事本", name: "Text editor", perform: "setValue", value: "hello" },
    ]);
  });

  test("uia-act 的三种回执动词各就各位（focus 已不是动作，没有它的分支）", async () => {
    const set = await run(fakeGuest({}).guest, {
      action: "uia-act",
      window: 1,
      ref: 1,
      perform: "setValue",
      value: "hello",
    });
    assert.equal(set.ok, true);
    if (set.ok) assert.match(set.text, /^Set the text of "Close"/);

    const selected = await run(fakeGuest({}).guest, { action: "uia-act", window: 1, ref: 1, perform: "selection" });
    assert.equal(selected.ok, true);
    if (selected.ok) assert.match(selected.text, /^Selected "Close"/);
  });

  test("uia-act 关不掉 AutoSetFocus：正文追加「可能抢焦点」的警告，不把成功说成失败", async () => {
    const { guest } = fakeGuest({
      uiaAct: {
        ok: true,
        hwnd: 9,
        action: "invoke",
        usedPattern: "invoke",
        name: "OK",
        controlType: "button",
        autoSetFocus: false,
        autoSetFocusWarning: "AutoSetFocus 关不掉（这个系统的 UIA 客户端没有 IUIAutomation2）——可能抢焦点",
        elapsedMs: 12,
      },
    });
    const outcome = await run(guest, { action: "uia-act", window: 9, name: "OK", perform: "invoke" });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.match(outcome.text, /^Invoked "OK"/, "成功这件事必须还在第一句");
      assert.match(outcome.text, /Warning: AutoSetFocus 关不掉/);
    }
  });

  test("uia-act 失败：不支持模式的文案（点名支持什么 + 像素退路）原话带出", async () => {
    const human = "这个控件不支持 invoke（edit，它支持：value）。改用 computer_click / computer_type 的像素路径";
    const { guest } = fakeGuest({ uiaAct: { ok: false, error: human } });
    assert.deepEqual(await run(guest, { action: "uia-act", window: 1, ref: 3, perform: "invoke" }), {
      ok: false,
      error: human,
    });
  });
});
