/**
 * 从历史生成的轮收集（history-turns.ts）：与实时路径同口径地切出可喂的轮——
 * 子会话 / 通道信封 / 收尾扫描不进，回答取最后一条正常说完的 assistant，
 * 回退折叠掉的轮不进（经真 SessionStore.load 的生效视图）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { SessionStore } from "../session/store.ts";
import type { SessionMeta, SessionRecord } from "../../shared/session.ts";
import { buildClosingScanPrompt } from "../../shared/wrapup-scan.ts";
import { MEMORY_ASSISTANT_SNAPSHOT_CHARS } from "../../shared/memory.ts";
import { estimateCalls, historyTurnsOf } from "./history-turns.ts";

let seq = 0;
function user(text: string, timestamp: number): TranscriptItem {
  seq += 1;
  return { id: `u${seq}`, role: "user", content: [{ type: "text", text }], timestamp };
}
function assistant(
  text: string,
  timestamp: number,
  end: { status: "complete"; stopReason: "stop" | "toolUse" } | { status: "aborted"; stopReason: "aborted" } = {
    status: "complete",
    stopReason: "stop",
  },
): TranscriptItem {
  seq += 1;
  return {
    id: `a${seq}`,
    role: "assistant",
    content: [{ type: "text", text }],
    model: { provider: "p", id: "m" },
    timestamp,
    ...end,
  } as TranscriptItem;
}

test("轮号按 user 记录计；回答取最后一条正常说完的 assistant 的文字", () => {
  const records: SessionRecord[] = [
    user("第一问", 1000),
    assistant("先查一下", 1100, { status: "complete", stopReason: "toolUse" }),
    assistant("结论：可以", 1200),
    user("第二问", 2000),
    assistant("答二", 2100),
  ];
  const turns = historyTurnsOf({}, records);
  assert.deepEqual(
    turns.map((turn) => [turn.turn, turn.at, turn.userText, turn.assistantText]),
    [
      [1, 1000, "第一问", "结论：可以"],
      [2, 2000, "第二问", "答二"],
    ],
  );
});

test("最后一帧被打断 / 停在工具调用 / 没文字的轮不进，但仍占轮号", () => {
  const records: SessionRecord[] = [
    user("被打断的", 1000),
    assistant("说了半句", 1100),
    assistant("", 1200, { status: "aborted", stopReason: "aborted" }),
    user("停在工具", 2000),
    assistant("调工具", 2100, { status: "complete", stopReason: "toolUse" }),
    user("没回答", 3000),
    user("正常", 4000),
    assistant("好", 4100),
  ];
  assert.deepEqual(
    historyTurnsOf({}, records).map((turn) => turn.turn),
    [4],
  );
});

test("子会话一轮都不出；收尾扫描与通道标记开的轮不进、回答不归前一轮", () => {
  const records: SessionRecord[] = [
    user("真问题", 1000),
    {
      role: "channel-mark",
      id: "cm1",
      peerId: "child",
      messageId: "m1",
      from: "child",
      kind: "done",
      timestamp: 1500,
    },
    assistant("收到子会话回报后的回答", 1600),
    user(buildClosingScanPrompt({ sinceTurn: 1, lastTurn: 1, turns: [] }), 2000),
    assistant("扫描结果", 2100),
  ];
  // 子会话：哪怕是正常问答也一轮都不出（读记忆不写）
  const normal: SessionRecord[] = [user("子会话里的正常问答", 1000), assistant("答", 1100)];
  assert.equal(historyTurnsOf({}, normal).length, 1);
  assert.deepEqual(historyTurnsOf({ parentId: "p" }, normal), []);
  // 通道标记切断了第 1 轮：它后面的回答不能当第 1 轮的回答——第 1 轮因此没有回答、不进
  assert.deepEqual(historyTurnsOf({}, records), []);
});

test("截断口径同 memoryTurnSnapshot（回答取尾）", () => {
  const long = `${"头".repeat(10)}${"尾".repeat(MEMORY_ASSISTANT_SNAPSHOT_CHARS)}`;
  const [turn] = historyTurnsOf({}, [user("问", 1), assistant(long, 2)]);
  assert.ok(turn!.assistantText.startsWith("……（中段略）"));
  assert.ok(!turn!.assistantText.includes("头"));
});

test("被回退撤掉的轮不进（经 SessionStore.load 的生效视图）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-history-turns-"));
  try {
    const store = new SessionStore(join(dir, "sessions"));
    const id = "a7f3c1d2-4b8e-4f21-9c3a-0d1e2f3a4b5c";
    const meta: SessionMeta = {
      id,
      title: "t",
      titleSource: "derived",
      stats: null,
      cwd: "/repo",
      providerId: "p",
      modelId: "m",
      mode: "plan",
      thinkingLevel: "medium",
      createdAt: 1,
      updatedAt: 1,
      workspaceId: null,
      piSessionFile: null,
      pinned: false,
      archived: false,
      recentQueries: [],
    };
    const first = user("留下的", 1000);
    const reverted = user("被撤回的说法", 2000);
    const redo = user("重说的", 3000);
    await store.commitImported(meta, [
      first,
      assistant("答一", 1100),
      reverted,
      assistant("答被撤回的", 2100),
      { role: "revert", id: "rv1", targetMessageId: reverted.id, restored: [], timestamp: 2500 },
      redo,
      assistant("答重说的", 3100),
    ]);
    const detail = await store.load(id);
    const turns = historyTurnsOf({}, detail!.transcript);
    assert.deepEqual(
      turns.map((turn) => [turn.turn, turn.userText]),
      [
        [1, "留下的"],
        [2, "重说的"],
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("estimateCalls：间隔 ≥ 阈值处切段（不问模型），其余各一次切段判断；每段三次提取", () => {
  assert.equal(estimateCalls([], 10), 0);
  // 两段（0、100 起头）+ 两次切段判断（5、105）
  assert.equal(estimateCalls([{ at: 0 }, { at: 5 }, { at: 100 }, { at: 105 }], 10), 2 + 2 * 3);
});
