/**
 * 编排面板协作图的「交回」边要的产物摘要：一批会话各自文件账里记过的文件数与扩展名（`session:artifact-summary`）。
 *
 * id 先过会话 id 白名单（renderer 传来的 id 会拼进路径）；一次最多 ARTIFACT_BATCH_MAX 条（满载一个工作区四十多个子会话，
 * 再多是调用方的错，截掉不报错）。读不到 / 读失败的 id 不出现在回执里——界面上那条边写「没有文件记录」，不编。
 */
import { summarizeArtifacts, type ArtifactSummary } from "../../shared/revert.ts";
import { fileTurnsIn } from "./revert.ts";
import { isSessionId, type SessionStore } from "./store.ts";

export const ARTIFACT_BATCH_MAX = 80;

export async function artifactSummaries(
  store: Pick<SessionStore, "readRawLog">,
  ids: unknown,
): Promise<Record<string, ArtifactSummary>> {
  if (!Array.isArray(ids)) return {};
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string" && isSessionId(id)))].slice(0, ARTIFACT_BATCH_MAX);
  const out: Record<string, ArtifactSummary> = {};
  await Promise.all(
    wanted.map(async (id) => {
      try {
        out[id] = summarizeArtifacts(fileTurnsIn(await store.readRawLog(id)));
      } catch {
        // 读失败：不在回执里，界面说「没有文件记录」
      }
    }),
  );
  return out;
}
