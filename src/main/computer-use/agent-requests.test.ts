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
import { COMPUTER_USE_DELIVERY_HINTS, COMPUTER_USE_NO_EVIDENCE_HINT } from "../../shared/computer-use.ts";
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
import type { SandboxCapabilities } from "./provider.ts";
import { QEMU_CAPABILITIES } from "./qemu.ts";

interface WindowShotFields {
  hwnd?: number;
  title?: string;
  maxWidth?: number;
}

interface UiaListFields {
  hwnd?: number;
  title?: string;
  maxItems?: number;
  since?: number;
}

interface UiaActFields {
  hwnd?: number;
  title?: string;
  ref?: string;
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
      return options.commandResult ?? { ok: true, resp: { ok: true, delivery: "unverifiable" } };
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
          generation: 4,
          mode: "full",
          items: [
            {
              ref: "g4:r1",
              stableId: "rt:2a.10.1",
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
              isPassword: false,
            },
            {
              ref: "g4:r2",
              stableId: "rt:2a.10.2",
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
              isPassword: false,
            },
          ],
          removed: [],
          unchanged: 0,
          rectMoved: 0,
          truncated: false,
          passwordFields: 0, editFields: 0,
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
      assert.ok(outcome.text.includes(COMPUTER_USE_DELIVERY_HINTS.unverifiable));
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

  test("交付五档：老桥 dispatched→unverifiable，applied 无证据被降级，failed→refused", async () => {
    // 老桥 dispatched：归一成 unverifiable——**模型不许重放**
    const dispatched = fakeGuest({ commandResult: { ok: true, resp: { ok: true, delivery: "dispatched" } } });
    const dispatchedOutcome = await run(dispatched.guest, { action: "click", x: 10, y: 20 });
    assert.equal(dispatchedOutcome.ok && dispatchedOutcome.delivery, "unverifiable");
    if (dispatchedOutcome.ok) {
      // 关系断言：回执正文里那句话 === 单一来源里的那一句
      assert.ok(dispatchedOutcome.text.includes(COMPUTER_USE_DELIVERY_HINTS.unverifiable));
      assert.match(dispatchedOutcome.text, /先截一张图/);
      assert.match(dispatchedOutcome.text, /不要立刻重放/);
    }

    // 新值 unverifiable：与老值落同一档，回执逐字一致
    const current = fakeGuest({ commandResult: { ok: true, resp: { ok: true, delivery: "unverifiable" } } });
    const currentOutcome = await run(current.guest, { action: "click", x: 10, y: 20 });
    assert.equal(currentOutcome.ok && currentOutcome.delivery, "unverifiable");
    if (dispatchedOutcome.ok && currentOutcome.ok) {
      assert.equal(currentOutcome.text, dispatchedOutcome.text);
    }

    // 老桥 applied：parse 归一成 confirmed，但回执里**没有读回证据** → 工具层必须降级为
    // unverifiable。这正是这次要消灭的谎报：不许凭桥的一句话对模型说「已确认生效」。
    const applied = fakeGuest({ commandResult: { ok: true, resp: { ok: true, delivery: "applied" } } });
    const appliedOutcome = await run(applied.guest, { action: "type", text: "x" });
    assert.equal(appliedOutcome.ok && appliedOutcome.delivery, "unverifiable");
    if (appliedOutcome.ok) {
      assert.ok(appliedOutcome.text.includes(COMPUTER_USE_DELIVERY_HINTS.unverifiable));
      assert.doesNotMatch(appliedOutcome.text, /动作已经生效/);
    }

    // 老桥 / 桥没说 / 不认识的档位：一律按「已发出、未验证」——像素命令拿到 ok 回执
    // 本来就只能说明事件入了队（不能凭缺失就把「未验证」升级成「已生效」）
    for (const resp of [{ ok: true }, { ok: true, delivery: "possibly" }]) {
      const silent = fakeGuest({ commandResult: { ok: true, resp } });
      const outcome = await run(silent.guest, { action: "key", key: "enter" });
      assert.equal(outcome.ok && outcome.delivery, "unverifiable");
    }

    // failed：桥明确拒绝（refused = 确定没发出去，可以放心修参数重试）。
    // 老桥发的 "failed" 在 bridge-client 就归一成 refused 了（sandbox.test.ts 验那一跳），
    // GuestCommandReply.delivery 上永远不会出现老值。
    const refusedFirst = fakeGuest({
      commandResult: { ok: false, error: "button 只能是 left / right / middle，收到：wheel", delivery: "refused" },
    });
    const refusedOutcome = await run(refusedFirst.guest, { action: "click", x: 1, y: 2 });
    assert.deepEqual(refusedOutcome, {
      ok: false,
      error: "button 只能是 left / right / middle，收到：wheel",
      delivery: "refused",
    });

    // 同一档再跑一次：回执逐字一致（这一层没有随调用累积的隐藏状态）
    const refused = fakeGuest({
      commandResult: { ok: false, error: "button 只能是 left / right / middle，收到：wheel", delivery: "refused" },
    });
    assert.deepEqual(await run(refused.guest, { action: "click", x: 1, y: 2 }), refusedOutcome);

    // 超时 / 沙箱没在跑：没有那一档——「不知道成没成」不能写成 refused（会鼓励重放）
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
    const uia = await run(guest, { action: "uia-act", window: 4321, ref: "g4:r2", perform: "invoke" });
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
    assert.match(outcome.text, /window "Untitled - Notepad" \(hwnd 4321, generation 4\): 2 listed/);
    // 每一行都要让模型能直接拿去 act：ref（带代次的 token）、控件类型、名字、支持的模式
    assert.match(outcome.text, /g4:r1 · document "Text editor" · supports value/);
    assert.match(outcome.text, /g4:r2 · button "Close" · supports invoke/);
    assert.match(outcome.text, /at 730,0 45×30 id=Close/);
    assert.match(outcome.text, /does not need the foreground/);
    assert.match(outcome.text, /There is no "focus" action/, "动作集变了，回执就得跟着说清");
    assert.match(outcome.text, /click the target with computer_click/, "不提供 focus 就要给替代路径");
    // 感知层（桥 0.14.0）：尾巴必须教模型「下次带 since」与「ref 只属于它那一代」
    assert.match(outcome.text, /pass since=4 to get only what changed/);
    assert.match(outcome.text, /a ref from an older list is rejected/);
  });

