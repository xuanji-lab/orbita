/**
 * 工具审批 —— 走 pi 官方的 `tool_call` 扩展钩子。
 *
 * ⚠ 修正一个我先前的错误判断：我说过「pi 没有审批钩子，所以要把工具的 execute 包一层」。
 * **pi 有**，在扩展 API 里：`pi.on("tool_call", handler)`，handler 返回
 * `{ block?, reason? }` 即可拦截，注释还明写「要改参数就原地改 `event.input`」。
 * 那正好是我们要的三种行为，而且比包装 execute 正确得多——
 * 包装的路子当时还写错了（`createAgentSession` 的 `tools` 是**名字白名单**，
 * 不是工具对象数组，传对象进去等于一个工具都没装上）。
 *
 * 这层因此只剩一件事：把「模式 + 用户回答」翻成 pi 的 ToolCallEventResult。
 */
import { decidePermission, type PermissionAnswer, type PermissionMode } from "../shared/permission.ts";

/**
 * pi 内建、且我们全开的八个工具（guideline §五）。
 * 只有一个用途：**把权限模式讲给模型听**——见 `describePermissionMode`。
 */
const BUILTIN_TOOLS = ["bash", "edit", "find", "glob", "grep", "ls", "read", "write"] as const;

/**
 * 把当前模式翻成一段系统提示。
 *
 * 为什么需要它：审批只拦在 `tool_call` 上，**模型对此一无所知**。实测的表现是——
 * plan 模式下问 agent「能不能改这个文件」，它答「能」，然后真去动工具，撞墙了才发现不能。
 * 它不是在撒谎，是没人告诉过它。
 *
 * 文案**从 `decidePermission` 推出来**，不是另写一遍：三档的工具分桶由策略函数当场算，
 * 策略改了这段话跟着改。两处描述各说各话，比没有描述更糟。
 *
 * @param extraToolNames 内建之外当前真实注册的工具名（1-2 起 MCP 的
 * `mcp__server__tool` 全部由调用方从注册表里拿来传入）——不再只枚举内建八个，
 * 否则 plan 模式下模型不知道 MCP 工具会被拒，照样一头撞墙（已知缺口 #4）。
 * MCP 工具没有「只读」豁免，分桶全由 decidePermission 算，不在提示词里另立规则。
 */
export function describePermissionMode(mode: PermissionMode, extraToolNames: readonly string[] = []): string {
  const allow: string[] = [];
  const ask: string[] = [];
  const deny: string[] = [];
  for (const tool of [...BUILTIN_TOOLS, ...extraToolNames]) {
    const decision = decidePermission(mode, tool);
    if (decision.behavior === "allow") allow.push(tool);
    else if (decision.behavior === "ask") ask.push(tool);
    else deny.push(tool);
  }

  const lines = ["<orbita-permission>", `The user has set tool permission to "${mode}".`];
  if (allow.length > 0) lines.push(`Runs immediately: ${allow.join(", ")}.`);
  if (ask.length > 0) {
    lines.push(
      `Asks the user first: ${ask.join(", ")}. Each call is shown to them before it runs; ` +
        "they may allow it, deny it, or edit the arguments. Expect pauses, and expect denials.",
    );
  }
  if (deny.length > 0) {
    lines.push(
      `Refused outright: ${deny.join(", ")}. Do not call them, and do not tell the user you will ` +
        "change anything on disk — describe the change instead, and say that this mode cannot apply it.",
    );
  }
  lines.push("</orbita-permission>");
  return lines.join("\n");
}

/** pi 的 tool_call 事件里我们用得上的部分 */
export interface ToolCallLike {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** pi 的 tool_call 处理结果 */
export interface ToolCallGateResult {
  block?: boolean;
  reason?: string;
}

export type PermissionAsk = (request: ToolCallLike) => Promise<PermissionAnswer>;

/** pi 扩展 API 里我们用到的两个钩子。上游类型没导出成可直接消费的形状，这里只声明用得着的部分。 */
export interface PiExtensionApi {
  on(
    event: "tool_call",
    handler: (event: ToolCallLike) => ToolCallGateResult | Promise<ToolCallGateResult>,
  ): void;
  on(
    event: "before_agent_start",
    handler: (event: { systemPrompt: string }) => { systemPrompt: string },
  ): void;
}

/**
 * 生成 `tool_call` 处理器。纯逻辑 + 一个注入的询问函数，可被测试穷尽。
 *
 * 改写入参走 pi 的约定：**原地改 `event.input`**（不是返回新对象）。
 */
export function createToolCallGate(getMode: () => PermissionMode, ask: PermissionAsk) {
  return async (event: ToolCallLike): Promise<ToolCallGateResult> => {
    const decision = decidePermission(getMode(), event.toolName);
    if (decision.behavior === "allow") return {};
    if (decision.behavior === "deny") return { block: true, reason: decision.message };

    const answer = await ask(event);
    if (answer.behavior === "deny") {
      return { block: true, reason: answer.message ?? "Denied by the user." };
    }
    if (answer.input !== undefined && typeof answer.input === "object" && answer.input !== null) {
      // pi 的约定：原地修改，后续 handler 与真正的执行都看到改后的值
      for (const key of Object.keys(event.input)) delete event.input[key];
      Object.assign(event.input, answer.input as Record<string, unknown>);
    }
    return {};
  };
}
