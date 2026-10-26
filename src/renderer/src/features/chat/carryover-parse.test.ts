import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { collectScanAnswer, locateMessageRange, matchScanMessage, scanSubmitInput } from "./carryover-parse.ts";
import type { TranscriptItem } from "@earendil-works/pi-protocol";

const msg = (id: string, role: "user" | "assistant", text: string): TranscriptItem =>
  // 两种角色的必填形状不同（assistant 要 model/status/stopReason），这里只关心
  // role 与 text 块——定位函数也只读它们，用断言免遭绑定变体的形状勒索
  ({
    id,
    role,
    content: [{ type: "text", text }],
    timestamp: 0,
  }) as TranscriptItem;

describe("locateMessageRange", () => {
  test("摘录命中消息文本 → 锚到那条的序号（区间 [i, i]）", () => {
    const transcript = [
      msg("u1", "user", "帮我把 README 补全"),
      msg("a1", "assistant", "好的，我先看看现状"),
      msg("u2", "user", "安装段也要补"),
    ];
    assert.deepEqual(locateMessageRange(transcript, "帮我把 README 补全"), [0, 0]);
    // 摘录是原句的截断（模型只摘了开头）：探针（前 48 字）命中同一条消息
    const long = [
      msg("u1", "user", "帮我把 README 的安装段补全，特别是 Windows 下的构建步骤与依赖安装的坑都写进去"),
    ];
    assert.deepEqual(
      locateMessageRange(long, "帮我把 README 的安装段补全"),
      [0, 0],
    );
  });

  test("摘录是概括、对话里搜不到 → null（缺省是常态）", () => {
    const transcript = [msg("u1", "user", "随便聊了点别的")];
    assert.equal(locateMessageRange(transcript, "用户曾要求重构配置模块"), null);
  });

  test("空摘录 / 空白摘录 → null", () => {
    assert.equal(locateMessageRange([msg("u1", "user", "x")], ""), null);
    assert.equal(locateMessageRange([msg("u1", "user", "x")], "   "), null);
  });

  test("tool 消息不参与匹配", () => {
    const tool = {
      id: "t1",
      role: "tool",
      toolCallId: "c1",
      toolName: "bash",
      input: {},
      content: [{ type: "text", text: "帮我把 README 补全" }],
      timestamp: 0,
      status: "complete",
      isError: false,
    } as TranscriptItem;
    const transcript: readonly TranscriptItem[] = [tool];
    assert.equal(locateMessageRange(transcript, "帮我把 README 补全"), null);
  });
});

describe("matchScanMessage（消息流里认出扫描回答）", () => {
  const V1 = '{"carryovers": [{"title": "补 README", "detail": "摘录"}]}';
  const V2 = '{"done": [{"title": "修好登录", "turns": [1, 3]}], "carryovers": [{"title": "补 README", "detail": "摘录"}]}';

  test("v2：整条恰好一个 fenced json 块 → 两组都有", () => {
    assert.deepEqual(matchScanMessage(`\`\`\`json\n${V2}\n\`\`\``), {
      done: [{ title: "修好登录", turns: [1, 3] }],
      left: [{ title: "补 README", detail: "摘录" }],
    });
  });

  test("v1 的旧回答：只有留下的事（done 为 null，卡片不画做完那组）", () => {
    assert.deepEqual(matchScanMessage(`\`\`\`json\n${V1}\n\`\`\``), {
      done: null,
      left: [{ title: "补 README", detail: "摘录" }],
    });
    assert.deepEqual(matchScanMessage('```\n{"carryovers": []}\n```'), { done: null, left: [] });
  });

  test("夹杂引导文字 / 多个块 / 半截围栏 / 非 json 标注 → null（卡片整条替换原文，不能吞字）", () => {
    assert.equal(matchScanMessage(`扫描完成：\n\n\`\`\`json\n${V2}\n\`\`\``), null);
    assert.equal(matchScanMessage(`\`\`\`json\n${V1}\n\`\`\`\n\n\`\`\`json\n${V1}\n\`\`\``), null);
    assert.equal(matchScanMessage(`\`\`\`json\n${V2}`), null);
    assert.equal(matchScanMessage(V2), null);
    assert.equal(matchScanMessage(`\`\`\`ts\n${V2}\n\`\`\``), null);
  });

  test("围栏形状对但 JSON 坏 / 结构不符 → null", () => {
    assert.equal(matchScanMessage('```json\n{"carryovers": [}\n```'), null);
    assert.equal(matchScanMessage('```json\n{"items": []}\n```'), null);
    assert.equal(matchScanMessage('```json\n{"done": [{"title": "x"}], "carryovers": []}\n```'), null);
  });
});