  test("uia-list 带 since：只列变化 + 消失的控件 + unchanged 计数，并说清「没变的没列」", async () => {
    const { guest, calls } = fakeGuest({
      uiaList: {
        ok: true,
        hwnd: 4321,
        window: { title: "Untitled - Notepad", className: "Notepad" },
        generation: 5,
        mode: "diff",
        since: 4,
        items: [
          {
            ref: "g5:r2",
            stableId: "rt:2a.10.2",
            name: "Close",
            controlType: "button",
            automationId: "Close",
            className: "Button",
            x: 730,
            y: 0,
            w: 45,
            h: 30,
            patterns: ["invoke"],
            enabled: false,
            offscreen: false,
            isPassword: false,
            change: "changed",
            changed: ["enabled"],
          },
          {
            ref: "g5:r3",
            stableId: "rt:2a.10.9",
            name: "Save",
            controlType: "button",
            automationId: "Save",
            className: "Button",
            x: 680,
            y: 0,
            w: 45,
            h: 30,
            patterns: ["invoke"],
            enabled: true,
            offscreen: false,
            isPassword: false,
            change: "added",
          },
        ],
        removed: [{ stableId: "rt:2a.10.7", name: "Help", controlType: "menu-item" }],
        unchanged: 7,
        rectMoved: 0,
        truncated: false,
        passwordFields: 0, editFields: 0,
      },
    });
    const outcome = await run(guest, { action: "uia-list", window: 4321, since: 4 });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(calls.uiaLists, [{ hwnd: 4321, since: 4 }], "since 原样下发（不给就不写这个键）");
    assert.match(outcome.text, /changes|2 changed, 1 gone, 7 unchanged since generation 4/);
    assert.match(outcome.text, /changed \(enabled\) · g5:r2 · button "Close"/);
    assert.match(outcome.text, /new · g5:r3 · button "Save"/);
    assert.match(outcome.text, /gone · menu-item "Help" — no longer in this window/);
    // 关键的使用性说明：diff 里没有的控件怎么动
    assert.match(outcome.text, /did not change is not listed here: act on it by name/);
  });

  test("uia-list：since 那一代已被淘汰 → 桥回全量 + note，正文把那句说明带出来", async () => {
    const { guest } = fakeGuest({
      uiaList: {
        ok: true,
        hwnd: 5,
        window: { title: "记事本", className: "Notepad" },
        generation: 9,
        mode: "full",
        items: [],
        removed: [],
        unchanged: 0,
        rectMoved: 0,
        truncated: false,
        passwordFields: 0,
        editFields: 0,
        note: "记不住那么早的清单了（每个窗口只保留最近 5 代）——这是全量。",
      },
    });
    const outcome = await run(guest, { action: "uia-list", window: 5, since: 1 });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.match(outcome.text, /generation 9/);
    assert.match(outcome.text, /Note: 记不住那么早的清单了/);
    assert.match(outcome.text, /这是全量/);
    assert.match(outcome.text, /No actionable controls were found/);
  });

