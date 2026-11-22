/**
 * 「一轮一行」过程显示：分组（groupTurnsByTurn）+ 章节 / 计数 / 现场快照的推导。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import {
  flattenRenderUnits,
  groupToolUnits,
  groupTurns,
  groupTurnsByTurn,
  branchAnchorEntries,
  indexToolResults,
  unreferencedShowImages,
  questionAnswered,
  type TurnProcessUnit,
  type TurnViewEntry,
} from "./tool-results.ts";
import { goalChangesByCall } from "../context/plan-text.ts";
import type { GoalLedger } from "../../../../shared/goal-ledger.ts";
import { zh } from "../../messages-zh.ts";
import { finishedSteps, firstLine, processChapters, processCounts, processInterrupted, processLive, processOutcome } from "./turn-process.ts";

const user = (id: string, timestamp: number): TranscriptItem =>
  ({ id, role: "user", content: [{ type: "text", text: "hi" }], timestamp }) as TranscriptItem;
const assistant = (id: string, timestamp: number, blocks: unknown[]): TranscriptItem =>
  ({ id, role: "assistant", content: blocks, timestamp }) as TranscriptItem;
const tool = (o: Partial<ToolTranscriptItem> & Pick<ToolTranscriptItem, "toolCallId">): TranscriptItem =>
  ({ id: `item-${o.toolCallId}`, role: "tool", toolName: "read", input: {}, content: [], timestamp: 0, status: "complete", isError: false, ...o }) as TranscriptItem;
const call = (id: string, toolName = "read", input: unknown = { path: `${id}.ts` }) => ({ type: "toolCall", toolCallId: id, toolName, input });

function view(records: readonly TranscriptItem[], active: boolean): TurnViewEntry[] {
  return groupTurnsByTurn(groupToolUnits(flattenRenderUnits(records)), active, indexToolResults(records));
}
const procOf = (v: readonly TurnViewEntry[]) => v.filter((e): e is TurnProcessUnit => e.kind === "turnProcess");

// 一轮：旁白 → 读 → 旁白 → bash（失败）→ 写 → 结尾回答
const turn = [
  user("u1", 1000),
  assistant("a1", 2000, [{ type: "text", text: "我先读一下代码。" }, call("r1")]),
  tool({ toolCallId: "r1", timestamp: 2600 }),
  assistant("a2", 3000, [{ type: "thinking", thinking: "看测试\n再跑" }, { type: "text", text: "接下来跑一遍检查。" }, call("b1", "bash", { command: "ls x" })]),
  tool({ toolCallId: "b1", toolName: "bash", timestamp: 3400, status: "error" }),
  assistant("a3", 4000, [call("w1", "write", { path: "notes/a.md" })]),
  tool({ toolCallId: "w1", toolName: "write", timestamp: 4100 }),
  assistant("a4", 5000, [{ type: "text", text: "查完了。" }]),
];

describe("groupTurnsByTurn", () => {
  test("落定轮：旁白收进块当章节，一轮一个块，结尾回答留在外面", () => {
    const v = view(turn, false);
    assert.deepEqual(v.map((e) => e.kind), ["user", "turnProcess", "text"]);
    const [proc] = procOf(v);
    assert.ok(proc !== undefined);
    assert.equal(proc.live, false);
    // 第一个工具之前的旁白也收进块（当第一段的段名），不再露在过程行上面
    assert.deepEqual(proc.steps.map((s) => s.kind), ["text", "toolCall", "thinking", "text", "toolCall", "toolCall"]);
    assert.equal(proc.durationMs, 4100 - 2000);
  });

  test("活跃轮：块是 live；块后已有正文在流 = answering", () => {
    const live = turn.slice(0, 5);
    const [proc] = procOf(view(live, true));
    assert.equal(proc?.live, true);
    assert.equal(proc?.answering, false);
    const [answering] = procOf(view(turn, true));
    assert.equal(answering?.answering, true);
  });

  test("旁白在思考之后、第一个工具之前：照样收进块，思考跟着它走", () => {
    const records = [
      user("u1", 1),
      assistant("a1", 2, [{ type: "thinking", thinking: "想想" }, { type: "text", text: "开始跑完整测试。" }, call("b1", "bash", { command: "bun test" })]),
      tool({ toolCallId: "b1", toolName: "bash", timestamp: 3 }),
      assistant("a2", 4, [{ type: "text", text: "跑完了。" }]),
    ];
    const v = view(records, false);
    assert.deepEqual(v.map((e) => e.kind), ["user", "turnProcess", "text"]);
    const chapters = processChapters(procOf(v)[0]?.steps ?? []);
    assert.deepEqual(chapters.map((c) => [c.source, c.title]), [["say", "开始跑完整测试。"]]);
  });

  test("没有工具的轮：开头的正文就是回答，不收（没有过程块）", () => {
    const v = view([user("u1", 1), assistant("a1", 2, [{ type: "text", text: "直接答。" }])], false);
    assert.deepEqual(v.map((e) => e.kind), ["user", "text"]);
  });

  test("还没调工具的活跃轮没有块（只有正文在流）", () => {
    const v = view([user("u1", 1), assistant("a1", 2, [{ type: "text", text: "好的" }])], true);
    assert.deepEqual(v.map((e) => e.kind), ["user", "text"]);
  });

  test("key 从活跃到落定不变（展开状态保得住）", () => {
    assert.equal(procOf(view(turn, true))[0]?.key, procOf(view(turn, false))[0]?.key);
  });
});

describe("章节与计数", () => {
  const results = indexToolResults(turn);
  const proc = procOf(view(turn, false))[0];
  assert.ok(proc !== undefined);

  test("按说的话切章；第一个工具之前的旁白就是第一段的段名", () => {
    const chapters = processChapters(proc.steps);
    assert.deepEqual(
      chapters.map((c) => [c.source, c.title, c.calls.map((x) => x.toolCallId)]),
      [
        ["say", "我先读一下代码。", ["r1"]],
        ["say", "接下来跑一遍检查。", ["b1", "w1"]],
      ],
    );
  });

  test("没有旁白时，章标题取第一段思考的第一行", () => {
    const steps = procOf(view([user("u", 1), assistant("a", 2, [{ type: "thinking", thinking: "\n## 先看结构\n细节" }, call("r")]), tool({ toolCallId: "r", timestamp: 3 }), assistant("z", 4, [{ type: "text", text: "好" }])], false))[0]?.steps ?? [];
    assert.deepEqual(processChapters(steps).map((c) => [c.source, c.title]), [["think", "先看结构"]]);
  });

  test("计数：步数、按工具、失败、写过的文件（失败的写不算）", () => {
    const counts = processCounts(proc.steps, results);
    assert.equal(counts.steps, 3);
    assert.equal(counts.failed, 1);
    assert.deepEqual(counts.files, ["notes/a.md"]);
    // 这里写的是 notes/a.md：落在文档文件上的 write 单算「doc_write」（统计行写「写文档」），其余照旧
    assert.deepEqual(counts.byTool.map((b) => b.key).sort(), ["bash", "doc_write", "read"]);
  });

  test("写计划不算一步", () => {
    const records = [user("u", 1), assistant("a", 2, [call("p", "update_plan", { items: [] }), call("r")]), tool({ toolCallId: "p", toolName: "update_plan", timestamp: 3 }), tool({ toolCallId: "r", timestamp: 3 }), assistant("z", 4, [{ type: "text", text: "好" }])];
    const steps = procOf(view(records, false))[0]?.steps ?? [];
    const counts = processCounts(steps, indexToolResults(records));
    assert.equal(counts.steps, 1);
    assert.deepEqual(counts.byTool.map((b) => b.key), ["read"]);
  });

  test("firstLine 剥 markdown 前缀", () => {
    assert.equal(firstLine("\n- 一条"), "一条");
    assert.equal(firstLine("   "), null);
  });
});

describe("processLive", () => {
  test("有工具没结果 = 在跑这一步；最近完成的几步按旧到新", () => {
    const records = [...turn.slice(0, 5), assistant("a3", 4000, [call("w1", "write", { path: "n.md" })])];
    const proc = procOf(view(records, true))[0];
    assert.ok(proc !== undefined);
    const live = processLive(proc, indexToolResults(records), () => 3900);
    assert.equal(live.now.kind, "tool");
    assert.deepEqual(live.trail.map((x) => [x.call.toolCallId, x.failed]), [["r1", false], ["b1", true]]);
    assert.deepEqual(live.chapter, { title: "接下来跑一遍检查。", source: "say" });
  });

  test("没有工具在跑 = 在想，从最后一个事件起算", () => {
    const records = turn.slice(0, 7);
    const proc = procOf(view(records, true))[0];
    assert.ok(proc !== undefined);
    const live = processLive(proc, indexToolResults(records), () => null);
    assert.deepEqual(live.now, { kind: "think", since: 4100, preview: null });
  });
});

describe("processOutcome —— 落定那一行开头说什么（不写「0 步」）", () => {
  test("纯思考的一轮（想了就答）：说想了想，不是 0 步", () => {
    const records = [user("u", 1), assistant("a", 2, [{ type: "thinking", thinking: "想一想" }, { type: "text", text: "答" }])];
    const proc = procOf(view(records, false))[0];
    assert.ok(proc !== undefined, "纯思考的轮也有一块过程（思考是过程的一步）——否则这条考题测不到");
    const counts = processCounts(proc.steps, indexToolResults(records));
    assert.equal(counts.steps, 0);
    assert.deepEqual(processOutcome(counts, proc.steps), { kind: "thought" });
  });

  test("只写了计划的一轮：说更新了计划", () => {
    const records = [user("u", 1), assistant("a", 2, [call("p", "update_plan", { items: [] })]), tool({ toolCallId: "p", toolName: "update_plan", timestamp: 3 }), assistant("z", 4, [{ type: "text", text: "好" }])];
    const proc = procOf(view(records, false))[0];
    assert.ok(proc !== undefined);
    assert.deepEqual(processOutcome(processCounts(proc.steps, indexToolResults(records)), proc.steps), { kind: "plan" });
  });

  test("跑过工具：步数与写过的文件照旧", () => {
    const results = indexToolResults(turn);
    const proc = procOf(view(turn, false))[0];
    assert.ok(proc !== undefined);
    assert.deepEqual(processOutcome(processCounts(proc.steps, results), proc.steps), { kind: "work", steps: 3, files: 1 });
  });
});

describe("show_image 的图归回答（不再钉在回答前面）", () => {
  const shown = (extra: TranscriptItem[] = []): TranscriptItem[] => [
    user("u1", 1000),
    assistant("a1", 2000, [{ type: "text", text: "我看看图。" }, call("r1")]),
    tool({ toolCallId: "r1", timestamp: 2100 }),
    assistant("a2", 3000, [call("si", "show_image", { paths: ["/w/a.png"] })]),
    tool({ toolCallId: "si", toolName: "show_image", timestamp: 3100, details: { showImage: { images: [{ data: "AAAA", mimeType: "image/png", name: "a.png" }] } } }),
    assistant("a3", 4000, [{ type: "text", text: "这是结果。" }]),
    ...extra,
  ];
  test("图挂在回答正文之后；文件卡仍殿后", () => {
    const fileTurn = { role: "file-turn", id: "ft1", timestamp: 5500, changes: [] } as unknown as TranscriptItem;
    const v = view(shown([fileTurn]), false);
    assert.deepEqual(v.map((e) => e.kind), ["user", "turnProcess", "text", "toolCall", "fileTurn"]);
    assert.equal((v[3] as { toolName?: string }).toolName, "show_image");
  });

  test("复制 / 分支那一行排在图之后", () => {
    const records = shown();
    const v = view(records, false);
    const anchors = branchAnchorEntries(new Set(["a3"]), v);
    // 回答（a3 的正文）下标 2，图在 3：按钮行挂到图之后
    assert.deepEqual([...anchors.entries()], [[3, "a3"]]);
  });

  const result = (names: string[]): ToolTranscriptItem =>
    ({ id: "x", role: "tool", toolCallId: "si", toolName: "show_image", input: {}, content: [], timestamp: 1, status: "complete", isError: false, details: { showImage: { images: names.map((name) => ({ data: "AAAA", mimeType: "image/png", name })) } } }) as ToolTranscriptItem;

  test("回答里引用了同一路径的图不重复画；没引用的留下", () => {
    const calls = [{ input: { paths: ["/w/a.png", "/w/b.png"] }, result: result(["a.png", "b.png"]) }];
    const left = unreferencedShowImages(calls, ["看这张：\n\n![甲](</w/a.png>)\n\n它是甲。"], "/w");
    assert.deepEqual(left.map((entry) => entry.image.name), ["b.png"]);
  });

  test("相对路径、含空格 / 中文的路径、file:// 都能对上", () => {
    const calls = [{ input: { paths: ["shots/一 二.png"] }, result: result(["一 二.png"]) }];
    assert.equal(unreferencedShowImages(calls, ["![x](<shots/一 二.png>)"], "/w").length, 0);
    assert.equal(unreferencedShowImages(calls, ["![x](file:///w/shots/%E4%B8%80%20%E4%BA%8C.png)"], "/w").length, 0);
  });

  test("路径对不上 / 没引用 / 远程图：当没画，宁可多画一张", () => {
    const calls = [{ input: { paths: ["/w/a.png"] }, result: result(["a.png"]) }];
    assert.equal(unreferencedShowImages(calls, ["没有图"], "/w").length, 1);
    assert.equal(unreferencedShowImages(calls, ["![x](/other/a.png)"], "/w").length, 1);
    assert.equal(unreferencedShowImages(calls, ["![x](https://e.com/w/a.png)"], "/w").length, 1);
  });

  test("失败 / 还在跑的 show_image 没有图", () => {
    const running = { ...result(["a.png"]), status: "running" } as ToolTranscriptItem;
    assert.equal(unreferencedShowImages([{ input: { paths: ["/w/a.png"] }, result: running }], [], "/w").length, 0);
  });
});

describe("钉住的看板 / 画廊不随轮尾文件卡换位（2026-11-06：看板回复完变灰 not found）", () => {
  // 插件跑完写了数据文件：轮结束后才补进一张「N 个文件已更改」卡。补卡前后看板的位置必须不变——
  // 换位 = React 搬动它的 DOM 节点 = iframe 重新加载，而看板卡地址是一次性的，重载拿到 404
  const board = [
    user("u1", 1000),
    assistant("a1", 2000, [{ type: "text", text: "我先读技能。" }, call("r1")]),
    tool({ toolCallId: "r1", timestamp: 2100 }),
    assistant("a2", 3000, [call("b1", "bash", { command: "python run.py" })]),
    tool({ toolCallId: "b1", toolName: "bash", timestamp: 3100 }),
    assistant("a3", 4000, [call("sb", "show_plugin_board", { plugin: "lit" })]),
    tool({ toolCallId: "sb", toolName: "show_plugin_board", timestamp: 4100, details: { pluginBoard: { plugin: "lit", displayName: "Lit", title: "Lit", source: "installed", draftPath: null, at: 4100, tuned: false, cards: [], skipped: [] } } }),
    assistant("a4", 5000, [{ type: "text", text: "看板在上面。" }]),
  ];
  const fileTurn = { role: "file-turn", id: "ft1", timestamp: 5500, changes: [] } as unknown as TranscriptItem;
  for (const [name, group] of [["一轮一行", groupTurnsByTurn], ["逐步铺开", groupTurns]] as const) {
    test(`${name}：有文件卡时看板仍在结尾回复之前，文件卡殿后`, () => {
      const keys = (records: readonly TranscriptItem[]) =>
        group(groupToolUnits(flattenRenderUnits(records)), false, indexToolResults(records)).map((e) => e.key);
      const before = keys(board);
      const after = keys([...board, fileTurn]);
      const boardAt = after.indexOf("a3:0");
      assert.ok(boardAt >= 0 && boardAt < after.indexOf("a4:0"), `看板应在回复前：${after.join(" ")}`);
      assert.equal(after[after.length - 1], "ft1");
      // 补卡只在末尾追加，其余顺序与补卡前逐个相同（React 不搬动任何已有节点）
      assert.deepEqual(after.slice(0, -1), before);
    });
  }
});

describe("被打断的一轮（过程行写「被你打断」）", () => {
  test("有工具调用在被打断集合里 = 这一轮被打断；没有 = 正常", () => {
    const proc = procOf(view(turn, false))[0];
    assert.ok(proc !== undefined);
    assert.equal(processInterrupted(proc.steps, new Set()), false);
    assert.equal(processInterrupted(proc.steps, new Set(["w1"])), true);
    assert.equal(processInterrupted(proc.steps, new Set(["别的轮的调用"])), false);
  });
});

describe("批量网页变动并进结尾那摞（不再是文件账里的一句说明）", () => {
  const withBatch = (changes: unknown[]) =>
    [
      user("u1", 1),
      assistant("a1", 2, [call("b1", "bash", { command: "python export.py" })]),
      tool({ toolCallId: "b1", toolName: "bash", timestamp: 3 }),
      assistant("a2", 4, [{ type: "text", text: "导完了。" }]),
      { role: "file-turn", id: "ft1", timestamp: 5, changes, webArtifactsBatch: 37 } as unknown as TranscriptItem,
    ] as TranscriptItem[];
  test("只有批量网页变动、没有文件改动：出产物那摞，带个数", () => {
    const v = view(withBatch([]), false);
    const out = v.find((e) => e.kind === "turnOutputs");
    assert.ok(out !== undefined && out.kind === "turnOutputs");
    assert.equal(out.webBatch, 37);
    assert.deepEqual(out.web, []);
  });
  test("没有批量时 webBatch 是 0，没有别的产物就不出这一摞", () => {
    const records = withBatch([]).slice(0, 4);
    assert.equal(view(records, false).some((e) => e.kind === "turnOutputs"), false);
  });
});

describe("钉在折叠外的工具：落定后卡片数据解析不出的收进过程行（2026-11-22 用户截图：show_plugin_board 一行英文名露在折叠外）", () => {
  const board = { plugin: "p", displayName: "P", title: "P", source: "installed", draftPath: null, at: 1, tuned: false, cards: [], skipped: [] };
  const round = (toolName: string, input: unknown, details: unknown, status: "complete" | "error" | "running" = "complete") =>
    [
      user("u1", 1),
      assistant("a1", 2, [call("r1"), call("x1", toolName, input)]),
      tool({ toolCallId: "r1", timestamp: 3 }),
      tool({ toolCallId: "x1", toolName, timestamp: 4, status, ...(details === undefined ? {} : { details: details as ToolTranscriptItem["details"] }) }),
      assistant("a2", 5, [{ type: "text", text: "好了。" }]),
    ] as TranscriptItem[];
  const kinds = (records: TranscriptItem[]) => view(records, false).map((e) => e.kind);
  const insideProcess = (records: TranscriptItem[], id: string) =>
    procOf(view(records, false)).some((p) => p.steps.some((step) => step.kind === "toolCall" && step.toolCallId === id));

  test("show_plugin_board：解析成功钉在折叠外；缺 source / at（解析不出）收进过程行", () => {
    const ok = round("show_plugin_board", { plugin: "p" }, { pluginBoard: board });
    assert.equal(insideProcess(ok, "x1"), false);
    assert.ok(kinds(ok).includes("toolCall"));
    const { source: _s, at: _a, ...broken } = board;
    const bad = round("show_plugin_board", { plugin: "p" }, { pluginBoard: broken });
    assert.equal(insideProcess(bad, "x1"), true);
    assert.deepEqual(kinds(bad), ["user", "turnProcess", "text"]);
  });

  test("show_image / install_plugin / automation_update：同样，解析不出的收进过程行", () => {
    assert.equal(insideProcess(round("show_image", { paths: ["/a.png"] }, { showImage: { images: [] } }), "x1"), true);
    assert.equal(insideProcess(round("show_image", { paths: ["/a.png"] }, { showImage: { images: [{ data: "AAAA", mimeType: "image/png", name: "a.png" }] } }), "x1"), false);
    assert.equal(insideProcess(round("install_plugin", { path: "/p" }, undefined), "x1"), true);
    assert.equal(insideProcess(round("automation_update", { id: "a" }, undefined), "x1"), true);
  });

  test("还在跑 / 报错的照旧留在外面（报错的红行要让用户看见）；delegate / request_user_action 不受解析影响", () => {
    assert.equal(insideProcess(round("show_plugin_board", { plugin: "p" }, undefined, "running"), "x1"), false);
    assert.equal(insideProcess(round("show_plugin_board", { plugin: "p" }, undefined, "error"), "x1"), false);
    assert.equal(insideProcess(round("install_plugin", { path: "/p" }, undefined, "error"), "x1"), false);
    assert.equal(insideProcess(round("delegate", { title: "t" }, undefined), "x1"), false);
    assert.equal(insideProcess(round("request_user_action", { reason: "r" }, undefined), "x1"), false);
  });
});

describe("改目标收进过程行", () => {
  test("goalChangesByCall：第二次 update_goal 才算改，第一次定目标不算", () => {
    const ledger = {
      entries: [
        { kind: "goal", id: "g1", at: 1, from: null, to: "做 A", why: null, by: "user", source: null },
        { kind: "goal", id: "g2", at: 2, from: "做 A", to: "做 B", why: "用户改主意", by: "user", source: null },
      ],
    } as unknown as GoalLedger;
    const changes = goalChangesByCall(zh, ledger, ["g1", "g2"]);
    assert.deepEqual([...changes.keys()], ["g2"]);
    assert.equal(changes.get("g2"), "「做 A」改成「做 B」——用户改主意");
    assert.equal(goalChangesByCall(zh, ledger, []).size, 0);
  });
});

describe("子会话交回的那一轮：结尾产物摞里带上交回的子会话", () => {
  const mark = { role: "channel-mark", id: "cm1", peerId: "child-1", messageId: "msg-1", from: "child", kind: "done", timestamp: 2 } as unknown as TranscriptItem;
  const records = [user("u1", 1), mark, assistant("a1", 3, [{ type: "text", text: "子会话交回了。" }])];
  const v = view(records, false);

  test("channelMark done 开头的一轮：结尾有 turnOutputs 单元，children 指向交回消息（没有主会话产物也有）", () => {
    const out = v.find((e) => e.kind === "turnOutputs");
    assert.ok(out !== undefined && out.kind === "turnOutputs");
    assert.deepEqual(out.children, [{ peerId: "child-1", messageId: "msg-1" }]);
    assert.equal(out.key, "out:child:msg-1");
    assert.deepEqual(v.map((e) => e.kind), ["user", "channelMark", "text", "turnOutputs"]);
  });

  test("跑着的轮也有（交回的产物不是还在写的东西），key 不变不重挂", () => {
    const live = view(records, true).find((e) => e.kind === "turnOutputs");
    assert.ok(live !== undefined);
    assert.equal(live.key, "out:child:msg-1");
  });

  test("别的种类的通道标记（问询 / 失败）不带产物", () => {
    const question = { ...mark, kind: "question" } as unknown as TranscriptItem;
    assert.equal(view([user("u1", 1), question, assistant("a1", 3, [{ type: "text", text: "好" }])], false).some((e) => e.kind === "turnOutputs"), false);
  });
});

describe("子会话来往：回复收进过程行，问询 / 失败是白卡", () => {
  const replyCall = (id: string) => call(id, "reply_subsession", { childId: "c1", text: "只看桌面端" });
  const records = (status: "complete" | "error") =>
    [
      user("u1", 1),
      assistant("a1", 2, [call("r1"), replyCall("rp1")]),
      tool({ toolCallId: "r1", timestamp: 3 }),
      tool({ toolCallId: "rp1", toolName: "reply_subsession", timestamp: 4, status }),
      assistant("a2", 5, [{ type: "text", text: "已回复。" }]),
    ] as TranscriptItem[];
  const inProcess = (v: readonly TurnViewEntry[]) =>
    procOf(v).some((p) => p.steps.some((step) => step.kind === "toolCall" && step.toolCallId === "rp1"));

  test("reply_subsession 成功：是过程里的一步，不再钉在折叠外", () => {
    const v = view(records("complete"), false);
    assert.equal(inProcess(v), true);
    assert.deepEqual(v.map((e) => e.kind), ["user", "turnProcess", "text"]);
  });

  test("reply_subsession 报错：留在折叠外（红行）", () => {
    const v = view(records("error"), false);
    assert.equal(inProcess(v), false);
    assert.ok(v.some((e) => e.kind === "toolCall" && e.toolName === "reply_subsession"));
  });

  test("report_to_parent 同样收进过程行", () => {
    const rs = [
      user("u1", 1),
      assistant("a1", 2, [call("r1"), call("rp1", "report_to_parent", { kind: "done", text: "做完了" })]),
      tool({ toolCallId: "r1", timestamp: 3 }),
      tool({ toolCallId: "rp1", toolName: "report_to_parent", timestamp: 4 }),
    ] as TranscriptItem[];
    assert.equal(inProcess(view(rs, false)), true);
  });

  test("问询 / 失败标记是白卡单元（channelMark），不进折叠", () => {
    const mark = (kind: string, id: string) => ({ role: "channel-mark", id, peerId: "c1", messageId: `m-${id}`, from: "child", kind, timestamp: 2 }) as unknown as TranscriptItem;
    const v = view([user("u1", 1), mark("question", "q1"), mark("failed", "f1"), assistant("a1", 3, [{ type: "text", text: "好" }])], false);
    assert.deepEqual(v.filter((e) => e.kind === "channelMark").length, 2);
    assert.equal(procOf(v).length, 0);
  });
});

describe("questionAnswered：问询答过没有", () => {
  test("摘要状态还是 waiting 且这条就是最后一条：还在等；别的情况（后来有了回复 / 终态）：答过", () => {
    assert.equal(questionAnswered({ status: "waiting", lastAt: 10 }, { createdAt: 10 }), false);
    assert.equal(questionAnswered({ status: "waiting", lastAt: 20 }, { createdAt: 10 }), true);
    assert.equal(questionAnswered({ status: "running", lastAt: 20 }, { createdAt: 10 }), true);
    assert.equal(questionAnswered({ status: "done", lastAt: 20 }, undefined), true);
  });
  test("读不到摘要（旧样张没有账本）：按还在等，不编造「已回答」", () => {
    assert.equal(questionAnswered(undefined, undefined), false);
    assert.equal(questionAnswered({ status: "waiting", lastAt: 5 }, undefined), false);
  });
});

describe("跑着时点开：列表只列已做完的步骤，正在做的是最后一行", () => {
  // 一轮：旁白 → 读（做完）→ bash（还在跑，没有结果帧）
  const live = [
    user("u1", 1000),
    assistant("a1", 2000, [{ type: "text", text: "先读一下。" }, call("r1")]),
    tool({ toolCallId: "r1", timestamp: 2100 }),
    assistant("a2", 3000, [{ type: "thinking", thinking: "再跑" }, call("b1", "bash", { command: "sleep 60" })]),
  ];
  const [proc] = procOf(view(live, true));

  test("还在跑的工具调用不在列表里；旁白、思考、做完的步骤照旧", () => {
    assert.ok(proc !== undefined);
    const done = finishedSteps(proc.steps, indexToolResults(live));
    assert.deepEqual(done.map((step) => step.kind), ["text", "toolCall", "thinking"]);
    assert.ok(done.every((step) => step.kind !== "toolCall" || step.toolCallId === "r1"));
  });

  test("新步骤出现就地追加：bash 落定后列表多出它，前面的步骤顺序与对象不变", () => {
    const next = [...live, tool({ toolCallId: "b1", toolName: "bash", timestamp: 3500 })];
    const [procNext] = procOf(view(next, true));
    assert.ok(proc !== undefined && procNext !== undefined);
    const before = finishedSteps(proc.steps, indexToolResults(live));
    const after = finishedSteps(procNext.steps, indexToolResults(next));
    assert.deepEqual(after.map((step) => step.kind), ["text", "toolCall", "thinking", "toolCall"]);
    assert.deepEqual(after.slice(0, before.length).map((step) => step.key), before.map((step) => step.key));
  });

  test("已中断的调用不算还在跑（没有结果也不会来）：留在列表里", () => {
    assert.ok(proc !== undefined);
    const done = finishedSteps(proc.steps, indexToolResults(live), new Set(["b1"]));
    assert.equal(done.filter((step) => step.kind === "toolCall").length, 2);
  });

  test("工具组里还在跑的成员剔掉，剔空的组整个不要", () => {
    const grouped = [
      user("u1", 1000),
      assistant("a1", 2000, [call("r1"), call("r2")]),
      tool({ toolCallId: "r1", timestamp: 2100 }),
    ];
    const [p] = procOf(view(grouped, true));
    assert.ok(p !== undefined);
    const done = finishedSteps(p.steps, indexToolResults(grouped));
    const group = done.find((step) => step.kind === "toolGroup");
    assert.ok(group !== undefined && group.kind === "toolGroup");
    assert.deepEqual(group.calls.map((c) => c.toolCallId), ["r1"]);
    assert.deepEqual(finishedSteps(p.steps, new Map()).filter((step) => step.kind === "toolGroup"), []);
  });

  test("展开状态跨 live → 落定保持：过程块 key 不变（TurnProcessLine 用同一个 fold key，不重挂）", () => {
    const settled = [...live, tool({ toolCallId: "b1", toolName: "bash", timestamp: 3500 }), assistant("a3", 4000, [{ type: "text", text: "好了。" }])];
    assert.equal(procOf(view(live, true))[0]?.key, procOf(view(settled, false))[0]?.key);
  });
});
