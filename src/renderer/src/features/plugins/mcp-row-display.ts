/**
 * MCP 详情「状态」一节的派生（纯函数，与 mcp-tool-chips.ts 同一条纪律：算与渲染分开）。
 *
 * 分片之后一行背后可能是几个工作区实例。头行图标与状态行都由这份汇总派生——
 * 不让「一个实例的失败被另一个实例的就绪遮住」（合并状态取最优的撒谎点：
 * paper3 就绪 + 写稿失败 → 合并出就绪，红字消失了）。
 */
import type { McpInstanceInfo, McpStatus } from "@shared/mcp";

export interface InstanceSummary {
  /** 计入就绪率的实例数（disabled 不算：它是「不该就绪」，不是「没就绪」——
      算进去停用的 server 会显示成「0/1 就绪」，像一个故障）。
      connecting 算：那是进度，头行同时在转圈 */
  total: number;
  ready: number;
  /** 连接失败的工作区名（按实例顺序） */
  failed: string[];
}

export function summarizeInstances(instances: McpInstanceInfo[]): InstanceSummary {
  let ready = 0;
  let counted = 0;
  const failed: string[] = [];
  for (const instance of instances) {
    if (instance.status.kind === "disabled") continue;
    counted += 1;
    if (instance.status.kind === "ready") ready += 1;
    if (instance.status.kind === "failed") failed.push(instance.workspace);
  }
  return { total: counted, ready, failed };
}

/**
 * 头行图标的 kind：有实例失败就按 failed 画（红三角），哪怕合并状态是就绪——
 * 颜色是第二信号，但「没有失败」这个信号本身不能撒谎。其余情况照原状态。
 */
export function headIconKind(status: McpStatus, summary: InstanceSummary): McpStatus["kind"] {
  if (summary.failed.length > 0) return "failed";
  return status.kind;
}

/**
 * 实例状态行（独占一行，不挤头行——窄右栏的宽度预算决定的）。
 * null = 不显示：没有实例（还没连过），或全灭（卡片错误块接管，不重复说一遍）。
 */
export function statusLine(summary: InstanceSummary): InstanceSummary | null {
  if (summary.total === 0) return null;
  if (summary.ready === 0 && summary.failed.length > 0) return null;
  return summary;
}

/** 就绪的实例所在的工作区名（「已连接 · paper-a、paper-b」那一行）。 */
export function readyWorkspaces(instances: McpInstanceInfo[]): string[] {
  return instances.filter((instance) => instance.status.kind === "ready").map((instance) => instance.workspace);
}

/**
 * 要整段贴出来的错误：整台的失败原文 + 各实例的失败原文，**相同的原文合成一条**（单个实例时整台的
 * 错误与实例的错误是同一段，贴两遍就是噪音——旧面板为此默认不展开实例块），不同的各一条并写明是哪几个工作区。
 * `workspaces` 为空 = 这条是整台的、不归某个工作区。
 */
export function mcpErrors(status: McpStatus, instances: McpInstanceInfo[]): { workspaces: string[]; message: string }[] {
  const byMessage = new Map<string, string[]>();
  if (status.kind === "failed") byMessage.set(status.message, []);
  for (const instance of instances) {
    if (instance.status.kind !== "failed") continue;
    const names = byMessage.get(instance.status.message) ?? [];
    // 单个实例、且与整台失败是同一段原文：不再标工作区，也不重复
    byMessage.set(instance.status.message, [...names, instance.workspace]);
  }
  const onlyOneInstance = instances.length <= 1;
  return [...byMessage].map(([message, workspaces]) => ({ message, workspaces: onlyOneInstance ? [] : workspaces }));
}

/**
 * 运行时快照里的实例（只有工作区 id）→ 详情用的实例（带工作区名）。Home 会话的实例（scope ""）没有分片语义，丢掉；
 * 翻不到名字的 id 原样显示，不让它凭空消失。
 */
export function namedInstances(
  instances: readonly { scope: string; label: string; status: McpStatus }[],
  nameOf: (workspaceId: string) => string,
): McpInstanceInfo[] {
  return instances.filter((instance) => instance.scope !== "").map((instance) => ({ ...instance, workspace: nameOf(instance.scope) }));
}