  test("uia-list：标题片段原样下发；截断时告诉模型调大 maxItems；空列表给一句人话", async () => {
    const truncated = fakeGuest({
      uiaList: {
        ok: true,
        hwnd: 7,
        window: { title: "记事本", className: "Notepad" },
        generation: 1,
        mode: "full",
        items: [],
        removed: [],
        unchanged: 0,
        rectMoved: 0,
        truncated: true,
        passwordFields: 0, editFields: 0,
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
      ref: "g4:r2",
      perform: "invoke",
      timeoutMs: 1500,
    });
    assert.equal(outcome.ok, true);
    assert.deepEqual(calls.uiaActs, [{ hwnd: 4321, ref: "g4:r2", perform: "invoke", timeoutMs: 1500 }]);
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
      ref: "g1:r1",
      perform: "setValue",
      value: "hello",
    });
    assert.equal(set.ok, true);
    if (set.ok) assert.match(set.text, /^Set the text of "Close"/);

    const selected = await run(fakeGuest({}).guest, { action: "uia-act", window: 1, ref: "g1:r1", perform: "selection" });
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
    const { guest } = fakeGuest({ uiaAct: { ok: false, error: human, delivery: "refused" } });
    assert.deepEqual(await run(guest, { action: "uia-act", window: 1, ref: "g1:r3", perform: "invoke" }), {
      ok: false,
      error: human,
      delivery: "refused",
    });
  });

  // 桥回了 ok:false = 确定的拒绝（参数不合法 / 控件没有这个模式 / 窗口不在 / E_FAIL），
  // 都是「动作没有发生」。控制器层已经在 GuestCommandRejected 那里补上了 refused
  // （sandbox.ts 的 rejectedUiaAct）；这一层只负责把它交给模型并过后端闸门。
  // 超时那条**没有档位**：那时我们不知道跨进程的 UIA 调用有没有落下，不能替它断言。
  describe("uia-act 的明确拒绝（refused）与超时（不猜档位）", () => {
    const rejections: readonly { what: string; error: string }[] = [
      {
        what: "控件不支持这个模式",
        error:
          "这个控件不支持 setValue（text，它支持：没有任何本车道可用的模式）。" +
          "改用 computer_click / computer_type 的像素路径，或者先用 computer_screenshot 看一眼它现在的位置。",
      },
      {
        what: "UIA 调用自己报 E_FAIL",
        error: "UIA 动作 setValue 失败（HRESULT 0x80004005）——先用 computer_screenshot 看一眼，必要时改用像素路径。",
      },
      { what: "窗口已经不在了", error: "这个窗口已经不在了（hwnd 196974）——先用 win-list 看现在有哪些窗口" },
    ];

    for (const { what, error } of rejections) {
      test(`${what} → delivery:"refused"，桥的人话一个字不改`, async () => {
        const { guest } = fakeGuest({ uiaAct: { ok: false, error, delivery: "refused" } });
        assert.deepEqual(await run(guest, { action: "uia-act", window: 1, ref: "g1:r1", perform: "setValue" }), {
          ok: false,
          error,
          delivery: "refused",
        });
      });
    }

    test("超时（控制器层没有档位）→ 回执里没有 delivery，绝不补成 refused", async () => {
      // 生产里这一条来自 sandbox.ts 的普通 catch：命令没回应，谁也不知道模式调用有没有落下去。
      const timeout = "沙箱里的桌面没有响应（uia-act 超时 45s）——也许是沙箱卡住了或正在重置";
      const { guest } = fakeGuest({ uiaAct: { ok: false, error: timeout } });
      assert.deepEqual(await run(guest, { action: "uia-act", window: 1, ref: "g1:r1", perform: "invoke" }), {
        ok: false,
        error: timeout,
      });
    });

    test("后端声明拿不到读回也不动 refused（它是「确定没做」，不是证据档）", async () => {
      const { guest } = fakeGuest({ uiaAct: { ok: false, error: "这个窗口已经不在了", delivery: "refused" } });
      const outcome = await applyComputerUseRequest(
        guest,
        "s1",
        { action: "uia-act", window: 1, ref: "g1:r1", perform: "invoke" },
        { ...QEMU_CAPABILITIES, evidence: "none" },
      );
      assert.deepEqual(outcome, { ok: false, error: "这个窗口已经不在了", delivery: "refused" });
    });
  });
});

