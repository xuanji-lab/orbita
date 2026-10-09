/**
 * 文件面板「Session · 附件」列表的数据半边（纯函数，`node --test` 直接可测）。
 *
 * 附件不是盘上的新东西——是**这条会话已经发给过模型的文件引用**。发送时主进程把
 * external 的复制进会话目录、workspace 的原位置引用，模型拿到的那条路径写进了
 * 用户消息的 `<attached-files>` 块（shared/prompt-attachments.ts 的 filesBlockOf）。
 * 这里从已加载的转录把它解析回来：不动磁盘、不建链接、不新增副本（方案 A），
 * 也不新增 IPC——盘上事实（还在不在、是文件还是目录）走已有的 `fs:stat-kind`。
 */
import { splitUserTextBlocks } from "../../../../shared/prompt-attachments.ts";

/**
 * 转录结构的最小子集：只认 role 与 content 的 text 块——`TranscriptItem` 结构上
 * 可代入，测试不必拉 pi 的类型。
 */
export interface TranscriptLikeItem {
  role: string;
  content: readonly { type: string; text?: string }[];
}

/** 一条已发送的附件：模型实际拿到的那条路径（副本或原位置）与它的类型 */
export interface SentAttachment {
  path: string;
  kind: "file" | "dir";
}

/**
 * 已加载转录 → 已发送附件清单。逐条用户消息解析 `<attached-files>` 块，**同路径
 * 去重、保首现顺序**——同一条消息里引用两次、或两轮都带着同一个文件，清单里只
 * 出现一次（路径相同就是同一个东西；副本路径含 uuid，同一次拖入的两个同名文件
 * 天然不同路径，不会误并）。非 user 条目、没有附件块的消息原样跳过。
 */
export function collectSentAttachments(items: readonly TranscriptLikeItem[]): SentAttachment[] {
  const seen = new Set<string>();
  const out: SentAttachment[] = [];
  for (const item of items) {
    if (item.role !== "user") continue;
    const texts = item.content
      .filter((block) => block.type === "text" && block.text !== undefined)
      .map((block) => (block.type === "text" && block.text !== undefined ? block.text : ""));
    const { files } = splitUserTextBlocks(texts);
    for (const file of files) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      out.push({ path: file.path, kind: file.kind });
    }
  }
  return out;
}
