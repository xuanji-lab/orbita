import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChannelMessage } from "@shared/channel";
import type { Messages } from "../../messages-en.ts";
import {
  latestChannelLine,
  sortSubSessionRows,
  subSessionBarFill,
  subSessionRowStatus,
  subSessionStatusOf,
  type SubSessionEngineSlots,
  type SubSessionRowStatus,
} from "./sub-sessions-rows.ts";

describe("subSessionRowStatus", () => {
  it("channelStatus waiting：不管 running 是什么都判 waiting", () => {
    strictEqual(subSessionRowStatus({ channelStatus: "waiting", running: true }), "waiting");
  });

  it("在跑、非 waiting：判 running", () => {
    strictEqual(subSessionRowStatus({ channelStatus: "running", running: true }), "running");
  });

  it("通道 done / failed、不在跑：判对应终态", () => {
    strictEqual(subSessionRowStatus({ channelStatus: "done", running: false }), "done");
    strictEqual(subSessionRowStatus({ channelStatus: "failed", running: false }), "failed");
  });

  it("通道 running（只有 task）、不在跑：判 idle", () => {
    strictEqual(subSessionRowStatus({ channelStatus: "running", running: false }), "idle");
  });

  it("channelStatus 缺席：按 running 走，否则 idle", () => {
    strictEqual(subSessionRowStatus({ channelStatus: undefined, running: false }), "idle");
  });

  it("stopped 压过 running——用户终止了就别再拿在跑引导用户", () => {
    strictEqual(subSessionRowStatus({ channelStatus: "stopped", running: true }), "stopped");
    strictEqual(subSessionRowStatus({ channelStatus: "stopped", running: false }), "stopped");
  });
});

describe("subSessionStatusOf", () => {
  const engine = (running: readonly string[]): SubSessionEngineSlots => ({
    phaseOf: (id: string) => (running.includes(id) ? "turn" : "idle"),
  });

  it("子在跑：通道只有 task（channelStatus running）也判 running", () => {
    strictEqual(subSessionStatusOf("c1", "running", engine(["c1"])), "running");
  });

  it("子不在跑、通道也没报终态：判 idle——通道开着不等于在跑", () => {
    strictEqual(subSessionStatusOf("c1", "running", engine([])), "idle");
  });

  it("waiting 压过 phase；没有摘要也按槽走", () => {
    strictEqual(subSessionStatusOf("c1", "waiting", engine(["c1"])), "waiting");
    strictEqual(subSessionStatusOf("c1", undefined, engine(["c1"])), "running");
  });
});

describe("sortSubSessionRows", () => {
  const row = (id: string, status: SubSessionRowStatus, lastAt = 0): { id: string; status: SubSessionRowStatus; lastAt: number } => ({
    id,
    status,
    lastAt,
  });

  it("收件箱次序：等你最前，其次 running，其次 failed，其次 done，stopped/idle 收尾", () => {
    const rows = [
      row("idle-1", "idle"),
      row("running-1", "running"),
      row("waiting-1", "waiting"),
      row("done-1", "done"),
      row("stopped-1", "stopped"),
      row("failed-1", "failed"),
      row("running-2", "running"),
    ];
    deepStrictEqual(
      sortSubSessionRows(rows).map((r) => r.id),
      ["waiting-1", "running-1", "running-2", "failed-1", "done-1", "idle-1", "stopped-1"],
    );
  });

  it("同组之内新的在前（lastAt 倒序）——收件箱是待办清单，新的更可能是现在要处理的", () => {
    const rows = [
      row("old-question", "waiting", 100),
      row("new-question", "waiting", 200),
      row("run-a", "running", 50),
      row("run-b", "running", 80),
    ];
    deepStrictEqual(
      sortSubSessionRows(rows).map((r) => r.id),
      ["new-question", "old-question", "run-b", "run-a"],
    );
  });

  it("stopped/idle 同档按 lastAt 分先后（终局行也保序，不抖动）", () => {
    const rows = [row("stopped-2", "stopped", 20), row("idle-1", "idle", 10), row("stopped-1", "stopped", 30)];
    deepStrictEqual(
      sortSubSessionRows(rows).map((r) => r.id),
      ["stopped-1", "stopped-2", "idle-1"],
    );
  });

  it("不改变入参数组（返回新数组）", () => {
    const rows = [row("a", "done"), row("b", "waiting")];
    const sorted = sortSubSessionRows(rows);
    strictEqual(sorted === rows, false);
    strictEqual(rows[0]?.id, "a");
  });
});

