/**
 * 上下文面板数据推导的测试：各来源识别、目录归组、cwd 内外标注、压缩灰显判定、
 * 轮视野裁剪、token 估算口径、空会话、规则组换算。
 */
import { deepStrictEqual, equal, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ContextRulesInventory } from "./agent-ipc.ts";
import {
  buildContextInventory,
  countCharKinds,
  estimateContextTokens,
  estimateTokensFromCounts,
  IMAGE_TOKEN_ESTIMATE,
} from "./context-inventory.ts";
import type { CompactedRecord, ChannelMarkRecord, TranscriptRecord } from "./session.ts";
import { buildRulesInventory } from "./context-inventory.ts";

const CWD = "/ws/proj";

let seq = 0;
function userItem(text: string, blocks?: string[], images = 0): TranscriptRecord {
  seq += 1;
  const content: Record<string, unknown>[] = [
    ...(blocks ?? [text]).map((block) => ({ type: "text", text: block })),
    ...Array.from({ length: images }, () => ({ type: "image", data: "xx", mimeType: "image/png" })),
  ];
  return {
    id: `u${seq}`,
    role: "user",
    content: content as never,
    timestamp: seq,
  } as TranscriptRecord;
}

function toolItem(toolName: string, input: Record<string, unknown>, text: string, details?: Record<string, unknown>): TranscriptRecord {
  seq += 1;
  return {
    id: `t${seq}`,
    role: "tool",
    toolCallId: `tc${seq}`,
    toolName,
    input,
    content: [{ type: "text", text }],
    timestamp: seq,
    status: "complete",
    isError: false,
    ...(details === undefined ? null : { details }),
  } as TranscriptRecord;
}

function assistantItem(): TranscriptRecord {
  seq += 1;
  return {
    id: `a${seq}`,
    role: "assistant",
    content: [{ type: "text", text: "好的" }],
    model: { provider: "p", id: "m" },
    timestamp: seq,
    status: "complete",
    stopReason: "stop",
  } as TranscriptRecord;
}

function compacted(): TranscriptRecord {
  seq += 1;
  return {
    role: "compacted",
    id: `c${seq}`,
    summary: "此前的一切",
    tokensBefore: 10000,
    timestamp: seq,
  } satisfies CompactedRecord;
}

function channelMark(): TranscriptRecord {
  seq += 1;
  return {
    role: "channel-mark",
    id: `m${seq}`,
    peerId: "peer",
    messageId: `msg${seq}`,
    from: "child",
    kind: "progress",
    timestamp: seq,
  } satisfies ChannelMarkRecord;
}

/** 一轮最小的「用户问 + 工具调用 + 回答」。 */
function turnWithTool(toolName: string, input: Record<string, unknown>, text = "结果内容", details?: Record<string, unknown>): TranscriptRecord[] {
  return [userItem("看一下"), toolItem(toolName, input, text, details), assistantItem()];
}

const RULES: ContextRulesInventory = {
  files: [
    { path: "/Users/me/.pi/agent/AGENTS.md", tokens: 400, scope: "global" },
    { path: "/ws/proj/AGENTS.md", tokens: 6100, scope: "project" },
  ],
  baseTokens: 8200,
  skillsIndex: { names: ["贾维斯路线图", "ORBITA：PR 验收"], tokens: 260 },
  segments: [
    { id: "permission", tokens: 180 },
    { id: "directories", tokens: 90 },
  ],
};

describe("token 估算", () => {
  it("中文 0.7/字、其余 1/4 每字符，向上取整", () => {
    // 4 个汉字：4 × 0.7 = 2.8 → 3
    strictEqual(estimateContextTokens("项目记忆"), 3);
    // 8 个 ASCII：8 / 4 = 2
    strictEqual(estimateContextTokens("readable"), 2);
    // 混排：4 汉字 + 8 ASCII = 2.8 + 2 = 4.8 → 5
    strictEqual(estimateContextTokens("项目记忆readable"), 5);
  });

  it("countCharKinds 数的是码点（emoji 算 1 个非 CJK 字符）", () => {
    deepStrictEqual(countCharKinds("汉🎉a"), { chars: 3, cjk: 1 });
    strictEqual(estimateTokensFromCounts({ chars: 0, cjk: 0 }), 0);
  });
});

