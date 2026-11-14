/**
 * 一轮落定时的文件账与旁路网页产物上报：旧内核（runtime.ts）与新内核（kernel-session.ts）共用这一份。
 */
import type { AgentEvent } from "../shared/agent-ipc.ts";
import type { TurnFileTracker } from "./file-tracker.ts";
import { foldWebArtifacts, scanWebArtifacts, WEB_ARTIFACT_MTIME_SLACK_MS, type ScanRoot, type WebScanResult } from "./web-artifacts.ts";

/**
 * 轮落定的文件账上报：主进程写快照 blob、落 FileTurnRecord 并广播给轮尾卡片。
 * 没有改动的轮不发（不落空记录）；报失败只记日志——快照是回退能力的代价面，
 * 不是对话的依赖面，坏一条日志好过砸一轮对话。
 *
 * 旁路网页产物（web-artifacts.ts）在同一处结算：轮尾扫一遍、按 mtime ≥ 开轮时刻
 * 收「本轮新出现」的网页文件，扣掉已在文件账里的路径；命中数超过批量上限就
 * 折叠成计数（webArtifactsBatch），不逐个列。扫描失败只丢旁路那一栏，文件账照报。
 */
export async function reportFileTurn(
  sessionId: string,
  tracker: TurnFileTracker,
  webWatch: WebArtifactWatch,
  send: (event: AgentEvent) => void,
): Promise<void> {
  try {
    // 文件账与旁路扫描并行——轮尾收尾不该被其中一边白等
    const [changes, scan] = await Promise.all([
      tracker.finalize(),
      scanWebArtifactsLogged(webWatch.roots, webWatch.startedAt),
    ]);
    const tracked = new Set(changes.map((change) => change.path));
    const folded = foldWebArtifacts(scan.paths.filter((path) => !tracked.has(path)));
    if (changes.length > 0 || folded.webArtifacts.length > 0 || folded.webArtifactsBatch !== undefined) {
      send({
        type: "fileTurn",
        sessionId,
        changes,
        ...(folded.webArtifacts.length > 0 ? { webArtifacts: folded.webArtifacts } : {}),
        ...(folded.webArtifactsBatch !== undefined ? { webArtifactsBatch: folded.webArtifactsBatch } : {}),
      });
    }
  } catch (cause) {
    console.error("[agent] 轮尾文件账没报出去（回退会缺这一轮的快照）", sessionId, cause);
  }
}

/**
 * 本轮的网页产物旁路：扫描根（含各自的预算）+ 开轮时刻。类型在 OpenedTurn /
 * TurnParts 上透传，轮尾 reportFileTurn 按它扫描。
 */
export interface WebArtifactWatch {
  roots: ScanRoot[];
  /** 开轮时刻（Date.now()）：轮尾扫描收 mtime ≥ startedAt − slack 的文件 */
  startedAt: number;
}

/** 扫一遍并处理好日志面：截断 warn、失败按空结果（本轮没有旁路产物，不让扫描拖砸轮尾）。 */
async function scanWebArtifactsLogged(roots: readonly ScanRoot[], startedAt: number): Promise<WebScanResult> {
  try {
    const result = await scanWebArtifacts(roots, startedAt - WEB_ARTIFACT_MTIME_SLACK_MS);
    if (result.truncated) {
      console.warn(
        `[web-artifacts] 扫描撞条目上限被截断（本轮网页产物可能漏报）roots=${roots
          .map((entry) => entry.root)
          .join(" | ")}`,
      );
    }
    return result;
  } catch (cause) {
    console.error("[web-artifacts] 扫描失败，本轮按没有旁路网页产物处理", cause);
    return { paths: [], truncated: false };
  }
}

