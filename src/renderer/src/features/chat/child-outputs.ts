/**
 * 子会话交回时，它这一路做出来的东西（2026-11-22 用户：「我们怎么在主会话里面不需要进入子会话就可以看到子会话的产出呢？
 * 然后还能知道哪些是子会话，哪些是主会话的」）。
 *
 * 按子会话整条记录算：工具做出来的（演示文稿、文档、导出）+ 文件账里写的文档与网页 + 旁路网页，与主会话结尾那一摞
 * 同一套口径（process-rows.allOutputs）；别的改过的文件只给个数。纯模块，可被 node --test 直接加载。
 */
import type { TranscriptRecord } from "../../../../shared/session.ts";
import { isWebArtifactFile } from "../../../../shared/files.ts";
import { allOutputs, type TurnOutput } from "./process-rows.ts";
import { flattenRenderUnits, indexToolResults, type ToolCallUnit } from "./tool-results.ts";

const DOC_FILE = /\.(?:md|markdown|txt)$/i;

export interface SessionOutputs {
  outputs: TurnOutput[];
  /** 改过、但不是产物的文件（代码、配置……）：路径去重 */
  edited: string[];
}

export function sessionOutputs(records: readonly TranscriptRecord[]): SessionOutputs {
  const units = flattenRenderUnits(records);
  const calls = units.filter((unit): unit is ToolCallUnit => unit.kind === "toolCall");
  const results = indexToolResults(records);
  const docs: string[] = [];
  const web: string[] = [];
  const edited = new Set<string>();
  for (const record of records) {
    if (record.role !== "file-turn") continue;
    for (const change of record.changes) {
      if (DOC_FILE.test(change.path)) docs.push(change.path);
      else if (isWebArtifactFile(change.path)) web.push(change.path);
      else edited.add(change.path);
    }
    web.push(...(record.webArtifacts ?? []));
  }
  const outputs = allOutputs(calls, results, docs, web);
  const shown = new Set(outputs.map((output) => output.path));
  return { outputs, edited: [...edited].filter((path) => !shown.has(path)) };
}
