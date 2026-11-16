import type { TranscriptItem } from "@shared/transcript";
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChannelMessage } from "@shared/channel";
import type { Messages } from "../../messages-en.ts";
import {
  delegateCardStatus,
  latestChannelLine,
  subSessionLine,
  sortSubSessionRows,
  displaySubSessionTitle,
  jobElapsed,
  splitDoneRows,
  subSessionHeadline,
  subSessionMark,
  subSessionRowStatus,
  subSessionStatusOf,
  waitingSummary,
  type SubSessionEngineSlots,
  type SubSessionRowStatus,
} from "./sub-sessions-rows.ts";

describe("subSessionRowStatus", () => {
  it("channelStatus waiting：不管 running 是什么都判 waiting", () => {
    strictEqual(
      subSessionRowStatus({ channelStatus: "waiting", running: true }),
      "waiting",
    );
  });

  it("在跑、非 waiting：判 running", () => {
    strictEqual(
      subSessionRowStatus({ channelStatus: "running", running: true }),
      "running",
    );
  });

  it("通道 done、不在跑：判 done", () => {
    strictEqual(
      subSessionRowStatus({ channelStatus: "done", running: false }),
      "done",
    );
  });

  it("通道 failed、不在跑：判 failed", () => {
    strictEqual(
      subSessionRowStatus({ channelStatus: "failed", running: false }),
      "failed",
    );
  });

  it("通道 running（只有 task）、不在跑：判 idle", () => {
    strictEqual(
      subSessionRowStatus({ channelStatus: "running", running: false }),
      "idle",
    );
  });

  it("channelStatus 缺席（还没有通道摘要）：按 running 走，否则 idle", () => {
    strictEqual(
      subSessionRowStatus({ channelStatus: undefined, running: false }),
      "idle",
    );
  });

  it("stopped 压过 running——用户终止了就别再拿在跑引导用户", () => {
    strictEqual(subSessionRowStatus({ channelStatus: "stopped", running: true }), "stopped");
    strictEqual(subSessionRowStatus({ channelStatus: "stopped", running: false }), "stopped");
  });
});

describe("subSessionStatusOf", () => {
  /** 假引擎：running 里的会话在跑 */
  const engine = (running: readonly string[]): SubSessionEngineSlots => ({
    phaseOf: (id: string) => (running.includes(id) ? "turn" : "idle"),
  });

  it("子在跑：通道只有 task（channelStatus running）也判 running", () => {
    strictEqual(subSessionStatusOf("c1", "running", engine(["c1"])), "running");
  });

  it("子不在跑、通道也没报终态：判 idle——通道开着不等于在跑（2026-10 bug 回归）", () => {
    strictEqual(subSessionStatusOf("c1", "running", engine([])), "idle");
  });

  it("waiting 压过 phase", () => {
    strictEqual(subSessionStatusOf("c1", "waiting", engine(["c1"])), "waiting");
  });

  it("没有摘要（还没拉到）也按槽走，不因缺席先验成 idle", () => {
    strictEqual(subSessionStatusOf("c1", undefined, engine(["c1"])), "running");
  });

  it("被崩溃打断、等你点继续：判 interrupted，排进「等你」、亮 2/3 橙；用户终止过的仍是 stopped", () => {
    const crashed: SubSessionEngineSlots = { ...engine([]), interruptedOf: (id) => id === "c1" };
    strictEqual(subSessionStatusOf("c1", "running", crashed), "interrupted");
    strictEqual(subSessionStatusOf("c1", "stopped", crashed), "stopped");
    strictEqual(subSessionMark("interrupted"), "ask");
    const rows = sortSubSessionRows([
      { status: "running" as const, lastAt: 9 },
      { status: "interrupted" as const, lastAt: 1 },
    ]);
    strictEqual(rows[0]?.status, "interrupted");
  });
});

