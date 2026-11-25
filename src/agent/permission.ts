/**
 * 工具调用闸门 —— 走 pi 官方的 `tool_call` 扩展钩子。
 *
 * 2026-11-16 用户定「只留放行」：没有权限档、没有审批卡。这里只剩两件与档位无关的事：
 * 抬命令超时、拦受保护路径（会话记录与 pi 会话库）。两件都不问人。
 */
import { gatedCommandTimeout } from "../shared/permission.ts";
import { isAbsolute, relative, resolve } from "node:path";
import type { ContextMessage } from "./image-byte-budget.ts";

/**
 * **本会话实际启用的 pi 内建工具集**：`runtime.ts` 开轮时经
 * `settingsManager.applyOverrides({ defaultTools })` 交给 pi，决定内建工具的初始选择。
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
 * 讲给模型听的受保护数据说明（系统提示的 `orbita-permission` 段）。
 * 档位删了，只剩「哪些东西任何工具都改不了」；不虚构现内核没有的保护面。
 */
export function describeProtectedData(): string {
  return [
    "<orbita-permission>",
    "Immutable: task session files (transcripts and their metadata) can never be written by any tool. " +
      "Do not attempt it, including via shell commands — describe the change to the user instead; " +
      "only the user can modify session data.",
    "</orbita-permission>",
  ].join("\n");
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

/** 拦截面：按路径改文件的（write/edit 的 input.path）与跑命令的（bash/powershell 的 input.command）。 */
const PATH_MUTATING_TOOLS = new Set(["write", "edit"]);
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
 * **填了只升不降**：填得比下限大（900s）是模型自己的判断，尊重它。非法值
 * （≤ 0 / 非有限数）不在这里修——pi 自己会报「Invalid timeout」，我们不替它做第二套校验。
 *
 * **不填补默认上限**（2026-10-30 起，`COMMAND_TIMEOUT_DEFAULT_SECONDS` = 1 小时）：以前
 * 不填就不设超时，命令自己卡死时整轮永远挂着；到点 pi 杀整棵进程树、把输出交回模型。
 * 整条规则在 shared 的 `gatedCommandTimeout`，这里只管「哪些工具」与「原地改」。
 *
 * 常量本体在 shared/permission.ts（闸门与 renderer 的「上限」显示同源：闸门改的是
 * clone、不回写入参，显示若不套同一条规则，模型填 60 时界面说「上限 1:00」、
 * 实际跑在 10 分钟上）。提示词那段话也引它：同一个数有两处真源的话，改了常量提示词还说着旧数。
 */

/** 原地抬 `event.input.timeout`（pi 的约定，与下面的改写入参同一套）。闸门内部用，行为经 `createToolCallGate` 测。 */
function raiseCommandTimeout(toolName: string, input: Record<string, unknown>): void {
  if (!COMMAND_TOOLS.has(toolName)) return;
  const raw = input["timeout"];
  const gated = gatedCommandTimeout(raw);
  // 值没变不写：非法值原样留给 pi 报错，NaN 也不被「重写成自己」
  if (!Object.is(gated, raw)) input["timeout"] = gated;
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
 * 对工具面**只读**——任何工具都写不了。
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
        "at all — even read-only ones, because the check cannot tell reading from writing. "
      : `Session records are immutable: "${dir}" is protected — no tool may write there. `;
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
  /** 往 pi 本子追加 custom entry（不进 LLM 上下文）：跨轮持久化扩展自己的状态 */
  appendEntry(customType: string, data?: unknown): void;
}

/** context 事件里的消息形状（AgentMessage 的结构化子集），image-byte-budget 定义 */
export type ContextBudgetMessage = ContextMessage;

/**
 * 生成 `tool_call` 处理器。纯逻辑，可被测试穷尽。
 *
 * protectedPaths 缺席（旧测试、或主进程没给）= 不做禁区检查。
 * 抬超时按 pi 的约定原地改 `event.input`，跑在受保护路径判定之前。
 */
export function createToolCallGate(
  protectedPaths: readonly string[] = [],
  cwd: string = process.cwd(),
) {
  return (event: ToolCallLike): ToolCallGateResult => {
    raiseCommandTimeout(event.toolName, event.input);
    const refusal = protectedPathRefusal(event.toolName, event.input, protectedPaths, cwd);
    return refusal === null ? {} : { block: true, reason: refusal };
  };
}
