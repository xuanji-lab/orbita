import { deepStrictEqual, doesNotMatch, match, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveSessionTitle,
  parseSessionMeta,
  SESSION_TITLE_MAX,
  sortSessions,
  transcriptToMarkdown,
  type SessionMeta,
} from "./session.ts";

const valid = {
  id: "a7f3c1d2",
  title: "Rebuild the renderer",
  cwd: "/Users/wafo/repo/orbita-lab",
  workspaceId: null,
  piSessionFile: null,
  pinned: false,
  archived: false,
  providerId: "zai",
  modelId: "glm-5.3",
  mode: "manual",
  createdAt: 1000,
  updatedAt: 2000,
};

describe("deriveSessionTitle", () => {
  it("取第一行", () => {
    strictEqual(deriveSessionTitle("把外壳重做一遍\n第二行不要"), "把外壳重做一遍");
  });

  it("前后空白不进标题", () => {
    strictEqual(deriveSessionTitle("  \n  重做外壳  \n"), "重做外壳");
  });

  it("超长截断加省略号——侧栏只有 288px，标题得一行放得下", () => {
    const title = deriveSessionTitle("x".repeat(200));
    strictEqual(title.length, SESSION_TITLE_MAX + 1);
    strictEqual(title.endsWith("…"), true);
  });

  it("刚好不超长就不截断", () => {
    const text = "y".repeat(SESSION_TITLE_MAX);
    strictEqual(deriveSessionTitle(text), text);
  });

  it("空输入给空标题——会话可以建了还没发过消息", () => {
    strictEqual(deriveSessionTitle("   \n  "), "");
  });
});

describe("parseSessionMeta", () => {
  it("完整的一条原样解出来", () => {
    deepStrictEqual(parseSessionMeta(valid), { ...valid, mode: "manual" });
  });

  // 少一条会话，比多一条指向空白的假会话好
  it("缺关键字段返回 null，让调用方跳过这条", () => {
    for (const key of ["id", "cwd", "providerId", "modelId", "createdAt"]) {
      const broken = { ...valid, [key]: undefined };
      strictEqual(parseSessionMeta(broken), null, `缺 ${key} 时应当返回 null`);
    }
    strictEqual(parseSessionMeta({ ...valid, id: "" }), null);
    strictEqual(parseSessionMeta(null), null);
    strictEqual(parseSessionMeta("{}"), null);
    strictEqual(parseSessionMeta([]), null);
  });

  it("标题可以缺——建了还没发消息的会话就是这样", () => {
    strictEqual(parseSessionMeta({ ...valid, title: undefined })?.title, "");
  });

  it("不认识的权限档退回最保守的 plan，而不是丢掉整条会话", () => {
    strictEqual(parseSessionMeta({ ...valid, mode: "yolo" })?.mode, "plan");
    strictEqual(parseSessionMeta({ ...valid, mode: undefined })?.mode, "plan");
  });

  it("缺 updatedAt 就用 createdAt 兜底", () => {
    strictEqual(parseSessionMeta({ ...valid, updatedAt: undefined })?.updatedAt, valid.createdAt);
  });

  it("不认识的字段丢掉，不原样带过去", () => {
    deepStrictEqual(parseSessionMeta({ ...valid, junk: 1, nested: { a: 1 } }), {
      ...valid,
      mode: "manual",
    });
  });

  // 本字段落地之前存的会话没有 pi 的本子，只能读不能续——界面要如实说出来
  it("缺 piSessionFile 视为不能续", () => {
    strictEqual(parseSessionMeta({ ...valid, piSessionFile: undefined })?.piSessionFile, null);
    strictEqual(parseSessionMeta({ ...valid, piSessionFile: 7 })?.piSessionFile, null);
    strictEqual(
      parseSessionMeta({ ...valid, piSessionFile: "/x/pi-sessions/a.jsonl" })?.piSessionFile,
      "/x/pi-sessions/a.jsonl",
    );
  });

  // 刀 B 之前存下的会话没有这个字段，它们不属于任何工作区，落到侧栏 TASKS 下
  it("缺 workspaceId 视为不属于任何工作区", () => {
    strictEqual(parseSessionMeta({ ...valid, workspaceId: undefined })?.workspaceId, null);
    strictEqual(parseSessionMeta({ ...valid, workspaceId: 42 })?.workspaceId, null);
    strictEqual(parseSessionMeta({ ...valid, workspaceId: "w1" })?.workspaceId, "w1");
  });
});

describe("sortSessions", () => {
  const at = (id: string, updatedAt: number, pinned = false): SessionMeta => ({
    ...valid,
    mode: "manual",
    id,
    updatedAt,
    pinned,
  });

  it("置顶的在前，其余按最近活动倒序", () => {
    const sorted = sortSessions([at("a", 3), at("b", 1, true), at("c", 5), at("d", 4, true)]);
    deepStrictEqual(sorted.map((s) => s.id), ["d", "b", "c", "a"]);
  });

  it("不改原数组", () => {
    const input = [at("a", 1), at("b", 2)];
    sortSessions(input);
    deepStrictEqual(input.map((s) => s.id), ["a", "b"]);
  });
});

describe("transcriptToMarkdown", () => {
  const user = {
    id: "u1",
    role: "user" as const,
    content: [{ type: "text" as const, text: "重做外壳" }],
    timestamp: 1,
  };
  const assistant = {
    id: "a1",
    role: "assistant" as const,
    content: [
      { type: "thinking" as const, thinking: "先读模板\n再看 token" },
      { type: "text" as const, text: "好的" },
      { type: "toolCall" as const, toolCallId: "t1", toolName: "read", input: { path: "a.css" } },
    ],
    model: { provider: "zai", id: "glm-5.3" },
    timestamp: 2,
    status: "complete" as const,
    stopReason: "stop" as const,
  };

  it("带 meta 时出标题与机器事实", () => {
    const md = transcriptToMarkdown([user], { ...valid, mode: "manual", title: "重做外壳" });
    match(md, /^# 重做外壳\n/);
    match(md, /- Folder: `\/Users\/wafo\/repo\/orbita-lab`/);
    match(md, /- Model: `zai \/ glm-5\.3`/);
    // ISO 8601 UTC：无歧义、可测
    match(md, /- Created: `1970-01-01T00:00:01Z`/);
  });

  it("不带 meta 时只出正文——「复制整条对话」用的就是这一支", () => {
    const md = transcriptToMarkdown([user]);
    doesNotMatch(md, /^#/);
    match(md, /\*\*User\*\*\n\n重做外壳/);
  });

  // 导出是给人看的存档，把过程抹掉就没法追溯了
  it("思考进引用块，工具调用进 json 代码块，都不丢", () => {
    const md = transcriptToMarkdown([assistant]);
    match(md, /> 先读模板\n> 再看 token/);
    match(md, /```json/);
    match(md, /"tool": "read"/);
    match(md, /"path": "a\.css"/);
  });

  it("空内容的条目不留一个孤零零的角色标题", () => {
    const empty = { id: "x", role: "user" as const, content: [], timestamp: 1 };
    doesNotMatch(transcriptToMarkdown([empty]), /\*\*User\*\*/);
  });

  it("结尾带换行——文本文件该以换行结束", () => {
    match(transcriptToMarkdown([user]), /\n$/);
  });
});