describe("空会话与轮号", () => {
  it("没有任何记录：全空、轮号 0、规则组未知", () => {
    const inventory = buildContextInventory({ records: [], cwd: CWD, scope: "task" });
    strictEqual(inventory.currentTurn, 0);
    strictEqual(inventory.compactions, 0);
    equal(inventory.rules, null);
    strictEqual(inventory.attach.rows.length, 0);
    strictEqual(inventory.files.dirs.length, 0);
    strictEqual(inventory.web.rows.length, 0);
    strictEqual(inventory.tasks.rows.length, 0);
    strictEqual(inventory.mcp.rows.length, 0);
    strictEqual(inventory.skills.rows.length, 0);
  });

  it("通道投递与 user 同计轮号", () => {
    const records = [
      userItem("第一轮"),
      assistantItem(),
      channelMark(),
      toolItem("read", { path: "/ws/proj/src/a.ts" }, "内容"),
    ];
    const inventory = buildContextInventory({ records, cwd: CWD, scope: "task" });
    strictEqual(inventory.currentTurn, 2);
    strictEqual(inventory.files.dirs[0]?.rows[0]?.turn, 2);
  });
});

describe("附件组（你附带的）", () => {
  it("引用块 / 粘贴块 / 文件清单 / 图片各归各类", () => {
    const quoted = `<quoted_context index="1" role="assistant" turn="2">\n引用的原文\n</quoted_context>\n\n接着说`;
    const pasted = `<pasted-text>\n粘贴的一大段\n</pasted-text>`;
    const files = `<attached-files>\nThe user attached these files.\n- /ws/proj/design-system/readme.md\n- /ws/proj/docs/\n</attached-files>`;
    const records = [userItem(quoted, [quoted, pasted, files], 2)];
    const inventory = buildContextInventory({ records, cwd: CWD, scope: "task" });
    const kinds = inventory.attach.rows.map((row) => row.kind).sort();
    deepStrictEqual(kinds, ["file-ref", "file-ref", "image", "pasted", "quote"]);

    const quote = inventory.attach.rows.find((row) => row.kind === "quote");
    ok(quote !== undefined && quote.kind === "quote");
    strictEqual(quote.text, "引用的原文");
    strictEqual(quote.quoteTurn, 2);
    strictEqual(quote.quoteRole, "assistant");

    const pastedRow = inventory.attach.rows.find((row) => row.kind === "pasted");
    ok(pastedRow !== undefined && pastedRow.kind === "pasted");
    strictEqual(pastedRow.chars, Array.from("粘贴的一大段").length);

    const refs = inventory.attach.rows.filter((row) => row.kind === "file-ref");
    strictEqual(refs.length, 2);
    ok(refs.some((row) => row.kind === "file-ref" && row.path === "/ws/proj/design-system/readme.md" && !row.dir));
    ok(refs.some((row) => row.kind === "file-ref" && row.path === "/ws/proj/docs" && row.dir));

    const image = inventory.attach.rows.find((row) => row.kind === "image");
    strictEqual(image?.count, 2);
    strictEqual(image?.tokens, 2 * IMAGE_TOKEN_ESTIMATE);
  });
});

