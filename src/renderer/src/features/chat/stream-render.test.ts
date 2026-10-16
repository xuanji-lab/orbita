/**
 * 流式取舍（stream-render.ts）的最小可执行测试：流式帧不挂 rehype-katex、不跑 shiki，
 * 落定帧两件都回来，bubble 变体不受影响。
 *
 * 只测纯函数——MarkdownBlock.tsx 顶层 import 了 katex 的 CSS，node 加载不进去，
 * 所以决策逻辑连同插件链一起住在 stream-render.ts（它本身不 import React / CSS）。
 */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import type { PluggableList } from "unified";
import { rehypeBubbleChips } from "./chip-runs.ts";
import { highlighterReady } from "./highlight.ts";
import { fenceHighlight, rehypePluginsFor, streamRenderPolicy } from "./stream-render.ts";

/** 插件组里有没有 katex：可能是裸插件，也可能是 [插件, 选项] 元组 */
function usesKatex(plugins: PluggableList): boolean {
  return plugins.some((entry) => entry === rehypeKatex || (Array.isArray(entry) && entry[0] === rehypeKatex));
}

describe("streamRenderPolicy", () => {
  it("流式帧：公式排版与高亮都关", () => {
    deepStrictEqual(streamRenderPolicy(true), { katex: false, highlight: false });
  });

  it("落定帧：两件都开（补渲靠它）", () => {
    deepStrictEqual(streamRenderPolicy(false), { katex: true, highlight: true });
  });
});

describe("rehypePluginsFor", () => {
  it("流式帧的正文链不含 rehype-katex，落定帧含", () => {
    ok(!usesKatex(rehypePluginsFor(false, streamRenderPolicy(true))));
    ok(usesKatex(rehypePluginsFor(false, streamRenderPolicy(false))));
  });

  it("两个分支都保留 raw → sanitize 的顺序（katex 必须在 sanitize 之后）", () => {
    for (const streaming of [true, false]) {
      const plugins = rehypePluginsFor(false, streamRenderPolicy(streaming));
      equal(plugins[0], rehypeRaw);
      const second = plugins[1];
      ok(Array.isArray(second) && second[0] === rehypeSanitize, "sanitize 必须排在第二位");
      if (usesKatex(plugins)) {
        ok(
          plugins.findIndex((entry) => entry === rehypeKatex || (Array.isArray(entry) && entry[0] === rehypeKatex)) ===
            plugins.length - 1,
          "katex 必须排在链末",
        );
      }
    }
  });

  it("bubble 变体与流式无关：公式照排、chip 变换仍在、不受 policy 影响", () => {
    for (const streaming of [true, false]) {
      const plugins = rehypePluginsFor(true, streamRenderPolicy(streaming));
      ok(usesKatex(plugins), "用户气泡里的公式照排");
      ok(plugins.includes(rehypeBubbleChips));
    }
    deepStrictEqual(
      rehypePluginsFor(true, streamRenderPolicy(true)),
      rehypePluginsFor(true, streamRenderPolicy(false)),
    );
  });
});

describe("fenceHighlight", () => {
  it("流式帧不跑 shiki：引擎就绪后也返回 null（走无色兜底）", async () => {
    await highlighterReady;
    equal(fenceHighlight(streamRenderPolicy(true).highlight, "const a: number = 1;", "ts"), null);
  });

  it("对照组：落定帧真出 shiki HTML", async () => {
    await highlighterReady;
    const html = fenceHighlight(streamRenderPolicy(false).highlight, "const a: number = 1;", "ts");
    ok(html !== null && html.includes('<pre class="shiki'));
  });

  it("边界：冷引擎、空文本、未知语言都不抛错——流式帧一律 null（无色兜底）", () => {
    const streaming = streamRenderPolicy(true).highlight;
    equal(fenceHighlight(streaming, "", "ts"), null);
    equal(fenceHighlight(streaming, "whatever", "foobar"), null);
    const settled = streamRenderPolicy(false).highlight;
    equal(fenceHighlight(settled, "whatever", "foobar"), null);
  });
});
