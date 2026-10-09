/**
 * 输入框材料的**唯一数据来源**：把三路附件（截图 / 文件引用 / 引用）摊平成
 * 一张带类型、显示名、元信息与移除回调的清单。粘贴文本不走材料区（方案 C，
 * 2026-10-09：大段粘贴在光标处成句中胶囊，paste-blocks.ts）。
 *
 * 为什么要集中：材料在今天有「B 叠放」一种排布（截图一行、胶囊一行、引用一张卡，
 * Composer.tsx 的材料层），之后还要换排布（游戏化）。排布会换，**材料是什么**不换——
 * 类型、名字、元信息、怎么删，都只在这一处定义，新排布直接消费这张清单。
 * 不为「将来的排布」预建抽象（AGENTS.md 消费者纪律）：今天是清单一分部 + 一个
 * 真实消费者，不建 MaterialRenderer 之类的中间层。
 *
 * 纯函数：不 import React，可被 `node --test` 直接加载。
 */
import type { TextQuote } from "../../../shared/quote.ts";
import type { ComposerFileRef } from "./composer-attachments.ts";
import type { ComposerImage } from "./composer-images.ts";
import { quoteMeta } from "./quote-label.ts";
import type { Messages } from "../messages-en.ts";

/** 材料种类。file / dir 分开记：图标与语义都不同（模型对目录用 list、对文件用 read） */
export type ComposerMaterialKind = "image" | "file" | "dir" | "quote";

/**
 * 一条材料。`meta` 是排在名字后面的一小句机器事实（粘贴的行数、引用的来源与字数），
 * 没有就不给；`remove` 已按各自的 id / 下标接好回调，排布层不用再自己对账。
 * 原始对象（`image` / `ref` / `block` / `quote`）随行携带：渲染层要用的东西
 * （图的数据 URL、粘贴的全文、引用的跳转）不往这张清单里抄一遍。
 */
export type ComposerMaterial =
  | {
      kind: "image";
      id: string;
      name: string;
      meta: string | null;
      remove: () => void;
      image: ComposerImage;
    }
  | {
      kind: "file" | "dir";
      id: string;
      name: string;
      meta: string | null;
      remove: () => void;
      ref: ComposerFileRef;
    }
  | {
      kind: "quote";
      id: string;
      name: string;
      meta: string;
      remove: () => void;
      quote: TextQuote;
    };

/**
 * 摊平三路附件。**顺序就是叠放的规范顺序**：截图（一眼认得出的锚点）→
 * 文件 / 目录（同一层胶囊）→ 引用（贴着输入框）。排布层按 kind 分层或重排，
 * 都从这张清单出发。
 */
export function composerMaterials(input: {
  attachments: readonly ComposerImage[];
  files: readonly ComposerFileRef[];
  quotes: readonly TextQuote[];
  onRemoveAttachment: (id: string) => void;
  onRemoveFile: (id: string) => void;
  onRemoveQuote: (index: number) => void;
  t: Messages;
}): ComposerMaterial[] {
  const { t } = input;
  return [
    ...input.attachments.map<ComposerMaterial>((image) => ({
      kind: "image",
      id: image.id,
      name: image.name,
      // 图的尺寸要解码后才知道，不在这里猜（点开看原图时自然可见）
      meta: null,
      remove: () => input.onRemoveAttachment(image.id),
      image,
    })),
    ...input.files.map<ComposerMaterial>((ref) => ({
      kind: ref.kind,
      id: ref.id,
      name: ref.name,
      // 完整路径走胶囊的悬停 tooltip（FileChip），meta 不重复它
      meta: null,
      remove: () => input.onRemoveFile(ref.id),
      ref,
    })),
    ...input.quotes.map<ComposerMaterial>((quote, index) => ({
      kind: "quote",
      id: `${quote.messageId}:${index}`,
      name: quote.text,
      meta: quoteMeta(quote, t),
      remove: () => input.onRemoveQuote(index),
      quote,
    })),
  ];
}
