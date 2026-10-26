/**
 * computer use 的安全护栏 —— 纯策略，无 IO，主进程 / agent 进程 / renderer 共用。
 *
 * 位置与 `permission.ts` 同层（契约层）。这一层只回答三个问题，不执行任何动作：
 *
 *   1. **这一步要不要额外确认**（D1 组合键黑名单 / D2 破坏词 / D3 同点连点）——
 *      `describeComputerUseRisk`。命中是「弹确认卡」，**不是拒绝**：用户点头后照常执行。
 *   2. **本轮的预算还剩多少**（60 次软限 / 90 次或 20 分钟硬限）——
 *      `judgeComputerUseBudget`。两级行为不同：软限返回人话错误让模型收尾，硬限中断本轮。
 *   3. **授权被撤销后回给模型什么话** —— `COMPUTER_USE_REVOKED_MESSAGE`（唯一一份文案）。
 *
 * 诚实的边界（别把这一层当防恶意）：像素与输入流能拿到的只有动作字段与一张截图。
 * 「这个按钮是删除还是下一步」不可知——点击语义、表单提交、提示注入、焦点漂移都拦不住
 * （完整清单在 `docs/architecture` 之外的调研里，不进仓；这里只留下能力边界这一段）。
 * 这一层是**防失控**：防模型按住 alt+f4 关窗、防它往命令行里打 format、防它对着一个
 * 坐标点二十次。真正的兜底是沙箱一次性 + 销毁即撤销。
 */

// ── D1 组合键黑名单 ───────────────────────────────────────────────────

/**
 * 危险的组合键（归一化后比较：小写、按 `+` 拆开、排序、重拼）。
 *
 * 为什么这些要单独确认：
 *   - `alt+f4` / `ctrl+w` / `ctrl+shift+w`：关窗口 / 关标签页，未保存的表单与页面当下就没了；
 *   - `alt+tab` / `win+d`：切走 / 最小化全部——agent 下一步的点击会落在它没看见的窗口上
 *     （沙箱里没有别的应用，但 Explorer / 对话框会被藏起来，模型自己也会失去方向）；
 *   - `win+l`：锁屏。沙箱里会直接锁住会话，模型无法解锁，整轮报废；
 *   - `win+r`：运行框。真机已知在这个沙箱镜像里输入不进去（computer-tools.ts 的注释），
 *     但仍要挡——它是「执行任意命令」的入口，而这里只能看见「它按了 win+r」，看不见
 *     用户是否知道；
 *   - `ctrl+shift+esc`：任务管理器。能结束沙箱里的进程，属于「用户没让它做的事」；
 *   - `ctrl+alt+delete`：Windows 保留组合，guest 桥本来就注入不了；列在这里是明确
 *     「别指望它」，免得模型反复重试；
 *   - `shift+delete`：永久删除（绕过回收站）。
 *
 * 顺序无关：`ctrl+shift+esc` 与 `shift+ctrl+esc` 是同一个东西，归一化后命中同一项。
 */
export const COMPUTER_USE_DANGEROUS_KEYS = [
  "alt+f4",
  "ctrl+w",
  "ctrl+shift+w",
  "alt+tab",
  "win+d",
  "win+l",
  "win+r",
  "ctrl+shift+esc",
  "ctrl+alt+delete",
  "shift+delete",
] as const;

/** 键名的归一化：小写、去空白、按 `+` 拆开排序后重拼。空串原样返回。 */
export function normalizeComputerKey(key: string): string {
  const parts = key
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  // 单键（enter / escape）保持原样；组合键排序，使 ctrl+shift+esc 与 shift+ctrl+esc 等价
  if (parts.length <= 1) return parts.join("+");
  return [...parts].sort().join("+");
}

function dangerousKey(key: string): string | null {
  const normalized = normalizeComputerKey(key);
  const hit = DANGEROUS_KEY_SET.has(normalized);
  return hit ? normalized : null;
}

/** 黑名单两侧都过归一化：表里写 `ctrl+shift+esc`，命中时拿到的是排序后的 `ctrl+esc+shift` */
const DANGEROUS_KEY_SET: ReadonlySet<string> = new Set(
  COMPUTER_USE_DANGEROUS_KEYS.map((key) => normalizeComputerKey(key)),
);

// ── D2 破坏词 ─────────────────────────────────────────────────────────

/**
 * 命令行破坏动作（`computer_type` 的文本）。**匹配的是「打进去的字」**，不是执行结果——
 * 沙箱里模型常打开 cmd 做事，这些词一旦出现在输入里就值得让用户看一眼。
 *
 * 每条都写清它拦的是什么：
 *   - `format c:` —— 格式化分区；
 *   - `diskpart` / `cipher /w` —— 分区 / 擦盘；
 *   - `shutdown /s` `/r` —— 关机 / 重启（沙箱会连带退出，这一轮全废）；
 *   - `del /f|/s|/q`、`rmdir /s`、`rd /s` —— 批量删除；
 *   - `Remove-Item -Recurse`（PowerShell）—— 递归删除；
 *   - `reg delete` —— 删注册表键；
 *   - `net user X /delete` —— 删账户；
 *   - `taskkill /f` —— 强杀进程。
 *
 * 不追求覆盖率：漏掉的词由「授权 + 沙箱一次性 + 事后截图」兜底。**误报可接受**——
 * 用户看一眼点「允许」的成本，远低于一次真的 format。
 */