describe("sortSubSessionRows", () => {
  const row = (id: string, status: SubSessionRowStatus, lastAt = 0): { id: string; status: SubSessionRowStatus; lastAt: number } => ({
    id,
    status,
    lastAt,
  });

  it("收件箱次序：等你（question / 被打断）最前，其次 running，其次 failed，其次 done，stopped/idle 收尾", () => {
    const rows = [
      row("idle-1", "idle"),
      row("running-1", "running"),
      row("waiting-1", "waiting"),
      row("done-1", "done"),
      row("stopped-1", "stopped"),
      row("interrupted-1", "interrupted"),
      row("failed-1", "failed"),
      row("running-2", "running"),
    ];
    deepStrictEqual(
      sortSubSessionRows(rows).map((r) => r.id),
      ["waiting-1", "interrupted-1", "running-1", "running-2", "failed-1", "done-1", "idle-1", "stopped-1"],
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

describe("subSessionMark（行首记号，2026-11-17 减色）", () => {
  it("只有要你出手的是橙点：在问你、被打断、没做成", () => {
    strictEqual(subSessionMark("waiting"), "ask");
    strictEqual(subSessionMark("interrupted"), "ask");
    strictEqual(subSessionMark("failed"), "ask");
  });

  it("在做 = 灰点，做完 = 灰勾，终止的 / 还没开口的不标", () => {
    strictEqual(subSessionMark("running"), "work");
    strictEqual(subSessionMark("done"), "done");
    strictEqual(subSessionMark("stopped"), null);
    strictEqual(subSessionMark("idle"), null);
  });
});

describe("splitDoneRows / subSessionHeadline（做完的折起来，头上一句灰字）", () => {
  const rows = sortSubSessionRows([
    { status: "done" as const, lastAt: 9 },
    { status: "running" as const, lastAt: 5 },
    { status: "waiting" as const, lastAt: 1 },
    { status: "failed" as const, lastAt: 3 },
    { status: "done" as const, lastAt: 2 },
    { status: "idle" as const, lastAt: 8 },
    { status: "stopped" as const, lastAt: 7 },
  ]);
  it("要你看的与在做的留着（排序不变），做完的另放；停着的（没在跑、也没交回）不混在在做里，单放一组", () => {
    const { open, done, parked } = splitDoneRows(rows);
    deepStrictEqual(open.map((row) => row.status), ["waiting", "running", "failed"]);
    deepStrictEqual(done.map((row) => row.lastAt), [9, 2]);
    deepStrictEqual(parked.map((row) => row.status), ["idle", "stopped"]);
  });
  it("「1 件等你 · 1 件没做成 · 1 件在做」：等你与顶上胶囊同一个数，没做成单说；没有的种类不出", () => {
    const words = {
      interrupted: (n: number) => `${n} 个被打断`,
      waiting: (n: number) => `${n} 件等你`,
      failed: (n: number) => `${n} 件没做成`,
      working: (n: number) => `${n} 件在做`,
    };
    strictEqual(subSessionHeadline(rows, words), "1 件等你 · 1 件没做成 · 1 件在做");
    strictEqual(subSessionHeadline([{ status: "done" }], words), "");
  });
});

describe("displaySubSessionTitle（剥英文代号前缀，只当保险）", () => {
  it("小写代号 + 空白 / 冒号 + 中文：剥掉代号", () => {
    strictEqual(displaySubSessionTitle("ss-b-storybench 叙事类比数据集"), "叙事类比数据集");
    strictEqual(displaySubSessionTitle("e6-accept：新内核验收"), "新内核验收");
    strictEqual(displaySubSessionTitle("ss_a_acl 会议论文"), "会议论文");
  });
  it("真以英文开头的名字原样留着", () => {
    strictEqual(displaySubSessionTitle("UrbanGPT 复现"), "UrbanGPT 复现");
    strictEqual(displaySubSessionTitle("S1-S3 验收"), "S1-S3 验收");
    strictEqual(displaySubSessionTitle("Windows 新旧对比"), "Windows 新旧对比");
    strictEqual(displaySubSessionTitle("foo-bar baz"), "foo-bar baz");
    strictEqual(displaySubSessionTitle("dsh-plugin"), "dsh-plugin");
    strictEqual(displaySubSessionTitle("叙事类比数据集"), "叙事类比数据集");
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
      latestDoneWith: (text: string) => `完成：${text}`,
      latestFailedWith: (text: string) => `失败：${text}`,
      latestQuestionBare: "在问你",
      latestProgressBare: "报了一次进度",
      latestReplyBare: "收到了回复",
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
      { id: "p", from: "child", author: "model", kind: "progress", text: "\n\n  第一行写完了一半  \n后面", delivery: "followUp", createdAt: 2 },
    ];
    strictEqual(latestChannelLine(messages, "running", t), "进度：第一行写完了一半");
  });

  it("done / failed 带上结论的第一句（2026-11-17：只写「完成」看不出做成了什么）；洗空了（只有命令 / 路径 / 代号）才只写两个字", () => {
    const done: ChannelMessage[] = [
      { id: "d", from: "child", author: "model", kind: "done", text: "三件都做完了。细节见报告", delivery: "followUp", createdAt: 2 },
    ];
    const failed: ChannelMessage[] = [
      { id: "f", from: "child", author: "model", kind: "failed", text: "`bun install` ETIMEDOUT", delivery: "followUp", createdAt: 2 },
    ];
    strictEqual(latestChannelLine(done, "done", t), "完成：三件都做完了。");
    strictEqual(latestChannelLine(failed, "failed", t), "失败");
  });

  it("进度 / 问：命令、网址、路径不露出来；洗空了只说是哪种消息", () => {
    const progress: ChannelMessage[] = [
      { id: "p", from: "child", author: "model", kind: "progress", text: "跑 node --test src/agent/kernel.test.ts，打开 https://x.dev/a 对照", delivery: "followUp", createdAt: 2 },
    ];
    const line = latestChannelLine(progress, "running", t);
    strictEqual(/[/`]|https?:|--/.test(line), false, line);
    const question: ChannelMessage[] = [
      { id: "q", from: "child", author: "model", kind: "question", text: "/Users/x/a.ts?", delivery: "followUp", createdAt: 2 },
    ];
    strictEqual(latestChannelLine(question, "waiting", t), "在问你");
    // 进度洗空了：没有信息，不写「报了一次进度」
    const bare: ChannelMessage[] = [{ id: "p", from: "child", author: "model", kind: "progress", text: "`bun test`", delivery: "followUp", createdAt: 2 }];
    strictEqual(latestChannelLine(bare, "running", t), "");
  });

  it("父会话的回信不是它在干什么：跳过，取它自己最后说的那句", () => {
    const messages: ChannelMessage[] = [
      { id: "q", from: "child", author: "model", kind: "question", text: "指标口径要不要按论文改", delivery: "followUp", createdAt: 1 },
      { id: "r", from: "parent", author: "user", kind: "reply", text: "先不支持扫描件", delivery: "steer", createdAt: 2 },
    ];
    strictEqual(latestChannelLine(messages, "running", t), "问：指标口径要不要按论文改");
  });

  it("还没开过口：空串（不写「还没说话」，宁可只留名字一行）", () => {
    const taskOnly: ChannelMessage[] = [
      { id: "t", from: "parent", author: "model", kind: "task", text: "任务", delivery: "steer", createdAt: 1 },
    ];
    strictEqual(latestChannelLine(taskOnly, "running", t), "");
    strictEqual(latestChannelLine(undefined, "idle", t), "");
  });
});

describe("delegateCardStatus（父会话转录里派出卡的状态）", () => {
  it("通道终态优先；在跑 = running；被崩溃打断等你继续 = interrupted（不是「空闲」）；都不是 = idle", () => {
    strictEqual(delegateCardStatus("done", false, true), "done");
    strictEqual(delegateCardStatus("stopped", false, true), "stopped");
    strictEqual(delegateCardStatus("running", true, false), "running");
    strictEqual(delegateCardStatus("running", false, true), "interrupted");
    strictEqual(delegateCardStatus(undefined, false, false), "idle");
    // 判断顺序：通道终态压过「槽里还在跑」（子会话已回报完成、最后一个 phase 事件还没到），在跑压过被打断
    strictEqual(delegateCardStatus("done", true, false), "done");
    strictEqual(delegateCardStatus("failed", true, true), "failed");
    strictEqual(delegateCardStatus("waiting", true, false), "waiting");
    strictEqual(delegateCardStatus("running", true, true), "running");
  });
});

describe("waitingSummary（父会话胶囊与右栏列表标题的「等你」同一套说法）", () => {
  const words = { interrupted: (n: number) => `${n} 个被打断`, waiting: (n: number) => `${n} 个等你` };
  it("全是被打断：只写被打断的数；混着：被打断的在前、其余等你的照旧；都没有：空串", () => {
    strictEqual(waitingSummary(2, 2, words), "2 个被打断");
    strictEqual(waitingSummary(3, 1, words), "1 个被打断 · 2 个等你");
    strictEqual(waitingSummary(2, 0, words), "2 个等你");
    strictEqual(waitingSummary(0, 0, words), "");
  });
});

describe("subSessionLine（子会话面板第二行：每件活一句话）", () => {
  const t = {
    channel: {
      notSpokenRunning: "在跑 · 还没说话",
      notSpoken: "还没说话",
      latestQuestion: (text: string) => `问：${text}`,
      latestProgress: (text: string) => `进度：${text}`,
      latestDone: "完成",
      latestFailed: "失败",
      latestReply: (text: string) => `回复：${text}`,
      latestDoneWith: (text: string) => `完成：${text}`,
      latestFailedWith: (text: string) => `失败：${text}`,
      latestQuestionBare: "在问你",
      latestProgressBare: "报了一次进度",
      latestReplyBare: "收到了回复",
      activity: { command: "正在跑命令", read: "正在读文件", edit: "正在改文件", web: "正在查网页", delegate: "正在派活", think: "正在想", work: "正在干活" },
      waitingStep: (step: string, who: string) => `${step} · ${who}`,
      quietFor: (text: string, minutes: number) => `${text} · ${minutes} 分钟没动静`,
    },
  } as unknown as Messages;
  const plan = {
    id: "tp",
    role: "tool",
    toolCallId: "cp",
    toolName: "update_plan",
    input: { items: [{ text: "读代码", status: "done" }, { text: "改投递逻辑", status: "in_progress" }] },
    content: [],
    status: "complete",
    timestamp: 1,
  } as unknown as TranscriptItem;
  const say = (text: string): TranscriptItem => ({ id: `a${text}`, role: "assistant", content: [{ type: "text", text }], timestamp: 2, status: "complete", model: { provider: "p", id: "m" } }) as unknown as TranscriptItem;
  const bash = { id: "tb", role: "tool", toolCallId: "cb", toolName: "bash", input: { command: "bun run test" }, content: [], status: "running", timestamp: 3 } as unknown as TranscriptItem;
  const progress: ChannelMessage[] = [{ id: "p", from: "child", author: "model", kind: "progress", text: "cd /repo && bun run test", delivery: "followUp", createdAt: 2 }];

  it("在跑：刚说的那句话（洗过）优先；只剩命令时退到计划在做的那步；都没有说「正在跑命令」，不露命令", () => {
    const line = (items: TranscriptItem[]) => subSessionLine({ status: "running", messages: progress, items, now: 0, lastActivityAt: 0 }, t);
    strictEqual(line([plan, say("我先把投递改成合并的。"), bash]), "我先把投递改成合并的。");
    strictEqual(line([plan, say("`bun run test`"), bash]), "改投递逻辑");
    strictEqual(line([bash]), "正在跑命令");
  });
  it("在跑但窗口里没有它的转录：退回通道里它说的那句；洗空了就空串（只留名字），不写「报了一次进度」", () => {
    strictEqual(subSessionLine({ status: "running", messages: progress, items: [], now: 0, lastActivityAt: null }, t), "");
    const said: ChannelMessage[] = [{ id: "p", from: "child", author: "model", kind: "progress", text: "统一几项指标的算法", delivery: "followUp", createdAt: 2 }];
    strictEqual(subSessionLine({ status: "running", messages: said, items: [], now: 0, lastActivityAt: null }, t), "进度：统一几项指标的算法");
  });
  it("停着没交回（idle / stopped）：也走 work-line——它刚说的话 → 计划在做的那步；不说「正在……」的动作", () => {
    strictEqual(subSessionLine({ status: "idle", messages: undefined, items: [plan, say("我把投递改成合并的了。")], now: 0, lastActivityAt: 0 }, t), "我把投递改成合并的了。");
    strictEqual(subSessionLine({ status: "stopped", messages: undefined, items: [plan, bash], now: 0, lastActivityAt: 0 }, t), "改投递逻辑");
    strictEqual(subSessionLine({ status: "idle", messages: undefined, items: [], now: 0, lastActivityAt: 0 }, t), "");
  });
  it("没动静：在跑、5 分钟以上没有任何 progress，带上几分钟；没在跑的照旧说通道里那句", () => {
    strictEqual(subSessionLine({ status: "running", messages: progress, items: [bash], now: 7 * 60_000, lastActivityAt: 0 }, t), "正在跑命令 · 7 分钟没动静");
    strictEqual(subSessionLine({ status: "running", messages: progress, items: [bash], now: 4 * 60_000, lastActivityAt: 0 }, t), "正在跑命令");
    const done: ChannelMessage[] = [{ id: "d", from: "child", author: "model", kind: "done", text: "三件都做完了。", delivery: "followUp", createdAt: 3 }];
    strictEqual(subSessionLine({ status: "done", messages: done, items: [bash], now: 7 * 60_000, lastActivityAt: 0 }, t), "完成：三件都做完了。");
  });
});

describe("jobElapsed（进度面板「派出去的活」用了多久）", () => {
  it("用了多久：不到 1 分钟 / N 分钟 / N 小时 M 分钟 / 十小时以上只说小时", () => {
    const words = {
      lessThanMinute: "不到 1 分钟",
      minutes: (n: number) => `${n} 分钟`,
      hours: (n: number) => `${n} 小时`,
      hoursMinutes: (h: number, m: number) => `${h} 小时 ${m} 分钟`,
    };
    strictEqual(jobElapsed(30_000, words), "不到 1 分钟");
    strictEqual(jobElapsed(21 * 60_000, words), "21 分钟");
    strictEqual(jobElapsed(60 * 60_000, words), "1 小时");
    strictEqual(jobElapsed(65 * 60_000, words), "1 小时 5 分钟");
    strictEqual(jobElapsed(11 * 3600_000 + 60_000, words), "11 小时");
  });
});

describe("paused（主智能体暂停的活，合并 feat/main-agent 后接上真实来源）", () => {
  it("没在跑且被暂停 = paused；在跑压过暂停；排在在做之后、没做成之前；不带记号；留在露出的那组", () => {
    strictEqual(subSessionRowStatus({ channelStatus: "running", running: false, paused: true }), "paused");
    strictEqual(subSessionRowStatus({ channelStatus: "running", running: true, paused: true }), "running");
    const rows = sortSubSessionRows([
      { status: "failed" as const, lastAt: 9 },
      { status: "paused" as const, lastAt: 9 },
      { status: "running" as const, lastAt: 1 },
    ]);
    deepStrictEqual(rows.map((row) => row.status), ["running", "paused", "failed"]);
    strictEqual(subSessionMark("paused"), null);
    deepStrictEqual(splitDoneRows([{ status: "paused" as const }]).open.length, 1);
  });
});

describe("结论自己已经说了完成 / 没做成：不再加前缀说两遍", () => {
  const t = {
    channel: {
      latestQuestion: (text: string) => `问：${text}`,
      latestProgress: (text: string) => `进度：${text}`,
      latestDone: "完成",
      latestFailed: "没做成",
      latestDoneWith: (text: string) => `完成：${text}`,
      latestFailedWith: (text: string) => `没做成：${text}`,
      latestQuestionBare: "在问你",
    },
  } as unknown as Messages;
  const one = (kind: "done" | "failed", text: string): ChannelMessage[] => [{ id: "x", from: "child", author: "model", kind, text, delivery: "followUp", createdAt: 1 }];
  it("「验收完成：有条件通过」不再写成「完成：验收完成：……」；普通结论照旧加前缀", () => {
    strictEqual(latestChannelLine(one("done", "验收完成：有条件通过，没有阻断项。"), "done", t), "验收完成：有条件通过，没有阻断项。");
    strictEqual(latestChannelLine(one("done", "做完了：结论写在报告第一节。"), "done", t), "做完了：结论写在报告第一节。");
    strictEqual(latestChannelLine(one("done", "三件都交了。"), "done", t), "完成：三件都交了。");
  });
  it("「没做成 / 失败」开头的不再加「没做成：」", () => {
    strictEqual(latestChannelLine(one("failed", "没做成：论文库连不上。"), "failed", t), "没做成：论文库连不上。");
    strictEqual(latestChannelLine(one("failed", "论文库连不上，换了两个镜像都超时。"), "failed", t), "没做成：论文库连不上，换了两个镜像都超时。");
  });
});
