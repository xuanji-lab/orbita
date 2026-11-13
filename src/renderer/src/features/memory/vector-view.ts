/**
 * 向量模型页的「模型文件」一格怎么显示——纯函数，node:test 直接测。
 * 两路来源：状态快照（拉取时刻的值）与下载进度事件（更新、更细）。下载在途时以
 * 事件为准；事件说完成 / 失败后，以重拉回来的快照为准（文件真在盘上才算就绪）。
 */
import type { MemoryDownloadProgress, MemoryModelFileState } from "../../../../shared/memory.ts";

export type VectorFileView =
  | { kind: "none" }
  | { kind: "downloading"; percent: number; host: string | null }
  | { kind: "verifying" }
  | { kind: "ready" }
  | { kind: "failed"; error: string };

function hostOf(source: string): string | null {
  try {
    return new URL(source).host;
  } catch {
    return null;
  }
}

function percentOf(received: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((received / total) * 100)));
}

export function vectorFileView(
  snapshot: MemoryModelFileState,
  event: MemoryDownloadProgress | null,
): VectorFileView {
  // 快照已就绪：盘上有文件，旧的失败 / 进度事件不再遮住它
  if (snapshot.state === "ready") return { kind: "ready" };
  if (event !== null && event.phase === "downloading") {
    return { kind: "downloading", percent: percentOf(event.received, event.total), host: hostOf(event.source) };
  }
  if (event !== null && event.phase === "verifying") return { kind: "verifying" };
  if (snapshot.state === "downloading") {
    return { kind: "downloading", percent: percentOf(snapshot.received, snapshot.total), host: hostOf(snapshot.source) };
  }
  if (snapshot.state === "verifying") return { kind: "verifying" };
  if (snapshot.state === "failed") return { kind: "failed", error: snapshot.error };
  if (event !== null && event.phase === "failed") return { kind: "failed", error: event.error ?? "" };
  return { kind: "none" };
}
