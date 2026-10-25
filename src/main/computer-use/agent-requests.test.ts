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
} from "../../shared/computer-use.ts";
import type { GuestCommandResult } from "./sandbox.ts";

interface Calls {
  screenshot: number[];
  commands: Array<{ command: ComputerUseGuestCommand; fields: Record<string, unknown> }>;
}

function fakeGuest(options: {
  shot?: ComputerUseScreenshotResult;
  commandResult?: GuestCommandResult;
  throwOn?: "screenshot" | "command";
}): { guest: ComputerUseGuest; calls: Calls } {
  const calls: Calls = { screenshot: [], commands: [] };
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
