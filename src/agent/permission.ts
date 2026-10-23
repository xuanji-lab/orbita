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
  isComputerUseTool,
  isComputerUseWriteTool,
  type PermissionAnswer,
  type PermissionMode,
} from "../shared/permission.ts";
import {
  COMPUTER_USE_DENIED_MESSAGE,
  COMPUTER_USE_REVOKED_MESSAGE,
  countNearbyClicks,
  describeComputerUseRisk,
  judgeComputerUseBudget,
  type ComputerUseRisk,
} from "../shared/computer-guard.ts";
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
  /**
   * 这次问用户的卡是什么性质：`"session"` = 会话授权（「本次会话允许操作沙箱？」），
   * 缺席 / `"call"` = 普通逐次审批或破坏性确认。**由闸门决定，不由 renderer 猜**——
   * 同一张卡上「允许」的含义不同：session 卡的允许是整条会话放行。
   */
  scope?: "call" | "session";
  /** D1/D2/D3 命中的确认信息；卡面必须说清将要发生什么（shared/computer-guard.ts 产） */
  risk?: ComputerUseRisk;
}

/**
 * 电脑使用在闸门里的三个外部事实（runtime 注入；测试直接给假值）。
 * **闸门不认识运行中的轮**——硬限要中断本轮，那是 runtime 的事，所以只能回调。
 */
/**
 * 授权的三态。**「从未问过」与「用户撤回了」必须分开**：manual 档下没授权是常态（每次
 * 问就行），而被撤销（急停 / 点撤销）之后必须直接拒绝——再弹一张卡去点「允许」，撤销就
 * 只是换了个人点而已。
 */
export type ComputerUseGrantState = "none" | "granted" | "denied" | "revoked";

/**
 * 电脑使用在闸门里的几个外部事实（runtime 注入；测试直接给假值）。
 * **闸门不认识运行中的轮**——硬限要中断本轮，那是 runtime 的事，所以只能回调。
 */