describe("文件组", () => {
  it("read 按目录归组：cwd 内相对路径，cwd 外标 outside", () => {
    const records = [
      ...turnWithTool("read", { path: "/ws/proj/design-system/readme.md" }, "设计系统正文"),
      ...turnWithTool("read", { path: "/ws/proj/src/shared/session.ts", offset: 1, limit: 100 }, "前一百行"),
      ...turnWithTool("read", { path: "/Users/me/logs/llama-server.log" }, "日志末尾"),
    ];
    const inventory = buildContextInventory({ records, cwd: CWD, scope: "task" });
    strictEqual(inventory.files.dirs.length, 3);

    const inside1 = inventory.files.dirs.find((dir) => dir.dir === "design-system");
    ok(inside1 !== undefined && !inside1.outside);
    strictEqual(inside1.rows[0]?.name, "readme.md");
    strictEqual(inside1.rows[0]?.path, "design-system/readme.md");
    deepStrictEqual(inside1.rows[0]?.ranges, [{ kind: "all" }]);

    const inside2 = inventory.files.dirs.find((dir) => dir.dir === "src/shared");
    deepStrictEqual(inside2?.rows[0]?.ranges, [{ kind: "lines", from: 1, to: 100 }]);

    const outside = inventory.files.dirs.find((dir) => dir.outside);
    ok(outside !== undefined);
    strictEqual(outside.dir, "/Users/me/logs");
    strictEqual(outside.rows[0]?.path, "/Users/me/logs/llama-server.log");
  });

  it("同一文件多次读取合并成一行、范围去重追加", () => {
    const records = [
      ...turnWithTool("read", { path: "/ws/proj/a.ts" }, "一段"),
      ...turnWithTool("read", { path: "/ws/proj/a.ts", offset: 200, limit: 50 }, "另一段"),
      ...turnWithTool("read", { path: "/ws/proj/a.ts" }, "再读全文"),
    ];
    const inventory = buildContextInventory({ records, cwd: CWD, scope: "task" });
    const rows = inventory.files.dirs.find((dir) => dir.dir === ".")?.rows ?? [];
    strictEqual(rows.length, 1);
    deepStrictEqual(rows[0]?.ranges, [{ kind: "all" }, { kind: "lines", from: 200, to: 249 }]);
    strictEqual(rows[0]?.turn, 1);
  });

  it("read_pdf 记页范围；SKILL.md 的读取归技能组不归文件组", () => {
    const records = [
      ...turnWithTool("read_pdf", { path: "/ws/proj/paper.pdf", offset: 3, limit: 5 }, "九页正文"),
      ...turnWithTool("read", { path: "/store/skills/jarvis-roadmap/SKILL.md" }, "技能正文"),
    ];
    const inventory = buildContextInventory({ records, cwd: CWD, scope: "task" });
    const pdf = inventory.files.dirs.find((dir) => dir.dir === ".")?.rows[0];
    strictEqual(pdf?.name, "paper.pdf");
    deepStrictEqual(pdf?.ranges, [{ kind: "pages", from: 3, to: 7 }]);
    strictEqual(inventory.files.dirs.reduce((n, dir) => n + dir.rows.length, 0), 1);

    const skill = inventory.skills.rows[0];
    strictEqual(skill?.name, "jarvis-roadmap");
    strictEqual(skill?.how, "read");
  });

  it("读取范围：pdf 不给范围 = 默认窗口；只给起点 = 开区间", () => {
    const records = [
      ...turnWithTool("read_pdf", { path: "/ws/proj/b.pdf" }, "默认窗口"),
      ...turnWithTool("read", { path: "/ws/proj/c.ts", offset: 40 }, "从 40 行起"),
    ];
    const inventory = buildContextInventory({ records, cwd: CWD, scope: "task" });
    const rows = inventory.files.dirs.flatMap((dir) => dir.rows);
    deepStrictEqual(rows.find((row) => row.name === "b.pdf")?.ranges, [{ kind: "pages-default" }]);
    deepStrictEqual(rows.find((row) => row.name === "c.ts")?.ranges, [{ kind: "lines", from: 40, to: null }]);
  });

  it("grep / find / ls 不进文件行，按工具小计", () => {
    const records = [
      ...turnWithTool("grep", { pattern: "compaction" }, "命中 17 行"),
      ...turnWithTool("ls", { path: "/ws/proj/src" }, "目录清单"),
      ...turnWithTool("ls", { path: "/ws/proj/src" }, "目录清单"),
    ];
    const inventory = buildContextInventory({ records, cwd: CWD, scope: "task" });
    strictEqual(inventory.files.dirs.length, 0);
    const ls = inventory.files.searches.find((note) => note.tool === "ls");
    const grep = inventory.files.searches.find((note) => note.tool === "grep");
    strictEqual(ls?.count, 2);
    strictEqual(grep?.count, 1);
    ok(inventory.files.tokens > 0);
  });
});

