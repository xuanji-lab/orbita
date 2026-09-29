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
import { isAbsolute, relative, resolve } from "node:path";

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
  lines.push(
    "Immutable in every mode: task session files (transcripts and their metadata) can never be " +
      "written by any tool. Do not attempt it, including via shell commands — describe the change " +
      "to the user instead; only the user can modify session data.",
  );
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

/** 拦截面：按路径改文件的（write/edit 的 input.path）与跑命令的（bash/powershell 的 input.command）。 */
const PATH_MUTATING_TOOLS = new Set(["write", "edit"]);
const COMMAND_TOOLS = new Set(["bash", "powershell"]);

/**
 * 路径折叠：Windows 文件系统大小写不敏感，比较前小写化、反斜杠转正斜杠、
 * 收拢连续斜杠（JSON.stringify 会把 `\` 转义成 `\\`，不收拢就对不上）。
 * posix 保持原样——文件系统大小写敏感，不折。
 */
function foldPath(value: string): string {
  if (process.platform !== "win32") return value;
  return value.replaceAll("\\", "/").replace(/\/{2,}/g, "/").toLowerCase();
}

/**
 * 会话文件不可变（2026-09-18 立规）：protectedPaths（sessions/ 与 pi-sessions/）
 * 对工具面**全档只读**——这条检查在权限档判定**之前**跑，Skip 也抬不掉。
 *
 * 拦截力度如实说：write / edit 是**路径精确拦**（resolve 后判前缀）；bash /
 * powershell 是**命令字面量拦**（受保护路径出现在命令串里就拒）——拦得住常规
 * 引用，拦不住刻意混淆（变量间接、编码变换）。对「防误伤、防顺手」足够；
 * 对蓄意对抗不是防线，那是 OS 级沙箱的活。MCP server 是用户显式安装的
 * 可信组件，不在本闸管辖内。读不受限——「只能读」正是这里要保的状态。
 *
 * 命中返回讲给模型听的拒绝理由（改道指引），没命中返回 null。
 */
export function protectedPathRefusal(
  toolName: string,
  input: Record<string, unknown>,
  protectedPaths: readonly string[],
  cwd: string,
): string | null {
  if (protectedPaths.length === 0) return null;

  if (PATH_MUTATING_TOOLS.has(toolName)) {
    const target = input["path"];
    if (typeof target !== "string" || target === "") return null;
    const resolved = foldPath(resolve(cwd, target));
    for (const dir of protectedPaths) {
      const base = foldPath(resolve(dir));
      const rel = relative(base, resolved);
      if (!rel.startsWith("..") && !isAbsolute(rel)) {
        return refusalMessage(dir, "path");
      }
    }
    return null;
  }

  if (COMMAND_TOOLS.has(toolName)) {
    const command = input["command"];
    if (typeof command !== "string" || command === "") return null;
    const haystack = foldPath(command);
    for (const dir of protectedPaths) {
      const needle = foldPath(dir);
      // 命中必须落在路径边界上：`.../sessions` 后面跟分隔符/引号/空白/结尾才算，
      // `.../sessions-extra` 这种相邻前缀是另一个目录，不拦
      let index = haystack.indexOf(needle);
      while (index !== -1) {
        const next = haystack[index + needle.length];
        if (next === undefined || !/[a-z0-9_-]/i.test(next)) return refusalMessage(dir, "command");
        index = haystack.indexOf(needle, index + 1);
      }
    }
    return null;
  }

  return null;
}

/**
 * 拒绝理由分两种讲法。命令串拦是字面量拦，分不出读写——`ls` 一个会话目录也会撞上。
 * 只说「不能写」模型会以为自己在写，原地重试或卡住（实测）；所以命令这一支要
 * 直说「命令里不能出现这个目录，读请换 ls / read / find / grep 工具或 read_task」，
 * 让它第一次撞墙就知道往哪绕。保护强度不变。
 */
function refusalMessage(dir: string, via: "path" | "command"): string {
  const lead =
    via === "command"
      ? `Session records are immutable: "${dir}" is protected, and shell commands may not reference it ` +
        "in any permission mode — even read-only ones, because the check cannot tell reading from writing. "
      : `Session records are immutable: "${dir}" is protected — no tool may write there in any permission mode. `;
  return (
    lead +
    "To read it, use the ls / read / find / grep tools (not the shell), or read_task for a task's transcript. " +
    "To change it, describe the change to the user instead; only the user can modify session data."
  );
}

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
 * 会话文件不可变（2026-09-18）：protectedPaths 缺席（旧测试、或主进程没给）=
 * 不做禁区检查；给了就在权限档判定**之前**拦——Skip 档也拦。
 *
 * 改写入参走 pi 的约定：**原地改 `event.input`**（不是返回新对象）。
 */
export function createToolCallGate(
  getMode: () => PermissionMode,
  ask: PermissionAsk,
  protectedPaths: readonly string[] = [],
  cwd: string = process.cwd(),
) {
  return async (event: ToolCallLike): Promise<ToolCallGateResult> => {
    const refusal = protectedPathRefusal(event.toolName, event.input, protectedPaths, cwd);
    if (refusal !== null) return { block: true, reason: refusal };
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
