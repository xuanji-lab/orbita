/**
 * 工具权限策略 —— 三档模式的唯一定义（契约层，主进程与 renderer 共用）。
 *
 * pi **没有**审批钩子：它拿到工具定义就直接调 `execute`。所以「执行前先请示」这件事
 * 完全是我们的——做法是把工具定义包一层（见 `src/agent/permission.ts`）。
 * 这层的好处是三档模式只是同一个包装的三种返回策略，不需要动 pi 的任何东西。
 */
export const PERMISSION_MODES = ["plan", "manual", "skip"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const PERMISSION_MODE_LABELS: Record<PermissionMode, { label: string; hint: string }> = {
  plan: { label: "Plan", hint: "Read-only. Writing and shell are refused." },
  manual: { label: "Manual", hint: "Ask before every tool call." },
  skip: { label: "Skip", hint: "Run every tool without asking." },
};

/**
 * 不改变任何东西的工具：pi 内建五个。其余（write / edit / bash…）一律视为有副作用。
 */
export const READ_ONLY_TOOLS = ["read", "grep", "glob", "ls", "find"] as const;

/**
 * 跨会话读取（2026-09-18 立规，改写同日 grill 的 Q4 裁决）：读**别的 task** 的数据。
 * read_task 恒属此类；原始 read/grep 等翻进会话账本目录的，由闸门按输入路径判定
 * （在 agent 侧，shared 只认工具名）。
 *
 * 政策：plan / manual 档**弹审批**——跨会话读是唯一「把别处的数据拉进本会话
 * 上下文」的动作（此后随本会话发给模型商、进导出与压缩摘要），值一次点击，
 * 审批条上看得见要读哪条；skip 档照放（skip 的字面语义就是全信任）。
 */
export const CROSS_SESSION_READ_TOOLS = ["read_task"] as const;

export function isCrossSessionReadTool(toolName: string): boolean {
  return (CROSS_SESSION_READ_TOOLS as readonly string[]).includes(toolName);
}

export function isReadOnlyTool(toolName: string): boolean {
  return (READ_ONLY_TOOLS as readonly string[]).includes(toolName);
}

export type PermissionDecision =
  | { behavior: "allow" }
  /** 需要问用户；调用方负责把问题送到 UI 并等回答 */
  | { behavior: "ask" }
  | { behavior: "deny"; message: string };

/**
 * 纯策略：只看模式与工具名。**不做 IO、不认识 UI**——所以它可以被穷尽测试，
 * 也保证「plan 模式下 bash 绝不可能被执行」这类判断有唯一出处。
 */
export function decidePermission(mode: PermissionMode, toolName: string): PermissionDecision {
  if (mode === "skip") return { behavior: "allow" };
  // 跨会话读优先于只读桶：它在 plan 档也要过一次审批（政策见 CROSS_SESSION_READ_TOOLS）
  if (isCrossSessionReadTool(toolName)) return { behavior: "ask" };
  if (isReadOnlyTool(toolName)) {
    // plan 下只读工具静默放行；manual 下用户要求「全都问」，只读也问
    return mode === "plan" ? { behavior: "allow" } : { behavior: "ask" };
  }
  if (mode === "plan") {
    return {
      behavior: "deny",
      // 这句话会作为工具失败原因回灌给模型，让它改用只读方式继续，而不是反复重试
      message: `Plan mode is on: ${toolName} is not available. Describe the change instead of making it.`,
    };
  }
  return { behavior: "ask" };
}

/** 用户对一次询问的回答。改写入参是刻意保留的能力（把 rm -rf 改成别的路径再放行）。 */
export type PermissionAnswer =
  | { behavior: "allow"; input?: unknown }
  | { behavior: "deny"; message?: string };
