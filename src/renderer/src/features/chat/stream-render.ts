/**
 * 流式帧的渲染取舍（性能）：模型打字期间每个 chunk 都是新文本，整条消息的 markdown
 * 管线全量重跑——其中最贵的是 KaTeX 公式排版与 shiki 代码高亮，两者都命中不了缓存
 * （缓存按「语言 + 全文」，而全文每帧都在长）。做法与 Proma / ZCode 一致：**流式期间
 * 关掉贵的渲染，消息落定后补渲**（ZCode 是 `enableSyntaxHighlighting={!renderStreaming}`）。
 *
 * 落定 = 同一条消息的 `streaming` 翻 false，MarkdownBlock 的 memo 按 prop 浅比较失效，
 * 自动重渲一次补上公式与高亮。流式期间公式退回 markdown 的原样（行内是等宽的 LaTeX
 * 片段、块级是无色代码块——半截公式本来也排不出来），于是**也不再给尾部补闭合符**：
 * 补闭合符的唯一消费者就是 KaTeX，不渲公式就不该改文本（旧的 pending-math.ts 随之
 * 整块下线，它防的「`价格 $5 起` 被补成公式」也一并消失）。
 *
 * 纯模块：不 import React、不 import CSS，`node --test` 直接加载——MarkdownBlock.tsx
 * 顶层 import 了 katex 的 CSS，node 连加载都进不去，可测的决策逻辑必须住在这里。
 */
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { PluggableList } from "unified";
import { rehypeBubbleChips } from "./chip-runs.ts";
import { highlightBlock } from "./highlight.ts";

/** 一帧的渲染取舍：落定帧两件都开，流式帧两件都关 */
export interface StreamRenderPolicy {
  /** rehype 链末端挂 rehype-katex（公式排版） */
  readonly katex: boolean;
  /** pre 覆写跑 shiki（代码高亮） */
  readonly highlight: boolean;
}

export function streamRenderPolicy(streaming: boolean): StreamRenderPolicy {
  return streaming ? { katex: false, highlight: false } : { katex: true, highlight: true };
}

/**
 * sanitize 白名单：defaultSchema 之上只放行 `<details>`/`<summary>`，其余标签
 * rehype-raw 解析完照剥。**顺序敏感**（rehypePlugins 数组序）：rehypeRaw →
 * rehypeSanitize → rehypeKatex——sanitize 必须在 katex 前，否则会把 KaTeX 的
 * 输出剥掉；其默认 schema 保留 code 的 language-* class，math 节点能活着走到
 * katex。
 */
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "details", "summary"],
};

/**
 * KaTeX 选项：`trust: false` 是安全闸——公式永远只是视觉，`\href` 等带行为的命令
 * 拒绝；`throwOnError: false` 让非法 LaTeX 原地显示源码，由 styles.css 降级成斜体
 * 次级灰（不是报警）。
 */
const KATEX: [typeof rehypeKatex, { throwOnError: boolean; strict: boolean; trust: boolean }] = [
  rehypeKatex,
  { throwOnError: false, strict: false, trust: false },
];

/**
 * 正文的 rehype 链。`bubble`（用户气泡）与 policy 无关地照排公式——气泡不出现在
 * 流式帧里，没有省的必要，插件组维持原状。
 */
export function rehypePluginsFor(bubble: boolean, policy: StreamRenderPolicy): PluggableList {
  if (bubble) {
    // bubble 变体在 sanitize 之后多挂 rehypeBubbleChips：用户原文里的 /skill: token
    // 就地换成 chip（span.bubble-chip，chip-runs.ts）。必须排在 sanitize 之后
    // ——span 不在白名单里，先换会被剥掉；排在 katex 之前——数学节点是 code，
    // 与 chip 互不碰面
    return [rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA], rehypeBubbleChips, KATEX];
  }
  // 流式帧末位不挂 katex：半截公式本来就排不出，这一挂是每帧最贵的一笔
  return policy.katex
    ? [rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA], KATEX]
    : [rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA]];
}

/**
 * 代码块 → shiki HTML。`highlight=false`（流式帧）直接 null 走无色兜底，连缓存都不查、
 * 不 tokenize；落定帧才真去调 shiki。
 */
export function fenceHighlight(highlight: boolean, code: string, fence: string): string | null {
  return highlight ? highlightBlock(code, fence) : null;
}