describe("subSessionBarFill（行首状态饼亮几节）", () => {
  it("running = 1/3 蓝；waiting = 2/3 橙", () => {
    strictEqual(subSessionBarFill("running"), "running");
    strictEqual(subSessionBarFill("waiting"), "waiting");
  });

  it("done = 3/3 绿、failed = 3/3 红", () => {
    strictEqual(subSessionBarFill("done"), "done");
    strictEqual(subSessionBarFill("failed"), "failed");
  });

  it("stopped / idle 不亮（undefined = 不渲染状态饼）", () => {
    strictEqual(subSessionBarFill("stopped"), undefined);
    strictEqual(subSessionBarFill("idle"), undefined);
  });
});

describe("latestChannelLine（收件箱行的最新一句）", () => {
  // 文案表用测试自己的桩：latestChannelLine 只做拼接，不依赖真实翻译
  const t = {
    channel: {
      notSpokenRunning: "在跑 · 还没说话",
      notSpoken: "还没说话",
      latestQuestion: (text: string) => `问：${text}`,
      latestProgress: (text: string) => `进度：${text}`,
      latestDone: "完成",
      latestFailed: "失败",
      latestReply: (text: string) => `回复：${text}`,
    },
  } as unknown as Messages;

  it("最新一条非 task 消息说了什么就写什么；task 不算「说话」", () => {
    const messages: ChannelMessage[] = [
      { id: "t", from: "parent", author: "model", kind: "task", text: "任务正文", delivery: "steer", createdAt: 1 },
      { id: "p", from: "child", author: "model", kind: "progress", text: "写完一半", delivery: "followUp", createdAt: 2 },
      { id: "q", from: "child", author: "model", kind: "question", text: "要不要这样？\n第二行", delivery: "followUp", createdAt: 3 },
    ];
    strictEqual(latestChannelLine(messages, "waiting", t), "问：要不要这样？");
  });

  it("多行正文只取第一个非空行并去空白", () => {
    const messages: ChannelMessage[] = [
      { id: "t", from: "parent", author: "model", kind: "task", text: "任务", delivery: "steer", createdAt: 1 },
      { id: "p", from: "child", author: "model", kind: "progress", text: "\n\n  第一行  \n后面", delivery: "followUp", createdAt: 2 },
    ];
    strictEqual(latestChannelLine(messages, "running", t), "进度：第一行");
  });

  it("done / failed 只说结果不带结论（结论由父会话的模型转述）", () => {
    const done: ChannelMessage[] = [
      { id: "d", from: "child", author: "model", kind: "done", text: "PR 210 已开", delivery: "followUp", createdAt: 2 },
    ];
    const failed: ChannelMessage[] = [
      { id: "f", from: "child", author: "model", kind: "failed", text: "下载超时", delivery: "followUp", createdAt: 2 },
    ];
    strictEqual(latestChannelLine(done, "done", t), "完成");
    strictEqual(latestChannelLine(failed, "failed", t), "失败");
  });

  it("最新的是父侧回信：回复：首行", () => {
    const messages: ChannelMessage[] = [
      { id: "q", from: "child", author: "model", kind: "question", text: "问个事", delivery: "followUp", createdAt: 1 },
      { id: "r", from: "parent", author: "user", kind: "reply", text: "先不支持扫描件", delivery: "steer", createdAt: 2 },
    ];
    strictEqual(latestChannelLine(messages, "running", t), "回复：先不支持扫描件");
  });

  it("还没说过话：在跑的说「在跑 · 还没说话」，idle / stopped 只说「还没说话」", () => {
    const taskOnly: ChannelMessage[] = [
      { id: "t", from: "parent", author: "model", kind: "task", text: "任务", delivery: "steer", createdAt: 1 },
    ];
    strictEqual(latestChannelLine(taskOnly, "running", t), "在跑 · 还没说话");
    strictEqual(latestChannelLine(taskOnly, "idle", t), "还没说话");
    strictEqual(latestChannelLine(undefined, "running", t), "在跑 · 还没说话");
    strictEqual(latestChannelLine([], "stopped", t), "还没说话");
  });
});