describe("网页组", () => {
  it("browser_navigate 一页一行：url/标题取结果卡，域名派生；其余浏览器工具不另开行", () => {
    const card = { browser: { tabId: "tab1", url: "https://example.com/docs", title: "Example Docs" } };
    const records = [
      userItem("查一下"),
      toolItem("browser_navigate", { url: "example.com" }, "页面已加载", card),
      toolItem("browser_extract", { format: "markdown" }, "页面正文很长", card),
      assistantItem(),
    ];
    const inventory = buildContextInventory({ records, cwd: CWD, scope: "task" });
    strictEqual(inventory.web.rows.length, 1);
    const row = inventory.web.rows[0];
    strictEqual(row?.url, "https://example.com/docs");
    strictEqual(row?.title, "Example Docs");
    strictEqual(row?.domain, "example.com");
    // extract 的结果 token 并进该页这一行
    ok(row !== undefined && row.tokens > estimateContextTokens("页面已加载"));
  });

  it("back / forward 不开新页，结果记到当前页", () => {
    const card = { browser: { tabId: "t", url: "https://a.example/1", title: "A" } };
    const records = [
      userItem("翻回去"),
      toolItem("browser_navigate", { url: "https://a.example/1" }, "已加载", card),
      toolItem("browser_navigate", { url: "back" }, "已后退", card),
      assistantItem(),
    ];
    const inventory = buildContextInventory({ records, cwd: CWD, scope: "task" });
    strictEqual(inventory.web.rows.length, 1);
    strictEqual(inventory.web.rows[0]?.url, "https://a.example/1");
  });
});

describe("其他会话组", () => {
  it("read_task：标题与轮号来自结果卡，同目标多次调用合并", () => {
    const card = (title: string) => ({ readTask: { sessionId: "s1", title, mode: "briefing", roundCount: 40 } });
    const records = [
      userItem("看看那个任务"),
      toolItem("read_task", { task: "记忆系统调研" }, "头部与目录", card("记忆系统调研")),
      toolItem("read_task", { task: "记忆系统调研", rounds: "3,2-5" }, "指定轮全文", card("记忆系统调研")),
      assistantItem(),
    ];
    const inventory = buildContextInventory({ records, cwd: CWD, scope: "task" });
    strictEqual(inventory.tasks.rows.length, 1);
    const row = inventory.tasks.rows[0];
    strictEqual(row?.ref, "记忆系统调研");
    strictEqual(row?.title, "记忆系统调研");
    strictEqual(row?.external, false);
    deepStrictEqual(row?.rounds, ["3,2-5"]);
  });

  it("目录模式（不带 task）与外部会话（ext:）都能识别", () => {
    const records = [
      ...turnWithTool("read_task", {}, "工作区任务列表"),
      ...turnWithTool("read_task", { task: "ext:kimi-work:abc" }, "外部会话正文"),
    ];
    const inventory = buildContextInventory({ records, cwd: CWD, scope: "task" });
    strictEqual(inventory.tasks.rows.length, 2);
    ok(inventory.tasks.rows.some((row) => row.catalog));
    const ext = inventory.tasks.rows.find((row) => row.external);
    strictEqual(ext?.ref, "ext:kimi-work:abc");
    equal(ext?.catalog, false);
  });
});

