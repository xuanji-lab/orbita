import { deepStrictEqual, doesNotMatch, match, notStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveSessionTitle,
  isChannelMarkRecord,
  isCompactedRecord,
  parseAgentStats,
  parseSessionMeta,
  childSessions,
  pushRecentQuery,
  recentQueriesFromRecords,
  RECENT_QUERIES_MAX,
  rootSessions,
  SESSION_TITLE_MAX,
  sortSessions,
  transcriptToMarkdown,
  type SessionMeta,
} from "./session.ts";

const valid = {
  id: "a7f3c1d2",
  title: "Rebuild the renderer",
  titleSource: "derived" as const,
  cwd: "/Users/wafo/repo/orbita-lab",
  workspaceId: null,
  piSessionFile: null,
  pinned: false,
  archived: false,
  starred: false,
  completion: "open" as const,
  closedAt: null,
  providerId: "zai",
  modelId: "glm-5.3",
  mode: "manual",
  thinkingLevel: "medium" as const,
  recentQueries: [],
  stats: null,
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

  it("附件块不进标题——「只发附件不打字」开会话不显示裸 XML", () => {
    strictEqual(deriveSessionTitle("<pasted-text>\n一大段日志\n</pasted-text>"), "");
    strictEqual(
      deriveSessionTitle("<attached-files>\nThe user attached these files from their disk. Read them with the read tool when you need their contents.\n- /tmp/a.ts\n</attached-files>"),
      "",
    );
  });

  it("正文与附件同存时只取正文首行", () => {
    strictEqual(deriveSessionTitle("看看这个配置\nsecond"), "看看这个配置");
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

  it("思考档：合法透传（7 档全集）；缺省与坏值退 medium——字段落地前的老会话实际跑的就是它", () => {
    strictEqual(parseSessionMeta({ ...valid, thinkingLevel: "off" })?.thinkingLevel, "off");
    strictEqual(parseSessionMeta({ ...valid, thinkingLevel: "xhigh" })?.thinkingLevel, "xhigh");
    strictEqual(parseSessionMeta({ ...valid, thinkingLevel: undefined })?.thinkingLevel, "medium");
    strictEqual(parseSessionMeta({ ...valid, thinkingLevel: "turbo" })?.thinkingLevel, "medium");
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

  // 子会话之前存的会话没有这个字段：缺席即根，与 importedFrom 同一条纪律
  it("缺 parentId 视为根会话；坏值同样按根会话读，不丢会话", () => {
    strictEqual("parentId" in (parseSessionMeta(valid) ?? {}), false);
    strictEqual(parseSessionMeta({ ...valid, parentId: "m1" })?.parentId, "m1");
    // 坏值退回根：一条指向乌有的 parentId 会让会话从左栏消失又无处可达
    strictEqual(parseSessionMeta({ ...valid, parentId: 42 })?.parentId, undefined);
    strictEqual(parseSessionMeta({ ...valid, parentId: "" })?.parentId, undefined);
  });

  // auto-title（C-3）之前存的会话没有这个字段：它们是首句截断，允许模型再试
  it("缺 titleSource 视为 derived；坏值同样退回 derived，不丢会话", () => {
    strictEqual(parseSessionMeta({ ...valid, titleSource: undefined })?.titleSource, "derived");
    strictEqual(parseSessionMeta({ ...valid, titleSource: "hacked" })?.titleSource, "derived");
    strictEqual(parseSessionMeta({ ...valid, titleSource: "user" })?.titleSource, "user");
    strictEqual(parseSessionMeta({ ...valid, titleSource: "auto" })?.titleSource, "auto");
  });

  // 会话卡（D-1）之前存的会话没有这个字段：空槽显示，不读日志补算
  it("缺 recentQueries 视为空；坏值丢掉只留字符串前 3 个", () => {
    deepStrictEqual(parseSessionMeta({ ...valid, recentQueries: undefined })?.recentQueries, []);
    deepStrictEqual(parseSessionMeta({ ...valid, recentQueries: "x" })?.recentQueries, []);
    deepStrictEqual(
      parseSessionMeta({ ...valid, recentQueries: ["a", 42, "b", "c", "d"] })?.recentQueries,
      ["a", "b", "c"],
    );
  });

  // 生命周期字段（星标 / 完成状态）之前存的会话没有这三个字段：星标默认关、
  // 状态默认 open、没有关闭时刻——老会话不因加字段而变样
  it("缺 starred / completion / closedAt 给默认值：false / open / null", () => {
    const meta = parseSessionMeta({
      ...valid,
      starred: undefined,
      completion: undefined,
      closedAt: undefined,
    });
    strictEqual(meta?.starred, false);
    strictEqual(meta?.completion, "open");
    strictEqual(meta?.closedAt, null);
  });

  it("completion 只收合法枚举：合法透传，坏值回落 open，不丢整条会话", () => {
    strictEqual(parseSessionMeta({ ...valid, completion: "done" })?.completion, "done");
    strictEqual(
      parseSessionMeta({ ...valid, completion: "done_with_todos" })?.completion,
      "done_with_todos",
    );
    strictEqual(parseSessionMeta({ ...valid, completion: "banana" })?.completion, "open");
    strictEqual(parseSessionMeta({ ...valid, completion: 42 })?.completion, "open");
  });

  it("closedAt 只收有限数字：NaN / Infinity / 非数字一律 null，合法数字透传", () => {
    strictEqual(parseSessionMeta({ ...valid, closedAt: 5000 })?.closedAt, 5000);
    strictEqual(parseSessionMeta({ ...valid, closedAt: Number.NaN })?.closedAt, null);
    strictEqual(
      parseSessionMeta({ ...valid, closedAt: Number.POSITIVE_INFINITY })?.closedAt,
      null,
    );
    strictEqual(parseSessionMeta({ ...valid, closedAt: "yesterday" })?.closedAt, null);
  });
});

describe("pushRecentQuery", () => {
  it("新的在前，超出上限丢最旧的", () => {
    let queries = pushRecentQuery([], "第一问");
    queries = pushRecentQuery(queries, "第二问");
    queries = pushRecentQuery(queries, "第三问");
    queries = pushRecentQuery(queries, "第四问");
    deepStrictEqual(queries, ["第四问", "第三问", "第二问"]);
    strictEqual(queries.length, RECENT_QUERIES_MAX);
  });

  it("空消息不记——图片消息等没有文本可显示", () => {
    deepStrictEqual(pushRecentQuery(["旧问"], "  \n  "), ["旧问"]);
  });

  it("多行只取首行，截断规则与标题一致", () => {
    deepStrictEqual(pushRecentQuery([], "  首行才是提问\n第二行不要"), ["首行才是提问"]);
  });
});

describe("recentQueriesFromRecords", () => {
  const userItem = (id: string, text: string) => ({
    id,
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: 1,
  });

  it("按时间顺序折进「最近提问」，新→旧", () => {
    const queries = recentQueriesFromRecords([userItem("u1", "第一问"), userItem("u2", "第二问")]);
    deepStrictEqual(queries, ["第二问", "第一问"]);
  });

  it("跳过非用户记录；分支的新会话从它的前缀继承", () => {
    const assistant = {
      id: "a1",
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "答" }],
      model: { provider: "zai", id: "glm-5.3" },
      timestamp: 2,
      status: "complete" as const,
      stopReason: "stop" as const,
    };
    deepStrictEqual(
      recentQueriesFromRecords([userItem("u1", "问"), assistant, userItem("u2", "再问")]),
      ["再问", "问"],
    );
  });

  it("通道标记不算可见用户消息——正文在通道账本里，标记不是提问", () => {
    const mark: Parameters<typeof recentQueriesFromRecords>[0][number] = {
      role: "channel-mark",
      id: "k1",
      peerId: "c1",
      messageId: "m1",
      from: "child",
      kind: "question",
      timestamp: 3,
    };
    deepStrictEqual(recentQueriesFromRecords([userItem("u1", "问"), mark]), ["问"]);
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

describe("rootSessions / childSessions", () => {
  const at = (id: string, createdAt: number, parentId?: string): SessionMeta => ({
    ...valid,
    mode: "manual",
    id,
    createdAt,
    ...(parentId === undefined ? null : { parentId }),
  });

  it("rootSessions 只留没有母会话的——左栏/首页/picker 共用这一条规则", () => {
    const list = [at("a", 1), at("b", 2, "a"), at("c", 3), at("d", 4, "c")];
    deepStrictEqual(rootSessions(list).map((s) => s.id), ["a", "c"]);
  });

  it("rootSessions 不改原数组；全是子会话时给空", () => {
    const input = [at("a", 1), at("b", 2, "a")];
    rootSessions(input);
    deepStrictEqual(input.map((s) => s.id), ["a", "b"]);
    deepStrictEqual(rootSessions([at("b", 2, "a")]), []);
  });

  it("childSessions 按 createdAt 正序——子会话的自然顺序是派出顺序", () => {
    const list = [at("x", 30, "m"), at("m", 1), at("y", 10, "m"), at("z", 20, "m")];
    deepStrictEqual(childSessions(list, "m").map((s) => s.id), ["y", "z", "x"]);
  });

  it("childSessions 只取直接子会话，孙辈不进来", () => {
    const list = [at("m", 1), at("c", 2, "m"), at("g", 3, "c")];
    deepStrictEqual(childSessions(list, "m").map((s) => s.id), ["c"]);
    deepStrictEqual(childSessions(list, "nobody"), []);
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

  it("通道标记暂不渲染——正文只有一份在通道里，导出不在这里捏一行假的", () => {
    const mark = {
      role: "channel-mark" as const,
      id: "k1",
      peerId: "c1",
      messageId: "m1",
      from: "parent" as const,
      kind: "task" as const,
      timestamp: 2,
    };
    const md = transcriptToMarkdown([user, mark, assistant]);
    match(md, /重做外壳/);
    match(md, /好的/);
    doesNotMatch(md, /channel-mark/);
    doesNotMatch(md, /k1/);
  });

  it("结尾带换行——文本文件该以换行结束", () => {
    match(transcriptToMarkdown([user]), /\n$/);
  });
});

describe("isCompactedRecord", () => {
  const compacted = {
    role: "compacted" as const,
    id: "c1",
    summary: "## Goal\n做完了",
    tokensBefore: 85000,
    timestamp: 3,
  };

  it("完整的一条原样认出", () => {
    strictEqual(isCompactedRecord(compacted), true);
    // tokensAfter 是后来加的可选字段：旧记录没有照样认
    strictEqual(isCompactedRecord({ ...compacted, tokensAfter: 8200 }), true);
  });

  it("缺任一字段都不算——半截界碑不能当消息渲染", () => {
    for (const key of ["id", "summary", "tokensBefore", "timestamp"]) {
      strictEqual(isCompactedRecord({ ...compacted, [key]: undefined }), false, `缺 ${key}`);
    }
    strictEqual(isCompactedRecord({ ...compacted, summary: 42 }), false);
    strictEqual(isCompactedRecord({ ...compacted, tokensBefore: "many" }), false);
    strictEqual(isCompactedRecord(null), false);
    strictEqual(isCompactedRecord("compacted"), false);
  });

  it("tokensAfter 坏值整行判坏——与既有逐字段校验一致", () => {
    strictEqual(isCompactedRecord({ ...compacted, tokensAfter: "small" }), false);
  });

  it("role 冒充不算", () => {
    strictEqual(isCompactedRecord({ ...compacted, role: "assistant" }), false);
  });
});

describe("isChannelMarkRecord", () => {
  const mark = {
    role: "channel-mark" as const,
    id: "k1",
    peerId: "c1",
    messageId: "m9",
    from: "child" as const,
    kind: "question" as const,
    timestamp: 3,
  };

  it("完整的一条原样认出；from / kind 两侧的合法值都认", () => {
    strictEqual(isChannelMarkRecord(mark), true);
    strictEqual(isChannelMarkRecord({ ...mark, from: "parent", kind: "task" }), true);
    strictEqual(isChannelMarkRecord({ ...mark, kind: "done" }), true);
    strictEqual(isChannelMarkRecord({ ...mark, kind: "failed" }), true);
    strictEqual(isChannelMarkRecord({ ...mark, kind: "reply" }), true);
    strictEqual(isChannelMarkRecord({ ...mark, kind: "progress" }), true);
  });

  it("缺任一字段都不算——半截标记不能当消息强转", () => {
    for (const key of ["id", "peerId", "messageId", "from", "kind", "timestamp"]) {
      strictEqual(isChannelMarkRecord({ ...mark, [key]: undefined }), false, `缺 ${key}`);
    }
    strictEqual(isChannelMarkRecord({ ...mark, timestamp: "soon" }), false);
    strictEqual(isChannelMarkRecord(null), false);
    strictEqual(isChannelMarkRecord("channel-mark"), false);
  });

  it("from 只认 parent / child；kind 只认六种——手改出来的其它值整行判坏", () => {
    strictEqual(isChannelMarkRecord({ ...mark, from: "sibling" }), false);
    strictEqual(isChannelMarkRecord({ ...mark, kind: "notice" }), false);
  });

  it("role 冒充不算", () => {
    strictEqual(isChannelMarkRecord({ ...mark, role: "user" }), false);
  });
});

describe("transcriptToMarkdown 的压缩界碑", () => {
  const compacted = {
    role: "compacted" as const,
    id: "c1",
    summary: "## Goal\n重做外壳\n## Done\n一半",
    tokensBefore: 85000,
    timestamp: 3,
  };
  const user = {
    id: "u1",
    role: "user" as const,
    content: [{ type: "text" as const, text: "继续" }],
    timestamp: 4,
  };

  it("界碑出标记行 + 引用块摘要，不冒充 User / Assistant", () => {
    const md = transcriptToMarkdown([compacted, user]);
    match(md, /\*\*\[Compacted\]\*\* \(earlier context ≈ 85,000 tokens\)/);
    match(md, /> ## Goal\n> 重做外壳\n> ## Done\n> 一半/);
    match(md, /\*\*User\*\*\n\n继续/);
    doesNotMatch(md, /\*\*Assistant\*\*/);
  });

  it("摘要首尾空白先修掉再进引用块", () => {
    const md = transcriptToMarkdown([{ ...compacted, summary: "\n 摘要 \n" }]);
    match(md, /> 摘要/);
    doesNotMatch(md, /> \n/);
  });
});

describe("transcriptToMarkdown 的工具结果", () => {
  const tool = {
    id: "t1",
    role: "tool" as const,
    toolCallId: "tc1",
    toolName: "bash",
    input: { command: "ls src" },
    content: [{ type: "text" as const, text: "main.ts\nstyles.css" }],
    timestamp: 3,
    status: "complete" as const,
    isError: false as const,
  };

  it("自成一块：带工具名与输出，不再冒充 Assistant", () => {
    const md = transcriptToMarkdown([tool]);
    match(md, /\*\*Tool · bash\*\*/);
    match(md, /```text\nmain\.ts\nstyles\.css\n```/);
    doesNotMatch(md, /\*\*Assistant\*\*/);
  });

  it("失败的条目看得出失败", () => {
    const md = transcriptToMarkdown([
      { ...tool, status: "error" as const, isError: true, content: [{ type: "text" as const, text: "command not found" }] },
    ]);
    match(md, /\*\*Tool · bash\*\* \(failed\)/);
    match(md, /command not found/);
  });

  it("超长输出截断并标注真实行数", () => {
    const text = Array.from({ length: 120 }, (_, i) => `line-${i}`).join("\n");
    const md = transcriptToMarkdown([{ ...tool, content: [{ type: "text" as const, text }] }]);
    match(md, /… \(truncated, 120 lines in total\)/);
    doesNotMatch(md, /line-119/);
  });

  it("图片占位、空输出不空块", () => {
    const md = transcriptToMarkdown([
      { ...tool, content: [{ type: "image" as const, data: "xx", mimeType: "image/png" }] },
    ]);
    match(md, /\[image image\/png\]/);
    match(transcriptToMarkdown([{ ...tool, content: [] }]), /\(no output\)/);
  });
});

// ── 刀 A-1：用量快照落盘（A1-Q1 裁决 2026-09-03）──

describe("parseAgentStats —— 半份账本比没有账本更容易骗人", () => {
  const raw = {
    tokens: { input: 18200, output: 4100, cacheRead: 120000, cacheWrite: 5100, total: 147400 },
    cost: 0.062,
    contextUsage: { tokens: 18200, contextWindow: 200000, percent: 9 },
  };

  it("完整的一份原样解出来", () => {
    deepStrictEqual(parseAgentStats(raw), raw);
  });

  it("缺一项 token 就整条丢——缺的那行会显示成 0，而 0 的意思是「真没用」", () => {
    const { cacheRead: _drop, ...rest } = raw.tokens;
    strictEqual(parseAgentStats({ ...raw, tokens: rest }), null);
  });

  it("缺 cost 整条丢", () => {
    const { cost: _drop, ...rest } = raw;
    strictEqual(parseAgentStats(rest), null);
  });

  it("NaN / Infinity 不算数字——进了界面就是一行胡话", () => {
    strictEqual(parseAgentStats({ ...raw, cost: Number.NaN }), null);
    strictEqual(
      parseAgentStats({ ...raw, tokens: { ...raw.tokens, total: Number.POSITIVE_INFINITY } }),
      null,
    );
  });

  it("contextUsage 缺席不连累账本：单独为 null", () => {
    const { contextUsage: _drop, ...rest } = raw;
    deepStrictEqual(parseAgentStats(rest), { ...raw, contextUsage: null });
  });

  it("压缩刚完那一刻的快照：tokens 为 null 但窗口还在", () => {
    const usage = { tokens: null, contextWindow: 200000, percent: null };
    deepStrictEqual(parseAgentStats({ ...raw, contextUsage: usage })?.contextUsage, usage);
  });

  it("contextWindow 都没有就当没有占用", () => {
    strictEqual(parseAgentStats({ ...raw, contextUsage: { tokens: 1 } })?.contextUsage, null);
  });

  it("不是对象一律 null", () => {
    strictEqual(parseAgentStats(null), null);
    strictEqual(parseAgentStats("stats"), null);
  });
});

describe("parseSessionMeta 的 stats 字段", () => {
  it("旧会话没有这个字段：当作没有账本，不丢整条会话", () => {
    strictEqual(parseSessionMeta(valid)?.stats, null);
  });

  it("坏账本也只丢账本", () => {
    const meta = parseSessionMeta({ ...valid, stats: { cost: "免费" } });
    notStrictEqual(meta, null);
    strictEqual(meta?.stats, null);
  });
});

describe("引用块不进标题与导出正文", () => {
  const quoted =
    '<quoted_context source="agent-history" label="x" message_id="m" role="assistant" turn="1">\n被引用的话\n</quoted_context>\n\n我的问题';

  it("标题取用户自己的话，不是引用标签", () => {
    strictEqual(deriveSessionTitle(quoted), "我的问题");
    deepStrictEqual(pushRecentQuery([], quoted), ["我的问题"]);
  });

  it("导出时引用成为引用段落", () => {
    const md = transcriptToMarkdown([{ id: "u", role: "user", content: [{ type: "text", text: quoted }], timestamp: 1 }]);
    match(md, /> 被引用的话\n\n我的问题/);
    doesNotMatch(md, /quoted_context/);
  });
});