// ── 密码框遮罩与归属（桥 0.12.0）────────────────────────────────────────────
//
// 两条纪律：
//   ① 遮了就说「这块黑是有意的」，并且模型要能学到「密码不该进你的上下文」；
//   ② **没遮必须明说**——让模型以为遮了比不遮更坏（它会放心地读图）。
// 这两句之外，回执正文一个字都不该变（那些文案在真实会话里已经被稳住了）。
describe("applyComputerUseRequest：密码框遮罩（桥 0.12.0）", () => {
  test("整桌面截图：遮了 N 块 → 正文说明 + outcome.capture 原样透传（审计要用）", async () => {
    const capture = {
      maskedRegions: 2,
      maskListed: true,
      maskStale: false,
      maskCacheAgeMs: 1500,
      userTyping: false,
    };
    const { guest } = fakeGuest({
      shot: {
        ok: true,
        jpegBase64: "anBlZw==",
        width: 1280,
        height: 720,
        nativeWidth: 2560,
        nativeHeight: 1440,
        takenAt: 1,
        capture,
      },
    });
    const outcome = await run(guest, { action: "screenshot", maxWidth: 1280 });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.match(outcome.text, /2 password fields in this image were blacked out/);
    assert.doesNotMatch(outcome.text, /NOT masked/);
    // 审计读的就是这一份（工具层把它翻成 maskedRegions / userTypingAtCapture）
    assert.deepEqual(outcome.capture, capture);
  });

  test("整桌面截图：清单过期 → 正文必须写明「这张图没遮」", async () => {
    const { guest } = fakeGuest({
      shot: {
        ok: true,
        jpegBase64: "anBlZw==",
        width: 1280,
        height: 720,
        nativeWidth: 2560,
        nativeHeight: 1440,
        takenAt: 1,
        capture: { maskedRegions: 0, maskListed: false, maskStale: true, maskCacheAgeMs: 61_000, userTyping: false },
      },
    });
    const outcome = await run(guest, { action: "screenshot" });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.match(outcome.text, /WARNING: this image is NOT masked/);
    assert.match(outcome.text, /61s old/);
    assert.match(outcome.text, /computer_uia list on that window again/);
  });

  test("整桌面截图：用户在打字 → 正文添一句「图可能已经过时」", async () => {
    const { guest } = fakeGuest({
      shot: {
        ok: true,
        jpegBase64: "anBlZw==",
        width: 1280,
        height: 720,
        nativeWidth: 2560,
        nativeHeight: 1440,
        takenAt: 1,
        capture: { maskedRegions: 0, maskListed: true, maskStale: false, maskCacheAgeMs: 100, userTyping: true },
      },
    });
    const outcome = await run(guest, { action: "screenshot" });
    if (!outcome.ok) return;
    assert.match(outcome.text, /A person was typing in the sandbox/);
  });

  test("老桥回执没有 capture：正文一个字不加、outcome 也不编一个 capture 出来", async () => {
    const { guest } = fakeGuest({});
    const outcome = await run(guest, { action: "screenshot" });
    if (!outcome.ok) return;
    assert.doesNotMatch(outcome.text, /NOT masked/);
    assert.doesNotMatch(outcome.text, /blacked out/);
    assert.equal(outcome.capture, undefined);
  });

  test("窗口截图同样带遮罩说明（两条截图车道共用一份拼法）", async () => {
    const { guest } = fakeGuest({
      windowShot: {
        ok: true,
        jpegBase64: "d2luZG93",
        width: 800,
        height: 600,
        nativeWidth: 800,
        nativeHeight: 600,
        hwnd: 4321,
        title: "登录 - Edge",
        restoredFromMinimized: false,
        takenAt: 2,
        capture: { maskedRegions: 1, maskListed: true, maskStale: false, maskCacheAgeMs: 800, userTyping: true },
      },
    });
    const outcome = await run(guest, { action: "screenshot", window: 4321 });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.match(outcome.text, /1 password field in this image was blacked out/);
    assert.match(outcome.text, /A person was typing in the sandbox/);
    assert.match(outcome.text, /do not pass them to computer_click/, "窗口图的坐标纪律不能被遮罩说明顶掉");
  });

  test("uia-list：密码框那一行标 password，标题行点名「这是密码框、别往里写秘密」", async () => {
    const { guest } = fakeGuest({
      uiaList: {
        ok: true,
        hwnd: 4321,
        window: { title: "登录 - Edge", className: "Chrome_WidgetWin_1" },
        generation: 2,
        mode: "full",
        items: [
          {
            ref: "g2:r1",
            stableId: "h:0a1b2c3d",
            name: "",
            controlType: "edit",
            automationId: "password",
            className: "Edit",
            x: 100,
            y: 200,
            w: 300,
            h: 30,
            patterns: ["value"],
            enabled: true,
            offscreen: false,
            isPassword: true,
          },
        ],
        removed: [],
        unchanged: 0,
        rectMoved: 0,
        truncated: false,
        passwordFields: 1, editFields: 0,
      },
    });
    const outcome = await run(guest, { action: "uia-list", window: 4321 });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.match(outcome.text, /g2:r1 · edit \(automationId password\) · supports value, password/);
    assert.match(outcome.text, /1 password field\(s\) are in this window/);
    assert.match(outcome.text, /screenshots of this window will black them out/);
  });

  test("uia-list：有输入框但一个密码框都没认出 → 明确警告「树可能还没长完，截图不会遮」", async () => {
    // 真机现场（2026-11-15 验收）：登录页刚打开 +2.5s 只看到 17 条、0 个密码框，
    // +4.5s 才 20 条、1 个。这 2 秒里截图不遮也不报警——所以「有 edit 没 password」
    // 必须给模型一句人话，而不是沉默。
    const { guest } = fakeGuest({
      uiaList: {
        ok: true,
        hwnd: 4321,
        window: { title: "Sign in", className: "Chrome_WidgetWin_1" },
        generation: 1,
        mode: "full",
        items: [
          {
            ref: "g1:r1",
            stableId: "rt:1",
            name: "",
            controlType: "edit",
            automationId: "user",
            className: "Edit",
            x: 10,
            y: 20,
            w: 200,
            h: 24,
            patterns: ["value"],
            enabled: true,
            offscreen: false,
            isPassword: false,
          },
        ],
        removed: [],
        unchanged: 0,
        rectMoved: 0,
        truncated: false,
        passwordFields: 0,
        editFields: 1,
      },
    });
    const outcome = await run(guest, { action: "uia-list", window: 4321 });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.match(outcome.text, /1 input field\(s\) but no password field was recognised/);
    assert.match(outcome.text, /control tree may still be growing/);
    assert.doesNotMatch(outcome.text, /password field\(s\) are in this window/);
  });
});

