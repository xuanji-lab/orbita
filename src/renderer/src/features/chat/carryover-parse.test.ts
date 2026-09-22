import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  collectScanAnswer,
  locateMessageRange,
  matchCarryoverMessage,
  parseCarryoverResponse,
  scanTurnModel,
} from "./carryover-parse.ts";
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

describe("parseCarryoverResponse", () => {
  test("正常块：一个 fenced json，两条事项字段齐全", () => {
    const drafts = parseCarryoverResponse(
      '```json\n{"carryovers": [{"title": "补 README 安装段", "detail": "第 3 轮答应补安装文档"}, {"title": "跑全量测试", "detail": ""}]}\n```',
    );
    assert.deepEqual(drafts, [
      { title: "补 README 安装段", detail: "第 3 轮答应补安装文档" },
      { title: "跑全量测试", detail: "" },
    ]);
  });

  test("模型带了引导句也不怕：json 块前后有文字仍取块内", () => {
    const drafts = parseCarryoverResponse(
      '扫描完成，结果如下：\n\n```json\n{"carryovers": [{"title": "一件事", "detail": "上下文"}]}\n```\n\n以上。',
    );
    assert.deepEqual(drafts, [{ title: "一件事", detail: "上下文" }]);
  });

  test("无语言标注的 fenced 块也认（模型偶尔忘写 json 标注）", () => {
    const drafts = parseCarryoverResponse(
      '```\n{"carryovers": [{"title": "无标注块", "detail": ""}]}\n```',
    );
    assert.deepEqual(drafts, [{ title: "无标注块", detail: "" }]);
  });

  test("非 json 块跳过，继续找后面的 json 块", () => {
    const drafts = parseCarryoverResponse(
      '```text\n这是说明文字，不是结构化输出\n```\n\n```json\n{"carryovers": [{"title": "在后面", "detail": ""}]}\n```',
    );
    assert.deepEqual(drafts, [{ title: "在后面", detail: "" }]);
  });

  test("多个 json 块取第一个", () => {
    const drafts = parseCarryoverResponse(
      '```json\n{"carryovers": [{"title": "第一个", "detail": ""}]}\n```\n\n```json\n{"carryovers": [{"title": "第二个", "detail": ""}]}\n```',
    );
    assert.deepEqual(drafts, [{ title: "第一个", detail: "" }]);
  });

  test("空数组：合法结果，返回 []（没有遗留也是答案）", () => {
    const drafts = parseCarryoverResponse('```json\n{"carryovers": []}\n```');
    assert.deepEqual(drafts, []);
  });

  test("坏 JSON → null（降级路径）", () => {
    assert.equal(parseCarryoverResponse('```json\n{"carryovers": [}\n```'), null);
  });

  test("没有 fenced 块 → null", () => {
    assert.equal(parseCarryoverResponse("这次对话里没有未完成的事项。"), null);
  });

  test("结构不符：顶层不是对象 → null", () => {
    assert.equal(parseCarryoverResponse('```json\n[{"title": "数组顶层"}]\n```'), null);
  });

  test("结构不符：没有 carryovers 键 → null", () => {
    assert.equal(parseCarryoverResponse('```json\n{"items": []}\n```'), null);
  });

  test("结构不符：carryovers 不是数组 → null", () => {
    assert.equal(parseCarryoverResponse('```json\n{"carryovers": "none"}\n```'), null);
  });

  test("结构不符：条目缺 title / title 不是字符串 → null（半残清单不进 UI）", () => {
    assert.equal(
      parseCarryoverResponse('```json\n{"carryovers": [{"detail": "没有标题"}]}\n```'),
      null,
    );
    assert.equal(
      parseCarryoverResponse('```json\n{"carryovers": [{"title": 42, "detail": ""}]}\n```'),
      null,
    );
  });

  test("结构不符：条目 detail 不是字符串 → null", () => {
    assert.equal(
      parseCarryoverResponse('```json\n{"carryovers": [{"title": "标题", "detail": 1}]}\n```'),
      null,
    );
  });

  test("尾围栏缺失（流被截断）→ null", () => {
    assert.equal(parseCarryoverResponse('```json\n{"carryovers": [{"title": "截断'), null);
  });
});

