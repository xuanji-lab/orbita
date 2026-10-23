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
import {
  decidePermission,
  COMMAND_TIMEOUT_FLOOR_SECONDS,
  type PermissionAnswer,
  type PermissionMode,
} from "../shared/permission.ts";
import { isAbsolute, relative, resolve } from "node:path";
import type { ContextMessage } from "./image-byte-budget.ts";

/**
 * **本会话实际启用的 pi 内建工具集**。真源一份、两个消费者：
 *
 *   1. `runtime.ts` 开轮时经 `settingsManager.applyOverrides({ defaultTools })` 交给 pi，
 *      决定本会话**内建工具的初始选择**（不是 `tools` 白名单——那个是全局的，会连自定义
 *      工具一起过滤掉，实测见 runtime.ts 那段注释）；
 *   2. `describePermissionMode` 把「哪些工具会放行 / 询问 / 拒绝」讲给模型听（见下）。
 *
 * 两者**必须同一份**：分开写就会漂——这份名单以前带着一个 pi 根本没有的 `glob`，
 * 于是提示词常年在告诉模型一个不存在的工具（2026-10-04 查证：pi 0.84.3 的
 * `createAllToolDefinitions` 只有 read / bash / powershell / edit / write / grep / find / ls）。
 *
 * **为什么搜索类工具必须在里面**：pi 的默认集是 `["read","bash","edit","write"]`，而 pi 的
 * system prompt 里有一条规则——**当工具集里有 bash、却一个 grep / find / ls 都没有的时候**，
 * 它给模型下一句 "Use bash for file operations like ls, rg, find"（0.84.3 与上游 1.0.0 同构，
 * 条件写死在 system-prompt 里）。于是搜索全走 shell：真实会话 33,201 次 bash 调用里
 * **52.4% 是搜索类命令**；而 `grep -rn X .` 会递归进 node_modules（本仓 34,337 个文件里
 * 30,997 个是它），实测 **5.57s** —— pi 自带的 grep 走 ripgrep、尊重 .gitignore，
 * 同一个任务 **0.08s**。
 *
 * 把这三个补进来**同时做两件事**：搜索改走 ripgrep / fd；并且上面那条把模型推向 bash 的
 * 规则的**触发条件不再成立**，那句话自动消失。这比「在提示词里劝模型别用 bash 搜索」硬：
 * 我们只能往 pi 的 system prompt 后面**追加**，删不掉它写的那句，劝也劝不过
 * （模型自填 timeout 那件事已经证明：提示词管不住模型）。
 *
 * 顺序只影响提示词里工具清单的先后（pi 拿它当「内建工具的初始选择」，顺序无功能含义），
 * 保持按名字排列。
 */
export const ENABLED_BUILTIN_TOOLS = ["bash", "edit", "find", "grep", "ls", "read", "write"] as const;

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
 * 枚举的是 `ENABLED_BUILTIN_TOOLS`——**真的启用了哪些**，不是「pi 有哪些」。
 *
 * @param extraToolNames 内建之外当前真实注册的工具名（1-2 起 MCP 的
 * `mcp__server__tool` 全部由调用方从注册表里拿来传入）——不再只枚举内建的那几个，
 * 否则 plan 模式下模型不知道 MCP 工具会被拒，照样一头撞墙（已知缺口 #4）。
 * MCP 工具没有「只读」豁免，分桶全由 decidePermission 算，不在提示词里另立规则。
 */