describe("MCP 组", () => {
  it("mcp__server__tool 拆出 server 与工具名，检索词取常见入参键", () => {
    const records = [
      ...turnWithTool("mcp__miyo__search", { query: "QUMem 记忆系统" }, "17 条结果"),
      ...turnWithTool("mcp__web-search-prime__web_search_prime", { search_query: "jina license" }, "搜索结果"),
      ...turnWithTool("read", { path: "/ws/proj/b.ts" }, "普通读取"),
    ];
    const inventory = buildContextInventory({ records, cwd: CWD, scope: "task" });
    strictEqual(inventory.mcp.rows.length, 2);
    const miyo = inventory.mcp.rows.find((row) => row.server === "miyo");
    strictEqual(miyo?.tool, "search");
    strictEqual(miyo?.query, "QUMem 记忆系统");
    strictEqual(miyo?.calls, 1);
    ok(inventory.mcp.rows.every((row) => row.server !== ""));
    // 普通工具不误入
    strictEqual(inventory.files.dirs.length, 1);
  });

  it("同一 server›tool 多次调用合并并计次数，检索词取最后一次非空的", () => {
    const records = [
      ...turnWithTool("mcp__miyo__search", { query: "第一次" }, "结果一"),
      ...turnWithTool("mcp__miyo__search", { query: "第二次" }, "结果二"),
    ];
    const inventory = buildContextInventory({ records, cwd: CWD, scope: "task" });
    strictEqual(inventory.mcp.rows.length, 1);
    strictEqual(inventory.mcp.rows[0]?.calls, 2);
    strictEqual(inventory.mcp.rows[0]?.query, "第二次");
  });
});

describe("技能组", () => {
  it("/skill: 点名进技能组；旧格式 <skill> 块也认", () => {
    const records = [
      userItem("/skill:贾维斯路线图 我们走到哪一步了"),
      assistantItem(),
      userItem('<skill name="旧技能">\n旧正文\n</skill>'),
      assistantItem(),
    ];
    const inventory = buildContextInventory({ records, cwd: CWD, scope: "task" });
    const names = inventory.skills.rows.map((row) => row.name).sort();
    deepStrictEqual(names, ["jarvis-roadmap".replace("jarvis-roadmap", "贾维斯路线图"), "旧技能"].sort());
    ok(inventory.skills.rows.every((row) => row.how === "invoked"));
  });
});

describe("压缩灰显与视野", () => {
  it("最后一条界碑之前的条目 gone，之后的不是；多次压缩只认最后一条", () => {
    const records = [
      ...turnWithTool("read", { path: "/ws/proj/old.ts" }, "很早读的"),
      compacted(),
      ...turnWithTool("read", { path: "/ws/proj/mid.ts" }, "中间读的"),
      compacted(),
      ...turnWithTool("read", { path: "/ws/proj/new.ts" }, "最近读的"),
    ];
    const inventory = buildContextInventory({ records, cwd: CWD, scope: "task" });
    strictEqual(inventory.compactions, 2);
    const rowOf = (name: string) =>
      inventory.files.dirs.flatMap((dir) => dir.rows).find((row) => row.name === name);
    strictEqual(rowOf("old.ts")?.gone, true);
    // 中间那条在最后一条界碑之前：同样视为已出上下文
    strictEqual(rowOf("mid.ts")?.gone, true);
    strictEqual(rowOf("new.ts")?.gone, false);
  });

  it("同一文件跨压缩界碑：只要还有一次在界碑后就不灰显", () => {
    const records = [
      ...turnWithTool("read", { path: "/ws/proj/a.ts" }, "压缩前读的"),
      compacted(),
      ...turnWithTool("read", { path: "/ws/proj/a.ts" }, "压缩后读的"),
    ];
    const inventory = buildContextInventory({ records, cwd: CWD, scope: "task" });
    const row = inventory.files.dirs.flatMap((dir) => dir.rows).find((r) => r.name === "a.ts");
    strictEqual(row?.gone, false);
    strictEqual(row?.turn, 1);
    // 量只算还在上下文里的那次：压缩前那次已折进摘要，算进来会虚高
    strictEqual(row?.tokens, estimateContextTokens("压缩后读的"));
  });

  it("全部出现都已压缩：报当时的总量（灰显时告诉用户曾经装过多少）", () => {
    const records = [
      ...turnWithTool("read", { path: "/ws/proj/a.ts" }, "第一次读的内容"),
      ...turnWithTool("read", { path: "/ws/proj/a.ts", offset: 5 }, "第二次"),
      compacted(),
      userItem("继续"),
    ];
    const inventory = buildContextInventory({ records, cwd: CWD, scope: "task" });
    const row = inventory.files.dirs.flatMap((dir) => dir.rows).find((r) => r.name === "a.ts");
    strictEqual(row?.gone, true);
    strictEqual(row?.tokens, estimateContextTokens("第一次读的内容") + estimateContextTokens("第二次"));
  });

  it("turn 视野只留当前轮的出现，token 按出现重算", () => {
    const long = "很长的内容".repeat(50);
    const records = [
      ...turnWithTool("read", { path: "/ws/proj/a.ts" }, long),
      ...turnWithTool("read", { path: "/ws/proj/a.ts" }, "短内容"),
    ];
    const task = buildContextInventory({ records, cwd: CWD, scope: "task" });
    const turn = buildContextInventory({ records, cwd: CWD, scope: "turn" });
    strictEqual(task.currentTurn, 2);
    const taskRow = task.files.dirs.flatMap((dir) => dir.rows).find((r) => r.name === "a.ts");
    const turnRow = turn.files.dirs.flatMap((dir) => dir.rows).find((r) => r.name === "a.ts");
    strictEqual(taskRow?.tokens, estimateContextTokens(long) + estimateContextTokens("短内容"));
    strictEqual(turnRow?.tokens, estimateContextTokens("短内容"));
    strictEqual(turnRow?.turn, 2);
    deepStrictEqual(turnRow?.ranges, [{ kind: "all" }]);
    // 第一轮独占的条目在 turn 视野里不出现
    strictEqual(turn.attach.rows.length, 0);
    strictEqual(turn.currentTurn, 2);
  });
});

