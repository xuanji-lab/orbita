/**
 * 文件面板「Session · 附件」列表的数据半边（纯函数，`node --test` 直接可测）。
 *
 * 附件不是盘上的新东西——是**这条会话已经发给过模型的东西**，两类：
 * - 文件 / 目录引用：发送时主进程把 external 的复制进会话附件目录、workspace 的
 *   原位置引用，模型拿到的那条路径写进了用户消息的 `<attached-files>` 块
 *   （shared/prompt-attachments.ts 的 filesBlockOf）；
 * - 附图：随消息发出的图片内容块。主进程发送前把原图存进
 *   `sessions/<id>.attachments/<uuid>.<ext>`，转录图块上挂着相对引用
 *   `original`（shared/prompt-images.ts 的 ORIGINAL_REF 把关格式）——附件列表
 *   按它收图，读原图走已有的 `session.attachment(ref)` IPC，不动 fs:roots。
 *
 * 两类都从已加载的转录解析回来：不动磁盘、不建链接、不新增副本（方案 A/B 的
 * 同一条底线），也不新增 IPC——文件引用的盘上事实（还在不在、是文件还是目录）
 * 走已有的 `fs:stat-kind`。
 */
import { parseFilesBlock } from "../../../../shared/prompt-attachments.ts";
import { originalRefOf } from "../../../../shared/prompt-images.ts";
import { pathTail } from "../../../../shared/path.ts";

/**
 * 转录结构的最小子集：只认 role 与 content 的 text / image 块——`TranscriptItem`
 * 结构上可代入，测试不必拉 pi 的类型。
 */
export interface TranscriptLikeItem {
  role: string;
  content: readonly { type: string; text?: string; original?: unknown }[];
}

/**
 * 一条已发送的附件。
 * - `ref`：文件 / 目录引用。path 是模型实际拿到的那条（副本或原位置）；
 * - `image`：附图。ref 是原图引用，name 是合成名 `image-N.<ext>`——按整条会话
 *   首现顺序编号（用户读的是「我发的第几张图」，uuid 谁也认不出），扩展名取自
 *   引用尾段（ORIGINAL_REF 恒带扩展名，与落盘文件一致）。
 */
export type SentAttachment =
  | { kind: "ref"; path: string; fileKind: "file" | "dir" }
  | { kind: "image"; ref: string; name: string };

/** 一条已发送的文件引用（ref 变体的窄类型，组件里收窄用） */
export type SentFileRef = Extract<SentAttachment, { kind: "ref" }>;

/**
 * 已加载转录 → 已发送附件清单。逐条用户消息、逐块按**转录自身的块序**解析：
 * 一条消息里 `<attached-files>` 块在图块之前（userPrompt 的拼装顺序），清单里
 * 文件引用也就排在图前面。**同键去重、保首现顺序**——同一条消息里引用两次、或
 * 两轮都带着同一个文件 / 同一张图，清单里只出现一次（路径与引用各自命名空间，
 * 不会互并）。没存下原图的图（saveOriginals 失败的兜底）没有盘上事实、预览通道
 * 也进不去，不进清单——宁缺毋滥，不摆一条点不开的死行。
 */
export function collectSentAttachments(items: readonly TranscriptLikeItem[]): SentAttachment[] {
  const seen = new Set<string>();
  const out: SentAttachment[] = [];
  let imageIndex = 0;
  for (const item of items) {
    if (item.role !== "user") continue;
    for (const block of item.content) {
      if (block.type === "text" && block.text !== undefined) {
        const refs = parseFilesBlock(block.text);
        if (refs === null) continue;
        for (const ref of refs) {
          if (seen.has(ref.path)) continue;
          seen.add(ref.path);
          out.push({ kind: "ref", path: ref.path, fileKind: ref.kind });
        }
      } else if (block.type === "image") {
        const original = originalRefOf(block);
        if (original === null) continue;
        if (seen.has(original)) continue;
        seen.add(original);
        imageIndex += 1;
        const ext = original.slice(original.lastIndexOf(".") + 1);
        out.push({ kind: "image", ref: original, name: `image-${imageIndex}.${ext}` });
      }
    }
  }
  return out;
}

/** 一条附件的显示名：文件引用取路径末段（空退全路径），附图用合成名 */
export function attachmentName(attachment: SentAttachment): string {
  if (attachment.kind === "image") return attachment.name;
  const tail = pathTail(attachment.path);
  return tail === "" ? attachment.path : tail;
}