describe("matchCarryoverMessage", () => {
  const SCAN = '{"carryovers": [{"title": "补 README", "detail": "摘录"}]}';

  test("整条恰好一个 fenced json 块 → 命中", () => {
    assert.deepEqual(matchCarryoverMessage(`\`\`\`json\n${SCAN}\n\`\`\``), [
      { title: "补 README", detail: "摘录" },
    ]);
  });

  test("空数组也命中（没有遗留也是答案，卡片显示无遗留）", () => {
    assert.deepEqual(matchCarryoverMessage('```json\n{"carryovers": []}\n```'), []);
  });

  test("无语言标注的围栏也命中", () => {
    assert.deepEqual(matchCarryoverMessage(`\`\`\`\n${SCAN}\n\`\`\``), [
      { title: "补 README", detail: "摘录" },
    ]);
  });

  test("夹杂引导文字 → null（卡片会整条替换原文，不能吞字）", () => {
    assert.equal(matchCarryoverMessage(`扫描完成：\n\n\`\`\`json\n${SCAN}\n\`\`\``), null);
    assert.equal(matchCarryoverMessage(`\`\`\`json\n${SCAN}\n\`\`\`\n以上。`), null);
  });

  test("多个 fenced 块 → null", () => {
    assert.equal(
      matchCarryoverMessage(
        `\`\`\`json\n${SCAN}\n\`\`\`\n\n\`\`\`json\n{"carryovers": []}\n\`\`\``,
      ),
      null,
    );
  });

  test("半截围栏（尾栏缺失 / 只有内容没有栏）→ null", () => {
    assert.equal(matchCarryoverMessage(`\`\`\`json\n${SCAN}`), null);
    assert.equal(matchCarryoverMessage(SCAN), null);
  });

  test("非 json 语言标注 → null（那是普通代码块，按 markdown 渲染）", () => {
    assert.equal(matchCarryoverMessage(`\`\`\`ts\n${SCAN}\n\`\`\``), null);
  });

  test("围栏形状对但 JSON 坏 / 结构不符 → null", () => {
    assert.equal(matchCarryoverMessage('```json\n{"carryovers": [}\n```'), null);
    assert.equal(matchCarryoverMessage('```json\n{"items": []}\n```'), null);
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
    const drafts = parseCarryoverResponse(collectScanAnswer(transcript, 1) ?? "");
    assert.deepEqual(drafts, [{ title: "补 README", detail: "摘录" }]);
  });

  test("围栏被拆在多个 text 块里：全部拼接才解得开", () => {
    const transcript = [
      assistant("a1", [
        { type: "text", text: '```json\n{"carryovers": [' },
        { type: "text", text: '{"title": "补 README", "detail": "摘录"}]}\n```' },
      ]),
    ];
    const drafts = parseCarryoverResponse(collectScanAnswer(transcript, 0) ?? "");
    assert.deepEqual(drafts, [{ title: "补 README", detail: "摘录" }]);
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

describe("scanTurnModel", () => {
  const turn = { providerId: "zai", modelId: "glm-5.3", mode: "plan" as const };

  test("配了命名模型：这一轮换成它，其余开工上下文原样", () => {
    const next = scanTurnModel(turn, { providerId: "zhipu", modelId: "glm-5.3-flash" });
    assert.deepEqual(next, { providerId: "zhipu", modelId: "glm-5.3-flash", mode: "plan" });
  });

  test("没配（Same as session）：原样返回会话模型", () => {
    assert.equal(scanTurnModel(turn, undefined), turn);
  });

  test("只影响这一轮：传入的轮次上下文不被改写", () => {
    scanTurnModel(turn, { providerId: "zhipu", modelId: "glm-5.3-flash" });
    assert.deepEqual(turn, { providerId: "zai", modelId: "glm-5.3", mode: "plan" });
  });
});