/**
 * 后端能力 → 交付档位的门控（P0-4）。
 *
 * 为什么必须有这一层：`evidence: "none"` 的后端（L3 的 Linux 桌面）没有任何精确读回，
 * 所以 `confirmed` / `suspected_noop` 在它上面**永远不可能为真**。桥要是（现在或将来的某条
 * 路径）说了这两档，交给模型就是谎报：它会等一个不会来的确认，或者相信「值没变」，
 * 然后开始瞎试。松的那道闸门（settleComputerUseDelivery）只拦得住无证据的 confirmed，
 * 拦不住 suspected_noop，也拦不住伪造出来的证据对象——所以这里按**声明**再拦一次。
 */
describe("applyComputerUseRequest：按后端声明的证据级别门控档位", () => {
  // 拿真后端的能力声明当夹具：验的是「qemu 声明成什么样，工具层就怎么对待它」
  const withEvidence = (evidence: SandboxCapabilities["evidence"]): SandboxCapabilities => ({
    ...QEMU_CAPABILITIES,
    evidence,
  });

  /** 带上能力声明跑一次（4 个参数那一条路） */
  const runWith = (guest: ComputerUseGuest, request: ComputerUseToolRequest, capabilities: SandboxCapabilities | null) =>
    applyComputerUseRequest(guest, "s1", request, capabilities);

  test("evidence: none → confirmed 也降成 unverifiable，并追加「拿不到读回、点完请截图确认」", async () => {
    const { guest } = fakeGuest({ commandResult: { ok: true, resp: { ok: true, delivery: "confirmed" } } });
    const outcome = await runWith(guest, { action: "click", x: 10, y: 20 }, withEvidence("none"));
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.delivery, "unverifiable");
    // 单一来源：正文里那句话 === shared 的 COMPUTER_USE_NO_EVIDENCE_HINT
    assert.ok(outcome.text.includes(COMPUTER_USE_NO_EVIDENCE_HINT));
    assert.match(outcome.text, /拿不到任何读回/);
    assert.match(outcome.text, /computer_screenshot/);
    // 五档那句也在（模型仍然要知道「不要立刻重放」）
    assert.ok(outcome.text.includes(COMPUTER_USE_DELIVERY_HINTS.unverifiable));
    // 绝不能出现「已确认生效」
    assert.doesNotMatch(outcome.text, /动作已经生效/);
  });

  test("evidence: none → suspected_noop 也降成 unverifiable（只靠「这次没证据」拦不住这一档）", async () => {
    const { guest } = fakeGuest({ commandResult: { ok: true, resp: { ok: true, delivery: "suspected_noop" } } });
    const outcome = await runWith(guest, { action: "type", text: "hi" }, withEvidence("none"));
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.delivery, "unverifiable");
    assert.ok(outcome.text.includes(COMPUTER_USE_NO_EVIDENCE_HINT));
    assert.doesNotMatch(outcome.text, /读回的值没变/);
  });

  test("evidence: none → 其余三档不动（unverifiable 仍是 unverifiable，refused 仍是 refused）", async () => {
    const loose = fakeGuest({ commandResult: { ok: true, resp: { ok: true, delivery: "unverifiable" } } });
    const unverifiable = await runWith(loose.guest, { action: "key", key: "enter" }, withEvidence("none"));
    assert.equal(unverifiable.ok, true);
    if (unverifiable.ok) {
      assert.equal(unverifiable.delivery, "unverifiable");
      // refused/unverifiable 不重复追加（那句话只在能确认的档位被降级后才有信息量）——
      // 但 unverifiable 本身也要那句：这类后端永远拿不到读回，模型不能等。
      assert.ok(unverifiable.text.includes(COMPUTER_USE_NO_EVIDENCE_HINT));
    }

    const refused = fakeGuest({
      commandResult: { ok: false, error: "button 只能是 left / right / middle，收到：wheel", delivery: "refused" },
    });
    const failed = await runWith(refused.guest, { action: "click", x: 1, y: 2 }, withEvidence("none"));
    // 失败回执是桥的错误原话，不被这段门控改写、也不追加截图提示
    assert.deepEqual(failed, {
      ok: false,
      error: "button 只能是 left / right / middle，收到：wheel",
      delivery: "refused",
    });
  });

  test("拿不到后端能力（null / 省略）→ 档位不变、也不追加那句话（不猜）", async () => {
    // suspected_noop 是这里唯一能区分「降档」与「不降档」的档位：
    // confirmed 无论有没有能力都会被「没证据」那道闸门降掉，看不出差别。
    for (const capabilities of [null, undefined]) {
      const { guest } = fakeGuest({ commandResult: { ok: true, resp: { ok: true, delivery: "suspected_noop" } } });
      const outcome =
        capabilities === undefined
          ? await run(guest, { action: "click", x: 5, y: 6 })
          : await runWith(guest, { action: "click", x: 5, y: 6 }, capabilities);
      assert.equal(outcome.ok, true);
      if (!outcome.ok) continue;
      assert.equal(outcome.delivery, "suspected_noop", "拿不到能力不等于没有证据能力");
      assert.equal(outcome.text.includes(COMPUTER_USE_NO_EVIDENCE_HINT), false);
    }
  });

  test("evidence: value / window → 不降档、不追加（能读回的后端照旧）", async () => {
    for (const evidence of ["value", "window"] as const) {
      const { guest } = fakeGuest({ commandResult: { ok: true, resp: { ok: true, delivery: "suspected_noop" } } });
      const outcome = await runWith(guest, { action: "scroll", x: 1, y: 2, deltaY: 1 }, withEvidence(evidence));
      assert.equal(outcome.ok, true);
      if (!outcome.ok) continue;
      assert.equal(outcome.delivery, "suspected_noop", evidence);
      assert.equal(outcome.text.includes(COMPUTER_USE_NO_EVIDENCE_HINT), false, evidence);
    }
  });

  test("evidence: none 时失败回执里的 confirmed 也降档（失败 + 已确认生效是矛盾）", async () => {
    const { guest } = fakeGuest({ commandResult: { ok: false, error: "桥说成功了但整体失败", delivery: "confirmed" } });
    const outcome = await runWith(guest, { action: "click", x: 3, y: 4 }, withEvidence("none"));
    assert.deepEqual(outcome, { ok: false, error: "桥说成功了但整体失败", delivery: "unverifiable" });
  });

  test("直接传后端控制器（不经过门面）也按它自己声明的 capabilities 门控", async () => {
    // 后端控制器上 `capabilities` 是个属性（SandboxProvider），不是门面那个方法。
    // 这条退路要真的通：否则换个入口就能把 suspected_noop 漏给模型
    const { guest } = fakeGuest({ commandResult: { ok: true, resp: { ok: true, delivery: "suspected_noop" } } });
    const declaring: ComputerUseGuest & { capabilities: SandboxCapabilities } = {
      ...guest,
      capabilities: QEMU_CAPABILITIES,
    };
    const outcome = await run(declaring, { action: "click", x: 7, y: 8 });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.delivery, "unverifiable");
    assert.ok(outcome.text.includes(COMPUTER_USE_NO_EVIDENCE_HINT));
  });
});