const DESTRUCTIVE_TEXT_PATTERNS: readonly { pattern: RegExp; detail: string }[] = [
  { pattern: /\bformat\s+[a-z]:/i, detail: "format <drive>:" },
  { pattern: /\bdiskpart\b/i, detail: "diskpart" },
  { pattern: /\bshutdown\s+\/[sr]\b/i, detail: "shutdown /s|/r" },
  { pattern: /\bdel\s+(?:\/[a-z]\s*)+/i, detail: "del /f|/s|/q" },
  { pattern: /\b(?:rmdir|rd)\s+\/s\b/i, detail: "rmdir /s" },
  { pattern: /\bremove-item\b[^\n]*-recurse\b/i, detail: "Remove-Item -Recurse" },
  { pattern: /\bcipher\s+\/w\b/i, detail: "cipher /w" },
  { pattern: /\breg\s+delete\b/i, detail: "reg delete" },
  { pattern: /\bnet\s+user\s+\S+\s+\/delete\b/i, detail: "net user /delete" },
  { pattern: /\btaskkill\b[^\n]*\/f\b/i, detail: "taskkill /f" },
];

function destructiveText(text: string): string | null {
  for (const entry of DESTRUCTIVE_TEXT_PATTERNS) {
    if (entry.pattern.test(text)) return entry.detail;
  }
  return null;
}

// ── D3 同点连点 ───────────────────────────────────────────────────────

/** 两点距离 ≤ 它就算「同一个地方」（模型手抖 / 缩放误差都在这个量级内） */
export const COMPUTER_USE_REPEAT_RADIUS_PX = 4;
/** 同一轮里同一点的第几次起要确认（第 5 次） */
export const COMPUTER_USE_REPEAT_LIMIT = 5;

/** 这一轮此前落在 (x, y) 附近（≤半径）的点击数。闸门每轮持有一份点击历史，调它计数。 */
export function countNearbyClicks(
  clicks: readonly { x: number; y: number }[],
  x: number,
  y: number,
  radius: number = COMPUTER_USE_REPEAT_RADIUS_PX,
): number {
  let count = 0;
  for (const click of clicks) {
    if (Math.abs(click.x - x) <= radius && Math.abs(click.y - y) <= radius) count += 1;
  }
  return count;
}

// ── 三条规则的统一入口 ────────────────────────────────────────────────

export type ComputerUseRiskRule = "key" | "command" | "repeat";

export interface ComputerUseRiskInput {
  /** 工具名（computer_key / computer_type / computer_click） */
  tool: string;
  /** 工具的入参（pi 原样给的那份） */
  args: Record<string, unknown>;
  /**
   * D3 的当场证据：**本轮此前**落在同一坐标（≤4px）的点击数，由闸门维护。
   * 不给 = 0（单次调用无从判断连点）。
   */
  priorSamePointClicks?: number;
}

export interface ComputerUseRisk {
  /** 目前只有「确认」一种：命中不是拒绝，是让用户点头 */
  level: "confirm";
  rule: ComputerUseRiskRule;
  /** 命中的具体东西（归一化组合键 / 破坏词 / 连点次数），renderer 用它拼本地化文案 */
  detail: string;
  /** 给模型与日志的一句话（英文）——工具被用户拒绝时它会作为失败原因回灌 */
  message: string;
}

/**
 * 判定一次 computer_* 调用有没有值得单独确认的东西。**纯函数**：同一份入参永远同一结论。
 *
 * 返回 null = 没有可判定的风险（safe）。返回对象 = 弹确认卡；用户允许后照常执行。
 * 只认三个工具：click（D3）/ key（D1）/ type（D2）；其余（screenshot / scroll）恒定 null。
 */
export function describeComputerUseRisk(input: ComputerUseRiskInput): ComputerUseRisk | null {
  if (input.tool === "computer_key") {
    const key = input.args["key"];
    if (typeof key === "string") {
      const hit = dangerousKey(key);
      if (hit !== null) {
        return {
          level: "confirm",
          rule: "key",
          detail: hit,
          message:
            `computer_key is about to send "${hit}", which closes or locks windows, opens the Run box, ` +
            "or kills processes. Confirm this with the user before it runs.",
        };
      }
    }
    return null;
  }

  if (input.tool === "computer_type") {
    const text = input.args["text"];
    if (typeof text !== "string") return null;
    const hit = destructiveText(text);
    if (hit === null) return null;
    return {
      level: "confirm",
      rule: "command",
      detail: hit,
      message:
        `computer_type is about to type a destructive command (${hit}). Confirm this with the user before it runs.`,
    };
  }

  if (input.tool === "computer_click") {
    const prior = input.priorSamePointClicks ?? 0;
    // 第 N 次起确认：此前已有 LIMIT-1 次，加上这一次正好第 LIMIT 次
    if (prior + 1 < COMPUTER_USE_REPEAT_LIMIT) return null;
    return {
      level: "confirm",
      rule: "repeat",
      detail: String(prior + 1),
      message:
        `computer_click is about to click the same spot (within ${COMPUTER_USE_REPEAT_RADIUS_PX}px) for the ` +
        `${prior + 1}. time in this turn. It may be stuck in a loop — take a screenshot and check what is on ` +
        "screen before clicking again.",
    };
  }

  return null;
}