export function describePermissionMode(mode: PermissionMode, extraToolNames: readonly string[] = []): string {
  const allow: string[] = [];
  const ask: string[] = [];
  const deny: string[] = [];
  for (const tool of [...ENABLED_BUILTIN_TOOLS, ...extraToolNames]) {
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

/**
 * 拦截面：按路径改文件的（write/edit 的 input.path）与跑命令的（bash/powershell 的 input.command）。
 *
 * `PATH_MUTATING_TOOLS` 导出是因为 read-guard（read-before-write 守卫）问的是同一个问题
 * ——「这个工具在按路径改文件吗」——两处各写一份就会漂（漂了的后果是守卫少盖一个工具）。
 */
export const PATH_MUTATING_TOOLS = new Set(["write", "edit"]);
const COMMAND_TOOLS = new Set(["bash", "powershell"]);

/**
 * 模型自填的命令超时**下限**（秒）：低于它的 `timeout` 抬到它，不填就不动。
 *
 * pi 的 bash 工具**没有系统超时**（`MAX_TIMEOUT_SECONDS` 是 2147483.647 秒，约 24 天），
 * 唯一的秒表就是 schema 里那个可选 `timeout` 参数——**由模型自己填**。它会填一个保守的
 * 小值（2026-10-01 统计全部会话：60s ×128、30s ×27、10s ×12；2026-10-04 复查，填过的共
 * 1,812 次），于是慢命令被自己的秒表拦腰砍掉：全仓 grep、依赖安装、构建、测试在 Windows 上
 * 本来就慢。**代价不是「命令失败」，是白等一分钟再重试**——进程重开、环境重热、从头再跑。
 * 系统提示词里那句「不要传 timeout」拦不住，所以这里兜底。
 *
 * **只升不降**：不填 = 不设超时，那是**最宽**的选择，抬它反而变窄；填得比下限大
 * （900s）是模型自己的判断，尊重它。非法值（≤ 0 / 非有限数）不在这里修——
 * pi 自己会报「Invalid timeout」，我们不替它做第二套校验。
 *
 * 常量本体在 shared/permission.ts（闸门与 renderer 的「上限」显示同源：闸门改的是
 * clone、不回写入参，显示若不套同一条规则，模型填 60 时界面说「上限 1:00」、
 * 实际跑在 10 分钟上）。提示词那段话也引它：同一个数有两处真源的话，改了常量提示词还说着旧数。
 */

/** 原地抬 `event.input.timeout`（pi 的约定，与下面的改写入参同一套）。闸门内部用，行为经 `createToolCallGate` 测。 */
function raiseCommandTimeout(toolName: string, input: Record<string, unknown>): void {
  if (!COMMAND_TOOLS.has(toolName)) return;
  const timeout = input["timeout"];
  if (typeof timeout !== "number" || !Number.isFinite(timeout)) return;
  if (timeout > 0 && timeout < COMMAND_TIMEOUT_FLOOR_SECONDS) {
    input["timeout"] = COMMAND_TIMEOUT_FLOOR_SECONDS;
  }
}

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

/** pi 扩展 API 里我们用到的钩子。上游类型没导出成可直接消费的形状，这里只声明用得着的部分。 */
export interface PiExtensionApi {
  on(
    event: "tool_call",
    handler: (event: ToolCallLike) => ToolCallGateResult | Promise<ToolCallGateResult>,
  ): void;
  on(
    event: "before_agent_start",
    handler: (event: { systemPrompt: string }) => { systemPrompt: string } | void,
  ): void;
  /** 返回非 undefined 的值替换请求 payload（cc-billing-patch 用）；上游契约 BeforeProviderRequestEventResult = unknown */
  on(
    event: "before_provider_request",
    handler: (event: { payload: unknown }) => unknown,
  ): void;
  /** 每次 LLM 调用前触发（transformContext）：返回 { messages } 替换发往 provider 的那份，
   * 不写回 pi 本子（image-byte-budget 的 wire-only 替换用它）。上游契约 ContextEvent */
  on(
    event: "context",
    handler: (
      event: { type: "context"; messages: ContextBudgetMessage[] },
    ) => { messages: ContextBudgetMessage[] } | undefined | void,
  ): void;
  /**
   * 工具执行落定（工具已经跑完，可改结果）。这里只用它记账：成功的 read / write / edit
   * 把路径记进已读账本（read-guard.ts）。返回 void = 不改结果。
   */
  on(
    event: "tool_result",
    handler: (event: ToolResultLike) => void | Promise<void>,
  ): void;
  /** 往 pi 本子追加 custom entry（不进 LLM 上下文）：跨轮持久化扩展自己的状态 */
  appendEntry(customType: string, data?: unknown): void;
}

/** pi 的 tool_result 事件里我们用得上的部分（上游另带 content / details / usage，用不着） */
export interface ToolResultLike {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  isError: boolean;
}

/** context 事件里的消息形状（AgentMessage 的结构化子集），image-byte-budget 定义 */
export type ContextBudgetMessage = ContextMessage;

/**
 * 生成 `tool_call` 处理器。纯逻辑 + 一个注入的询问函数，可被测试穷尽。
 *
 * 会话文件不可变（2026-09-18）：protectedPaths 缺席（旧测试、或主进程没给）=
 * 不做禁区检查；给了就在权限档判定**之前**拦——Skip 档也拦。
 *
 * 改写入参走 pi 的约定：**原地改 `event.input`**（不是返回新对象）。
 *
 * 顺序上讲一句：参数兜底（`raiseCommandTimeout`）跑在**所有早退之前**，而用户在审批卡片里
 * 改的入参跑在**最后**——两条都是原地改，含义不同：兜底是防模型失手，人工明确填的秒表
 * 是当事人自己的选择，不以兜底覆盖它。
 *
 * `readGuard`（read-before-write，read-guard.ts）的位置也是刻意的：**在否决判定之后、
 * 问用户之前**。放在否决之前的话，plan 档下模型收到的是「先去读」而不是「这个档不能改」
 * ——信息更差、还多一次无谓的读；放在问用户之后的话，用户点了允许才被告知这次要拦，
 * 白点一次。用户如果在审批卡片里把路径改成了另一个没读过的文件，这里**不再复查**：
 * 那是当事人当场的明确选择（与 protectedPaths 同一取舍），仓库里现有闸门都这一套。
 */
export function createToolCallGate(
  getMode: () => PermissionMode,
  ask: PermissionAsk,
  protectedPaths: readonly string[] = [],
  cwd: string = process.cwd(),
  readGuard?: (event: ToolCallLike) => string | null,
) {
  return async (event: ToolCallLike): Promise<ToolCallGateResult> => {
    // **跑在每条早退之前**：放行 / 询问 / 拒绝三条路都不能绕过它，否则默认档（skip 直接
    // 放行）就漏掉了——而那正是模型填小超时的场景。
    raiseCommandTimeout(event.toolName, event.input);
    const refusal = protectedPathRefusal(event.toolName, event.input, protectedPaths, cwd);
    if (refusal !== null) return { block: true, reason: refusal };
    const decision = decidePermission(getMode(), event.toolName);
    if (decision.behavior === "deny") return { block: true, reason: decision.message };
    const guardRefusal = readGuard?.(event) ?? null;
    if (guardRefusal !== null) return { block: true, reason: guardRefusal };
    if (decision.behavior === "allow") return {};

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
