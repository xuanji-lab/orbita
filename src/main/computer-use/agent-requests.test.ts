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
  ComputerUseWindowListResult,
  ComputerUseWindowShotResult,
} from "../../shared/computer-use.ts";
import type { GuestCommandResult } from "./sandbox.ts";

interface WindowShotFields {
  hwnd?: number;
  title?: string;
  maxWidth?: number;
}

interface Calls {
  screenshot: number[];
  commands: Array<{ command: ComputerUseGuestCommand; fields: Record<string, unknown> }>;
  windowShots: WindowShotFields[];
  /** 每次 listWindows 收到的超时（未传 = undefined） */
  listWindows: Array<number | undefined>;
}

function fakeGuest(options: {
  shot?: ComputerUseScreenshotResult;
  windowShot?: ComputerUseWindowShotResult;
  windowList?: ComputerUseWindowListResult;
  commandResult?: GuestCommandResult;
  throwOn?: "screenshot" | "command";
}): { guest: ComputerUseGuest; calls: Calls } {
  const calls: Calls = { screenshot: [], commands: [], windowShots: [], listWindows: [] };
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
    async guestCommand(command, fields): Promise<GuestCommandResult> {
      if (options.throwOn === "command") throw new Error("文件协议炸了");
      calls.commands.push({ command, fields });
      return options.commandResult ?? { ok: true };
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

  test("guest 命令失败：错误原话带出，不吞成成功", async () => {
    const { guest } = fakeGuest({ commandResult: { ok: false, error: "不认识的按键名：hyper" } });
    const outcome = await run(guest, { action: "key", key: "hyper+x" });
    assert.deepEqual(outcome, { ok: false, error: "不认识的按键名：hyper" });
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