// ── 预算（按轮重置）───────────────────────────────────────────────────

/**
 * 软限：**本轮第 61 次** computer_* 起返回人话错误（工具失败、轮次不中断），
 * 让模型自己收尾。60 张 1280 宽截图的上下文成本已经是「一轮该收工」的量级。
 */
export const COMPUTER_USE_SOFT_LIMIT = 60;
/**
 * 硬限：**本轮第 91 次**（或从第一次 computer_* 起满 20 分钟）中断本轮。
 * 软限给模型 30 次收尾机会；还不收就是失控，用户不该再等它。
 */
export const COMPUTER_USE_HARD_LIMIT = 90;
/** 单轮时长硬限：从本轮**第一次** computer_* 调用起算（不是开轮时刻——开轮可能先读了半小时文件） */
export const COMPUTER_USE_TURN_DEADLINE_MS = 20 * 60_000;

export interface ComputerUseBudgetState {
  /**
   * 本轮**已经尝试过**的 computer_* 次数（不含当前这一次；当前这一次是 count + 1）。
   *
   * **被软限挡下的重试也计数**——这是硬限存在的意义：软限给模型 30 次收尾机会，
   * 它要是还在一遍遍重试，第 91 次就中断本轮。不计数的话 count 停在 60，硬限永远
   * 到不了，模型可以无限刷软限错误。
   */
  count: number;
  /** 本轮第一次 computer_* 的时刻（毫秒）；null = 还没开始 */
  startedAt: number | null;
  /** 当前时刻（毫秒）。显式传入而不是读 Date.now()——纯函数才可测 */
  now: number;
}

export type ComputerUseBudgetVerdict =
  | { level: "ok" }
  | { level: "soft"; message: string }
  | { level: "hard"; reason: "count" | "time"; message: string };

/**
 * 判定当前这一次调用还能不能放行。`count` 是**已经执行**的次数，所以当前这次是
 * 第 `count + 1` 次。
 *
 * 顺序上先判时长再判次数：两条都超时，原因按「时长」报——用户更可能是在问
 * 「它跑了多久」。两级文案都写给模型看（它会转告用户），不弹 UI。
 */
export function judgeComputerUseBudget(state: ComputerUseBudgetState): ComputerUseBudgetVerdict {
  if (state.startedAt !== null && state.now - state.startedAt >= COMPUTER_USE_TURN_DEADLINE_MS) {
    return {
      level: "hard",
      reason: "time",
      message:
        "Computer use has been running for 20 minutes in this turn, which is the hard limit. " +
        "Summarize what you did, what is still left and what the user should check, then stop. " +
        "The user can send another message to continue with a fresh budget.",
    };
  }

  const attempt = state.count + 1;
  if (attempt > COMPUTER_USE_HARD_LIMIT) {
    return {
      level: "hard",
      reason: "count",
      message:
        `Computer use hit its hard limit of ${COMPUTER_USE_HARD_LIMIT} actions in one turn, so this turn was ` +
        "interrupted. Summarize what you did, what is still left and what the user should check, then stop. " +
        "The user can send another message to continue with a fresh budget.",
    };
  }

  if (attempt > COMPUTER_USE_SOFT_LIMIT) {
    return {
      level: "soft",
      message:
        `Computer use used up its ${COMPUTER_USE_SOFT_LIMIT}-action budget for this turn. Do not call ` +
        "computer_* again: summarize what you did, what is still left and what the user should check, then " +
        "stop. The user can send another message to continue with a fresh budget.",
    };
  }

  return { level: "ok" };
}

/** 预算与授权都不通过时回给模型的拒绝语（唯一一份，gate 与测试同源） */
export const COMPUTER_USE_REVOKED_MESSAGE =
  "Computer use is not authorized in this session: the user revoked it (or pressed the emergency stop). " +
  "Do not call computer_* tools again here — summarize what you did and stop. The user can re-authorize " +
  "computer use from the chat header.";

/** 用户拒绝了会话授权时回给模型的话 */
export const COMPUTER_USE_DENIED_MESSAGE =
  "The user did not authorize computer use in this session, so computer_* tools cannot run. " +
  "Describe what you would do instead, or ask them to enable it; do not retry the call.";
