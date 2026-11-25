/**
 * 子会话交回时，它这一路做出来的东西（2026-11-22 用户：「我们怎么在主会话里面不需要进入子会话就可以看到子会话的产出呢？
 * 然后还能知道哪些是子会话，哪些是主会话的」）。
 *
 * 按子会话整条记录算：工具做出来的（演示文稿、文档、导出）+ 文件账里写的文档与网页 + 旁路网页，与主会话结尾那一摞
 * 同一套口径（process-rows.allOutputs）；文件账里的文档 / 网页 / 音视频只收各轮最终回答点了名的（turn-artifacts.ts，与主会话同一个函数），别的改过的文件只给个数。纯模块，可被 node --test 直接加载。
 */
import type { TranscriptRecord } from "../../../../shared/session.ts";
import { turnArtifacts } from "./turn-artifacts.ts";
import { allOutputs, type TurnOutput } from "./process-rows.ts";
import { flattenRenderUnits, indexToolResults, type ToolCallUnit } from "./tool-results.ts";

export interface SessionOutputs {
  outputs: TurnOutput[];
  /** 改过、但不是产物的文件（代码、配置……）：路径去重 */
  edited: string[];
}

export function sessionOutputs(records: readonly TranscriptRecord[]): SessionOutputs {
  const units = flattenRenderUnits(records);
  const calls = units.filter((unit): unit is ToolCallUnit => unit.kind === "toolCall");
  const results = indexToolResults(records);
  // 与主会话结尾摞同一个函数、同一条规则：每轮文件账记录只留它之前那段最终回答里点了名的网页 / 文档 / 音视频
  const { docs, web, media, edited } = turnArtifacts(units);
  const outputs = allOutputs(calls, results, docs, web, media);
  const shown = new Set(outputs.map((output) => output.path));
  return { outputs, edited: edited.filter((path) => !shown.has(path)) };
}

/**
 * 子会话这一轮收尾了吗（交回卡算产出前要问）：子会话交回（report_to_parent）时它的轮还没收尾——
 * 轮尾文件账（file-turn，含音视频候选）在交回之后几秒才落盘。只看交回那一刻的记录会漏掉它。
 * 收尾了 = 最后一条是 file-turn；或最后一条是不带工具调用的 assistant 正文、且记录条数与上一次读到的一样
 * （轮结束了、这一轮没有改文件，不会再有文件账）。`previousLength` 是上一次读到的条数（第一次读传 -1）。
 */
export function childRunSettled(records: readonly TranscriptRecord[], previousLength: number): boolean {
  const last = records[records.length - 1];
  if (last === undefined) return false;
  if (last.role === "file-turn") return true;
  // 模型错误 / abort 已是确定终局；即使 error 回答里还留着 toolCall，也不能让交回产出轮询两分钟。
  if (last.role === "assistant" && (last.status === "error" || last.status === "aborted")) return true;
  return last.role === "assistant" && !last.content.some((block) => block.type === "toolCall") && records.length === previousLength;
}
