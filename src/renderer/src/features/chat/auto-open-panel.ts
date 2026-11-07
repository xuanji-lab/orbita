import { useEffect, useRef } from "react";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { readOpenPanel, type OpenPanelHint } from "../../../../shared/builtin-command.ts";
import { requestOpenPanel } from "../../shell/open-panel.ts";

/**
 * 一批转录里，**这一轮刚落定**、还没处理过的内置命令结果带的「打开面板」请求（纯函数，可测）。
 *
 * - `seen`：已处理过的 toolCallId（就地更新）。落定帧才算（running / error 帧不开面板）；
 * - `liveNow`：本轮是否在跑。**历史回放不开面板**——切到一条旧会话、重载转录时，
 *   里面的 slides_create 不该把右栏抢过来；这类结果只记进 seen；
 * - `opened`：本会话已自动开过的路径。非 force 的请求只在第一次碰到某个文件时开
 *   （agent 连改十页不该每次把右栏抢回来——用户可能正在看别的）；force 的（新建）每次都开。
 */
export function collectOpenHints(
  transcript: readonly TranscriptItem[],
  seen: Set<string>,
  opened: Set<string>,
  liveNow: boolean,
): OpenPanelHint[] {
  const hints: OpenPanelHint[] = [];
  for (const item of transcript) {
    if (item.role !== "tool" || item.status === "running") continue;
    if (seen.has(item.toolCallId)) continue;
    seen.add(item.toolCallId);
    if (!liveNow || item.status === "error") continue;
    const hint = readOpenPanel(item.details);
    if (hint === null) continue;
    if (hint.force !== true && opened.has(hint.path)) continue;
    opened.add(hint.path);
    hints.push(hint);
  }
  return hints;
}

/**
 * App 里调用：本轮在跑时，转录里新落定的内置命令结果带 `details.openPanel` 就请求右栏打开它。
 * 换会话重置账本（旧会话的结果全算已处理）。
 */
export function useAutoOpenPanel(
  sessionId: string | null,
  transcript: readonly TranscriptItem[],
  turnActive: boolean,
): void {
  const book = useRef<{ sessionId: string | null; seen: Set<string>; opened: Set<string> }>({
    sessionId,
    seen: new Set(),
    opened: new Set(),
  });
  if (book.current.sessionId !== sessionId) {
    book.current = { sessionId, seen: new Set(), opened: new Set() };
  }
  useEffect(() => {
    const { seen, opened } = book.current;
    for (const hint of collectOpenHints(transcript, seen, opened, turnActive)) requestOpenPanel(hint);
  }, [transcript, turnActive, sessionId]);
}