export interface ComputerUseGateHooks {
  /** 本会话当前的授权状态（runtime 的跨轮账本字段；进程重启后从 meta 重新播种） */
  grantState: () => ComputerUseGrantState;
  /** 用户点了「本次会话允许」：写账本 + 回主进程落 meta（当前轮立即生效） */
  grant: () => void;
  /**
   * 用户在会话卡上拒绝了：记「本会话不再问」——否则下一次写工具又弹同一张卡，
   * 用户得点三十次拒绝。**不落 meta**（拒绝是本次进程里的决定；重启后重新问一次
   * 是合理的，也很少见）。
   */
  deny: () => void;
  /** 硬限（第 91 次 / 满 20 分钟）：中断本轮。runtime 接 abortCycle + settlePendingPermissions */
  abort: (message: string) => void;
  /** 时钟。缺省 Date.now；测试注入固定值，让 20 分钟边界可测（不 sleep 20 分钟） */
  now?: () => number;
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
  /** 往 pi 本子追加 custom entry（不进 LLM 上下文）：跨轮持久化扩展自己的状态 */
  appendEntry(customType: string, data?: unknown): void;
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
 */
export function createToolCallGate(
  getMode: () => PermissionMode,
  ask: PermissionAsk,
  protectedPaths: readonly string[] = [],
  cwd: string = process.cwd(),
  /**
   * 电脑使用的护栏钩子（computer use PR4）。**不传 = 关闭这一层**（旧测试与
   * 未开实验功能的会话）：闸门行为与 PR3 一字不差。
   *
   * 一轮一份 gate（runtime 的开轮装配），所以下面的计数天然是**按轮重置**的。
   */
  computer?: ComputerUseGateHooks,
) {
  /**
   * 本轮已尝试的 computer_* 次数（预算口径见 shared/computer-guard.ts：截图也计入）。
   * **软限挡下的重试也计数**：那正是硬限要接住的情况（第 91 次中断）。
   */
  let computerCalls = 0;
  /** 本轮第一次 computer_* 的时刻；null = 还没开始（20 分钟从这一步起算，不是从开轮） */
  let computerStartedAt: number | null = null;
  /** 本轮已执行的点击坐标（D3 同点连点判定用；**只在放行之后**记，被挡下的不算） */
  const clicks: { x: number; y: number }[] = [];
  const clock = computer?.now ?? (() => Date.now());
  /** 是不是电脑使用工具组的成员（截图 + 写入四件）：预算按这个口径计 */
  const isComputer = (name: string): boolean => computer !== undefined && isComputerUseTool(name);

  return async (event: ToolCallLike): Promise<ToolCallGateResult> => {
    // **跑在每条早退之前**：放行 / 询问 / 拒绝三条路都不能绕过它，否则默认档（skip 直接
    // 放行）就漏掉了——而那正是模型填小超时的场景。
    raiseCommandTimeout(event.toolName, event.input);
    const refusal = protectedPathRefusal(event.toolName, event.input, protectedPaths, cwd);
    if (refusal !== null) return { block: true, reason: refusal };

    const mode = getMode();
    const decision = decidePermission(mode, event.toolName);
    if (decision.behavior === "deny") return { block: true, reason: decision.message };

    /** 放行前的最后一道：预算。两级都不放行，硬限额外中断本轮 */
    const budgetRefusal = (): ToolCallGateResult | null => {
      if (!isComputer(event.toolName)) return null;
      const now = clock();
      const verdict = judgeComputerUseBudget({
        count: computerCalls,
        startedAt: computerStartedAt,
        now,
      });
      // 每一次尝试都计数（含被软限挡下的重试）：第 91 次要能中断本轮
      computerCalls += 1;
      if (computerStartedAt === null) computerStartedAt = now;
      if (verdict.level === "ok") return null;
      if (verdict.level === "hard") computer?.abort(verdict.message);
      return { block: true, reason: verdict.message };
    };

    /** 真正放行：记点击历史（预算已在 budgetRefusal 里记过），然后交还给 pi */
    const allow = (): ToolCallGateResult => {
      if (isComputer(event.toolName)) {
        if (event.toolName === "computer_click") {
          const x = numberOf(event.input["x"]);
          const y = numberOf(event.input["y"]);
          if (x !== undefined && y !== undefined) clicks.push({ x, y });
        }
      }
      return {};
    };

    // 此前落在同一点的点击数（D3 的当场证据）。坐标不完整 = 0：没有落点就没有连点
    const clickX = numberOf(event.input["x"]);
    const clickY = numberOf(event.input["y"]);
    const risk =
      computer !== undefined && isComputerUseWriteTool(event.toolName)
        ? describeComputerUseRisk({
            tool: event.toolName,
            args: event.input,
            priorSamePointClicks:
              event.toolName === "computer_click" && clickX !== undefined && clickY !== undefined
                ? countNearbyClicks(clicks, clickX, clickY)
                : 0,
          })
        : null;

    /** 拒绝口径：撤销过的一律直接拒（不再弹卡），没授权过的按「用户没同意」 */
    const state = computer?.grantState() ?? "granted";

    // 急停 / 撤销 / 用户拒绝过会话卡之后：本会话后续写工具一律拒绝。**ask 之前判**——
    // 再给用户弹一张卡去点「允许」，撤销就只是换了个人点而已（急停的意义是停下，
    // 不是再问一次）。重新授权走会话头的授权入口（IPC），下一次调用就按 granted 走。
    if (computer !== undefined && isComputerUseWriteTool(event.toolName) && (state === "revoked" || state === "denied")) {
      return {
        block: true,
        reason: state === "denied" ? COMPUTER_USE_DENIED_MESSAGE : COMPUTER_USE_REVOKED_MESSAGE,
      };
    }

    /**
     * 会话授权（skip 档的洞）：默认档是 skip，四件写工具在那里本该零确认直接注入。
     * 第一次调用时问一次「本次会话允许 agent 操作沙箱？」，允许就记在账本 + meta 上；
     * 拒绝则本会话后续写工具一律人话拒绝（截图仍可看——它是只读）。
     *
     * manual 档不弹这张卡：用户已经选择了「每次都要问」，再挂一张「本会话全允许」与
     * 那个选择自相矛盾。plan 档在上面的 deny 就结束了。
     */
    if (computer !== undefined && isComputerUseWriteTool(event.toolName) && mode === "skip" && state !== "granted") {
      const answer = await ask({ ...event, scope: "session", ...(risk === null ? {} : { risk }) });
      if (answer.behavior === "deny") {
        computer.deny();
        return { block: true, reason: COMPUTER_USE_DENIED_MESSAGE };
      }
      // session 卡上已经把这些风险写在正文里了（risk 随卡下发），允许即确认这一次
      computer.grant();
      return budgetRefusal() ?? allow();
    }

    if (decision.behavior === "ask") {
      // manual 档的逐次问：破坏性风险附在同一张卡上，不连弹两次
      const answer = await ask({ ...event, ...(risk === null ? {} : { risk }) });
      if (answer.behavior === "deny") {
        return { block: true, reason: answer.message ?? "Denied by the user." };
      }
      if (answer.input !== undefined && typeof answer.input === "object" && answer.input !== null) {
        // pi 的约定：原地修改，后续 handler 与真正的执行都看到改后的值
        for (const key of Object.keys(event.input)) delete event.input[key];
        Object.assign(event.input, answer.input as Record<string, unknown>);
      }
      return budgetRefusal() ?? allow();
    }

    // 已授权 / 无关工具的破坏性确认：命中就弹，skip 档也弹、已授权也弹
    if (risk !== null) {
      const answer = await ask({ ...event, scope: "call", risk });
      if (answer.behavior === "deny") {
        return { block: true, reason: answer.message ?? "Denied by the user." };
      }
    }

    return budgetRefusal() ?? allow();
  };
}

/** 数字入参：模型偶尔把数字写成字符串（computer-tools.ts 的 numberOf 同口径） */
function numberOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}