/** 一条 assistant 消息：块序与 status 都可控——解析输入的口径全看这两样 */
const assistant = (
  id: string,
  blocks: { type: "thinking" | "text"; text: string }[],
  status: "complete" | "streaming" = "complete",
): TranscriptItem =>
  ({
    id,
    role: "assistant",
    status,
    model: { provider: "zai", id: "glm-5.3" },
    stopReason: "stop",
    content: blocks.map((block) =>
      block.type === "thinking"
        ? { type: "thinking", thinking: block.text }
        : { type: "text", text: block.text },
    ),
    timestamp: 0,
  }) as TranscriptItem;

const FENCE = '```json\n{"carryovers": [{"title": "补 README", "detail": "摘录"}]}\n```';

describe("collectScanAnswer", () => {
  test("thinking 块排在前面也拿得到回答（只取 text 块）", () => {
    const transcript = [
      msg("u1", "user", "扫描"),
      assistant("a1", [
        { type: "thinking", text: "用户要我扫遗留……" },
        { type: "text", text: FENCE },
      ]),
    ];
    assert.equal(collectScanAnswer(transcript, 1), FENCE);
  });

  test("围栏被拆在多个 text 块里：全部拼接才解得开", () => {
    const transcript = [
      assistant("a1", [
        { type: "text", text: '```json\n{"carryovers": [' },
        { type: "text", text: '{"title": "补 README", "detail": "摘录"}]}\n```' },
      ]),
    ];
    assert.equal(collectScanAnswer(transcript, 0), FENCE);
  });

  test("基线之前的旧回答不算数——扫描失败时不能误拿上一轮的", () => {
    const transcript = [assistant("a0", [{ type: "text", text: FENCE }]), msg("u1", "user", "扫描")];
    assert.equal(collectScanAnswer(transcript, 1), null);
  });

  test("取基线之后最后一条 assistant（工具轮里前面还有别的回答）", () => {
    const transcript = [
      msg("u1", "user", "扫描"),
      assistant("a1", [{ type: "text", text: "我先看一眼对话" }]),
      assistant("a2", [{ type: "text", text: FENCE }]),
    ];
    assert.equal(collectScanAnswer(transcript, 1)?.includes("carryovers"), true);
  });

  test("只有半截的流式回答 → null（宁可当没回答，也不拿半截去解）", () => {
    const transcript = [
      msg("u1", "user", "扫描"),
      assistant("a1", [{ type: "text", text: '```json\n{"carry' }], "streaming"),
    ];
    assert.equal(collectScanAnswer(transcript, 1), null);
  });

  test("这一轮根本没有 assistant 消息 → null", () => {
    assert.equal(collectScanAnswer([msg("u1", "user", "扫描")], 0), null);
  });
});


describe("scanSubmitInput（扫描轮用会话自己的模型与档）", () => {
  test("模型、档、权限、本子与会话的开工上下文一字不差，只换正文", () => {
    const turn = {
      cwd: "/w",
      workspaceId: null,
      resume: { piSessionFile: "/pi/a.jsonl" },
      providerId: "anthropic",
      modelId: "claude-opus-5-5",
      mode: "manual" as const,
      thinkingLevel: "medium" as const,
    };
    const input = scanSubmitInput("s1", turn, { sinceTurn: 1, lastTurn: 2, turns: [], compactions: [] });
    const { text, sessionId, ...rest } = input;
    assert.deepEqual(rest, turn);
    assert.equal(sessionId, "s1");
    assert.ok(text.startsWith("【Orbita 收尾扫描】"));
  });

  test("权限档压到不高于「询问」：放行 → 询问，计划档原样；其余字段仍与会话一字不差（审核 F-4）", () => {
    const turn = {
      cwd: "/w",
      workspaceId: null,
      resume: { piSessionFile: "/pi/a.jsonl" },
      providerId: "anthropic",
      modelId: "claude-opus-5-5",
      mode: "skip" as const,
      thinkingLevel: "high" as const,
    };
    const plan = { sinceTurn: 1, lastTurn: 2, turns: [], compactions: [] };
    const { text, sessionId: _id, mode, ...rest } = scanSubmitInput("s1", turn, plan);
    assert.equal(mode, "manual");
    const { mode: _skip, ...same } = turn;
    assert.deepEqual(rest, same);
    assert.match(text, /只回看对话，不要调用任何工具/);
    assert.equal(scanSubmitInput("s1", { ...turn, mode: "plan" }, plan).mode, "plan");
    // 输入里的 turn 不被改（launchScan 传进来的是会话的开工上下文，下一轮还要用）
    assert.equal(turn.mode, "skip");
  });
});
