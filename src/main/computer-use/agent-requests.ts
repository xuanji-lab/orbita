/**
 * agent 的 computer use 工具请求（computerUseRequest）→ 沙箱 guest 桥 → 回执载荷。
 *
 * **沙箱与文件协议全在主进程**（SandboxController，browserRequest 同一条边界）：
 * agent 进程不碰沙箱、不碰 out/cmd，它那边只剩「工具定义 → requestId 问答」一层薄包装。
 * 沙箱是应用级一份（不按会话分）——多个会话同时使唤它时，事件按到达顺序注入，这正是
 * 「一个桌面」的语义。
 *
 * **坐标换算不在这里**：模型给的是它看到的那张截图的像素，换算在工具层做
 * （agent/computer-tools.ts 存下最近一次截图的几何），到这一层全是沙箱物理像素。
 * 这里只做三件事：动作 → guest 命令、回执 → 给模型的人话、「沙箱没在跑」→ 一句
 * 模型能转告用户的话（启沙箱是用户在设置页按的按钮，模型自己按不了）。
 *
 * 任何路径都必须回执：挂着不回的话 agent 进程里那次工具调用会一直等下去
 * （terminalRequest / readTaskRequest 同一条纪律）。
 */
import {
  computerUseGuestCommands,
  type ComputerUseGuestCommand,
  type ComputerUseScreenshotResult,
  type ComputerUseToolOutcome,
  type ComputerUseToolRequest,
} from "../../shared/computer-use.ts";
import type { GuestCommandResult } from "./sandbox.ts";

/**
 * 这一层真正要的那两个能力。**收窄成接口而不是直接吃 SandboxController**：
 * 回执组装是纯翻译，测试注入一个只有这两个方法的假沙箱就够，不必起状态机、
 * 不必碰文件协议（SandboxController 结构上满足它，生产环境直接传实例）。
 */
export interface ComputerUseGuest {
  screenshot(maxWidth?: number): Promise<ComputerUseScreenshotResult>;
  guestCommand(command: ComputerUseGuestCommand, fields: Record<string, unknown>): Promise<GuestCommandResult>;
}

export async function applyComputerUseRequest(
  controller: ComputerUseGuest,
  request: ComputerUseToolRequest,
): Promise<ComputerUseToolOutcome> {
  try {
    switch (request.action) {
      case "screenshot": {
        const shot = await controller.screenshot(request.maxWidth);
        if (!shot.ok) return { ok: false, error: shot.error };
        return {
          ok: true,
          text:
            `Screenshot of the sandbox desktop: the image is ${shot.width}×${shot.height}, the physical screen is ` +
            `${shot.nativeWidth}×${shot.nativeHeight}. Coordinates you pass to computer_click / computer_scroll are ` +
            "pixels of this image. Take a fresh screenshot after every action to see what changed.",
          shot: {
            width: shot.width,
            height: shot.height,
            nativeWidth: shot.nativeWidth,
            nativeHeight: shot.nativeHeight,
            data: shot.jpegBase64,
          },
        };
      }
      case "click": {
        const button = request.button ?? "left";
        const outcome = await controller.guestCommand(computerUseGuestCommands.click, {
          x: request.x,
          y: request.y,
          button,
          double: request.double === true,
        });
        if (!outcome.ok) return { ok: false, error: outcome.error };
        const kind = `${request.double === true ? "double " : ""}${button} click`;
        return {
          ok: true,
          text:
            `Sent a ${kind} at (${request.x}, ${request.y}) on the sandbox desktop. It has been delivered — ` +
            "take a screenshot to see what it did.",
        };
      }
      case "type": {
        const outcome = await controller.guestCommand(computerUseGuestCommands.type, { text: request.text });
        if (!outcome.ok) return { ok: false, error: outcome.error };
        return {
          ok: true,
          text:
            `Typed ${request.text.length} characters into the focused window on the sandbox desktop. ` +
            "Take a screenshot to confirm they landed where you meant.",
        };
      }
      case "key": {
        const outcome = await controller.guestCommand(computerUseGuestCommands.key, { key: request.key });
        if (!outcome.ok) return { ok: false, error: outcome.error };
        return {
          ok: true,
          text: `Pressed ${request.key} on the sandbox desktop. Take a screenshot to confirm.`,
        };
      }
      case "scroll": {
        const outcome = await controller.guestCommand(computerUseGuestCommands.scroll, {
          x: request.x,
          y: request.y,
          deltaY: request.deltaY,
        });
        if (!outcome.ok) return { ok: false, error: outcome.error };
        return {
          ok: true,
          text:
            `Scrolled by ${request.deltaY} wheel notch(es) at (${request.x}, ${request.y}) on the sandbox desktop ` +
            "(positive = down). Take a screenshot to see the new position.",
        };
      }
    }
  } catch (cause: unknown) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}