describe("规则组", () => {
  it("事件清单换算成组：文件名取末段、合计 = 基底 + 追加段", () => {
    const inventory = buildContextInventory({ records: [userItem("hi")], cwd: CWD, scope: "turn", rules: RULES });
    ok(inventory.rules !== null);
    strictEqual(inventory.rules?.files.length, 2);
    deepStrictEqual(
      inventory.rules?.files.map((file) => file.name),
      ["AGENTS.md", "AGENTS.md"],
    );
    deepStrictEqual(
      inventory.rules?.files.map((file) => file.scope),
      ["global", "project"],
    );
    deepStrictEqual(inventory.rules?.skillsIndex.names, ["贾维斯路线图", "ORBITA：PR 验收"]);
    strictEqual(inventory.rules?.tokens, 8200 + 180 + 90);
  });

  it("不给清单 = null（未开过轮的旧会话）", () => {
    const inventory = buildContextInventory({ records: [userItem("hi")], cwd: CWD, scope: "turn" });
    equal(inventory.rules, null);
  });
});

describe("规则清单组装（buildRulesInventory，runtime 的产出方）", () => {
  it("基底整段估算、文件按内容估算、空串段不进清单、scope 按 agentDir 判", () => {
    const basePrompt = `pi base with <project_instructions path="/ws/proj/AGENTS.md">项目规则</project_instructions>`;
    const inventory = buildRulesInventory({
      agentsFiles: [
        { path: "/Users/me/.pi/agent/AGENTS.md", content: "全局规则" },
        { path: "/ws/proj/AGENTS.md", content: "项目规则" },
      ],
      skills: [{ name: "贾维斯路线图", description: "在 orbita 开发路线图上的任何一项时使用" }],
      basePrompt,
      segments: [
        { id: "permission", text: "权限说明" },
        { id: "git-attribution", text: "" },
      ],
      agentDir: "/Users/me/.pi/agent",
    });
    deepStrictEqual(
      inventory.files.map((file) => file.scope),
      ["global", "project"],
    );
    strictEqual(inventory.files[0]?.tokens, estimateContextTokens("全局规则"));
    strictEqual(inventory.baseTokens, estimateContextTokens(basePrompt));
    deepStrictEqual(inventory.segments.map((segment) => segment.id), ["permission"]);
    strictEqual(inventory.segments[0]?.tokens, estimateContextTokens("权限说明"));
    deepStrictEqual(inventory.skillsIndex.names, ["贾维斯路线图"]);
    strictEqual(
      inventory.skillsIndex.tokens,
      estimateContextTokens("贾维斯路线图: 在 orbita 开发路线图上的任何一项时使用"),
    );
  });
});