/**
 * 回执里的 evidence → 降级闸门（上一轮验收指出的 gap）。
 *
 * 为什么值得单独测：桥（0.15.0）开始发证据了，但这一层以前调 settleComputerUseDelivery 时
 * **不传 evidence**——于是每一条 confirmed 都被降成 unverifiable，桥发来的证据等于白费。
 * 这条链路断开不会报错，只会让模型永远等不到确认。
 */
describe("applyComputerUseRequest：把桥的 evidence 传进降级闸门", () => {
  const withEvidence = (level: SandboxCapabilities["evidence"]): SandboxCapabilities => ({
    ...QEMU_CAPABILITIES,
    evidence: level,
  });

  test("有证据 + 后端能读回 → confirmed 保留（以前这里永远是 unverifiable）", async () => {
    const evidence = { kind: "value", detail: '期望 "hi"，读回 "hi"' };
    const { guest } = fakeGuest({
      commandResult: { ok: true, resp: { ok: true, delivery: "confirmed", evidence } },
    });
    const outcome = await applyComputerUseRequest(guest, "s1", { action: "type", text: "hi" }, withEvidence("value"));
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.delivery, "confirmed");
    assert.ok(outcome.text.includes(COMPUTER_USE_DELIVERY_HINTS.confirmed));
  });

  test("证据形状不对 / 缺字段 → 当作没有证据（confirmed 降档，但不抛错）", async () => {
    const bad: unknown[] = [
      undefined,
      null,
      "value",
      {},
      { kind: "value" },
      { kind: "bogus", detail: "x" },
      { kind: "value", detail: "" },
      { kind: "value", detail: 42 },
    ];
    for (const evidence of bad) {
      const { guest } = fakeGuest({
        commandResult: { ok: true, resp: { ok: true, delivery: "confirmed", evidence } },
      });
      const outcome = await applyComputerUseRequest(
        guest,
        "s1",
        { action: "click", x: 1, y: 2 },
        withEvidence("value"),
      );
      assert.equal(outcome.ok, true, JSON.stringify(evidence));
      if (!outcome.ok) continue;
      assert.equal(outcome.delivery, "unverifiable", JSON.stringify(evidence));
      assert.doesNotMatch(outcome.text, /动作已经生效/);
    }
  });

  test("有证据但后端声明拿不到读回 → 仍降成 unverifiable（声明优先于证据）", async () => {
    const evidence = { kind: "window", detail: "title=已保存" };
    const { guest } = fakeGuest({
      commandResult: { ok: true, resp: { ok: true, delivery: "confirmed", evidence } },
    });
    const outcome = await applyComputerUseRequest(guest, "s1", { action: "click", x: 1, y: 2 }, withEvidence("none"));
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.delivery, "unverifiable");
    assert.ok(outcome.text.includes(COMPUTER_USE_NO_EVIDENCE_HINT));
  });
});

