/**
 * MCP 面板行的派生（纯函数，与 tool-chips.ts 同一条纪律：算与渲染分开）。
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
 * 卡片此刻该显示的状态。**Reload 进行中时非 disabled 的行一律转 connecting**：
 * 实时状态还没回来，不装作不变（配置可能已经变了，旧状态是谎话）。
 *
 * 单独提出来是因为这个换算以前写在面板组件里，与下面的文案映射一起漏了 connecting
 * 这一档：慢 server（npx 首次装包常见几十秒）正在连的时候卡片写「还没连上」，
 * 用户以为配置错了（2026-10-25 实测）。
 */
export function displayedStatus(status: McpStatus, reloading: boolean): McpStatus {
  return reloading && status.kind !== "disabled" ? { kind: "connecting" } : status;
}

/**
 * 头行状态文案的语义。**纯函数**：只判状态属于哪一档，本地化文案在渲染层取
 * （row-display 不 import locale，理由同 tool-chips：算与渲染分开）。
 * connecting 必须自成一档——它与 idle 都是「还没就绪」，但对用户是两件事：
 * 一个在等，一个是没开始。
 */
export type StatusTextSpec =
  | { kind: "tools"; count: number }
  | { kind: "failed" }
  | { kind: "disabled" }
  | { kind: "connecting" }
  | { kind: "idle" };

export function statusTextSpec(status: McpStatus): StatusTextSpec {
  switch (status.kind) {
    case "ready":
      return { kind: "tools", count: status.tools.length };
    case "failed":
      return { kind: "failed" };
    case "disabled":
      return { kind: "disabled" };
    case "connecting":
      return { kind: "connecting" };
    case "idle":
      return { kind: "idle" };
  }
}

/**
 * 实例状态行（卡内独占一行，不挤头行——320px 抽屉的宽度预算决定的）。
 * null = 不显示：没有实例（还没连过），或全灭（卡片错误块接管，不重复说一遍）。
 */
export function statusLine(summary: InstanceSummary): InstanceSummary | null {
  if (summary.total === 0) return null;
  if (summary.ready === 0 && summary.failed.length > 0) return null;
  return summary;
}
