/**
 * 一轮里「文件账 / 旁路扫描报上来的候选」→ 交给用户的产物：**主会话结尾摞、子会话交回、状态卡三处共用这一个函数**
 * （2026-11-23：会话 8068a0 的产物里出现了顺手 edit 的 SKILL.md；旁路网页还会因为别的会话同时在跑脚本而串台）。
 *
 * 规则：候选（文件账里的 .md / .txt 文档、write / edit 写的与旁路扫出的 .html / .svg、旁路扫出的音视频）
 * 一律只留**这一轮最终回答里点了名**的（named-outputs.ts）。最终回答 = 该轮文件账记录之前那一段连续的正文
 * （遇到思考 / 工具调用 / 用户消息 / 通道标记就断）。工具声明的产物（slides_* / doc_open / 导出）不在这里——
 * 它们本身就是声明，照旧全收（process-rows.ts 的 turnOutputs）。
 *
 * 纯模块：只 import 类型，可被 node --test 直接加载。
 */
import { isWebArtifactFile } from "../../../../shared/files.ts";
import type { MediaArtifact } from "../../../../shared/revert.ts";
import { namedMedia, namedPaths } from "./named-outputs.ts";
import type { RenderEntry } from "./tool-results.ts";

const DOC_FILE = /\.(?:md|markdown|txt)$/i;

export interface TurnArtifacts {
  /** 点了名的文档（.md / .markdown / .txt） */
  docs: string[];
  /** 点了名的网页（.html / .htm / .svg，文件账里写的与旁路扫出的合并） */
  web: string[];
  /** 点了名的音视频 */
  media: MediaArtifact[];
  /** 改过、但不算产物的文件（没点名的文档 / 网页，与代码、配置等）：路径去重；子会话交回卡只给个数 */
  edited: string[];
}

/** 一段渲染单元里全部文件账记录的产物（每条按它之前那段最终回答点名）；落定后才调（跑着的轮不出产物） */
export function turnArtifacts(entries: readonly RenderEntry[]): TurnArtifacts {
  const docs: string[] = [];
  const web: string[] = [];
  const media: MediaArtifact[] = [];
  const edited = new Set<string>();
  let answer: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "text") {
      answer.push(entry.text);
      continue;
    }
    if (entry.kind !== "fileTurn") {
      answer = [];
      continue;
    }
    const text = answer.join("\n");
    const changed = entry.record.changes.map((change) => change.path);
    const docCandidates = changed.filter((path) => DOC_FILE.test(path));
    const webCandidates = [...changed.filter((path) => isWebArtifactFile(path)), ...(entry.record.webArtifacts ?? [])];
    const namedDocs = namedPaths(docCandidates, text);
    const namedWeb = namedPaths(webCandidates, text);
    docs.push(...namedDocs);
    web.push(...namedWeb);
    media.push(...namedMedia(entry.record.mediaArtifacts ?? [], text));
    const shown = new Set([...namedDocs, ...namedWeb]);
    for (const path of changed) if (!shown.has(path)) edited.add(path);
  }
  return { docs, web, media, edited: [...edited] };
}