/**
 * partial 的产出者（P1-7 的宿主一半）。
 *
 * 桥 0.15.0 在 SendInput 只插入部分事件时回 partial + 一句 note（差几个事件、补松开了哪些）。
 * 这一层要做两件事：不把 partial 当成「没证据的 confirmed」（它是完成度档，不是确认档），
 * 以及把桥那句 note 拼进模型读得到的正文——否则模型只知道「只完成了一部分」，不知道为什么。
 */
describe("applyComputerUseRequest：partial（桥 0.15.0 真的会发）", () => {
  const note =
    "SendInput 只插入了 3/9 个事件，剩下的没有送出去；已补发松开ctrl——先截图确认现在的状态，" +
    "再决定要不要重做（不要原样重放同一个动作）。";

  test("partial 原样交给模型，正文带桥的人话（差几个事件 / 补松开了谁）", async () => {
    const { guest } = fakeGuest({
      commandResult: {
        ok: true,
        resp: { ok: true, delivery: "partial", inserted: 3, requested: 9, released: true, note },
      },
    });
    const outcome = await run(guest, { action: "key", key: "ctrl+a" });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.delivery, "partial");
    assert.ok(outcome.text.includes(COMPUTER_USE_DELIVERY_HINTS.partial));
    assert.ok(outcome.text.includes(note), "桥的 note 必须进正文（否则 partial 的原因模型看不见）");
  });

  test("partial 不被「没证据」那道闸门降档（它不是确认档）", async () => {
    for (const resp of [
      { ok: true, delivery: "partial" },
      { ok: true, delivery: "partial", note },
    ]) {
      const { guest } = fakeGuest({ commandResult: { ok: true, resp } });
      const outcome = await run(guest, { action: "type", text: "hi" });
      assert.equal(outcome.ok, true);
      if (outcome.ok) assert.equal(outcome.delivery, "partial");
    }
  });

  test("声明拿不到读回的后端也不动 partial（它是完成度，不是证据档）", async () => {
    const { guest } = fakeGuest({ commandResult: { ok: true, resp: { ok: true, delivery: "partial", note } } });
    const outcome = await applyComputerUseRequest(guest, "s1", { action: "scroll", x: 1, y: 2, deltaY: 1 }, {
      ...QEMU_CAPABILITIES,
      evidence: "none",
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.delivery, "partial");
    assert.ok(outcome.text.includes(note));
  });

  test("没有 note 就一个字都不加（不凭空编「补松开了什么」）", async () => {
    const { guest } = fakeGuest({ commandResult: { ok: true, resp: { ok: true, delivery: "partial" } } });
    const outcome = await run(guest, { action: "click", x: 1, y: 2 });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.delivery, "partial");
    assert.doesNotMatch(outcome.text, /补发/);
    assert.doesNotMatch(outcome.text, /个事件/);
  });
});

/**
 * uia-act setValue 的读回证据（P0-5 的 UIA 一半）。
 *
 * 桥 0.15.0 在 setValue 之后读回控件当前值：相等 confirmed、不等 suspected_noop（都带
 * evidence{kind:"value"}）；读回拿不到就 unverifiable 且**不发证据**。这一层的工作是：
 * 把 reply 里的 delivery + evidence 过同一套闸门后交给模型，别自己发明档位。
 */
describe("applyComputerUseRequest：uia-act setValue 的读回档位（桥 0.15.0）", () => {
  const setValueReply = (extra: Record<string, unknown>): ComputerUseUiaActResult => ({
    ok: true,
    hwnd: 9,
    action: "setValue",
    usedPattern: "value",
    name: "Text editor",
    controlType: "edit",
    autoSetFocus: true,
    elapsedMs: 5,
    ...extra,
  });

  test("读回 == 期望：confirmed + 正文带「读回证据对上了」", async () => {
    const evidence = { kind: "value" as const, detail: '期望 "hi"，读回 "hi"（ValuePattern.Current.Value）' };
    const { guest } = fakeGuest({ uiaAct: setValueReply({ delivery: "confirmed", evidence }) });
    const outcome = await run(guest, {
      action: "uia-act",
      window: 9,
      name: "Text editor",
      perform: "setValue",
      value: "hi",
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.delivery, "confirmed");
    assert.ok(outcome.text.includes(COMPUTER_USE_DELIVERY_HINTS.confirmed));
  });

  test("读回 != 期望：suspected_noop 原样交给模型（换做法，不原样重试）", async () => {
    const evidence = { kind: "value" as const, detail: '期望 "hi"，读回 "hi old"' };
    const { guest } = fakeGuest({ uiaAct: setValueReply({ delivery: "suspected_noop", evidence }) });
    const outcome = await run(guest, {
      action: "uia-act",
      window: 9,
      name: "Text editor",
      perform: "setValue",
      value: "hi",
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.delivery, "suspected_noop");
    assert.ok(outcome.text.includes(COMPUTER_USE_DELIVERY_HINTS.suspected_noop));
  });

  test("桥说 confirmed 但没发证据 → 降成 unverifiable（老桥 / 伪造证据都过不去）", async () => {
    const { guest } = fakeGuest({ uiaAct: setValueReply({ delivery: "confirmed" }) });
    const outcome = await run(guest, {
      action: "uia-act",
      window: 9,
      name: "Text editor",
      perform: "setValue",
      value: "hi",
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.delivery, "unverifiable");
    assert.doesNotMatch(outcome.text, /动作已经生效/);
  });

  test("读回拿不到：unverifiable、不发证据、也不猜成 suspected_noop", async () => {
    const { guest } = fakeGuest({ uiaAct: setValueReply({ delivery: "unverifiable" }) });
    const outcome = await run(guest, {
      action: "uia-act",
      window: 9,
      name: "Text editor",
      perform: "setValue",
      value: "hi",
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.delivery, "unverifiable");
    assert.doesNotMatch(outcome.text, /读回的值没变/);
  });

  test("声明拿不到读回的后端：confirmed / suspected_noop 都降成 unverifiable", async () => {
    const evidence = { kind: "value" as const, detail: '期望 "hi"，读回 "hi"' };
    for (const delivery of ["confirmed", "suspected_noop"] as const) {
      const { guest } = fakeGuest({ uiaAct: setValueReply({ delivery, evidence }) });
      const outcome = await applyComputerUseRequest(
        guest,
        "s1",
        { action: "uia-act", window: 9, name: "Text editor", perform: "setValue", value: "hi" },
        QEMU_CAPABILITIES,
      );
      assert.equal(outcome.ok, true, delivery);
      if (!outcome.ok) continue;
      assert.equal(outcome.delivery, "unverifiable", delivery);
      assert.ok(outcome.text.includes(COMPUTER_USE_NO_EVIDENCE_HINT), delivery);
    }
  });

  test("invoke / selection 不带这一档：outcome 里没有 delivery，正文一个字都不变", async () => {
    const { guest } = fakeGuest({});
    const outcome = await run(guest, { action: "uia-act", window: 4321, ref: "g4:r2", perform: "invoke" });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal("delivery" in outcome, false);
    assert.match(outcome.text, /^Invoked "Close"/);
    assert.doesNotMatch(outcome.text, /读回/);
  });
});
