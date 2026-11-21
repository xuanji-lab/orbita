import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ChannelMessage } from "@shared/channel";
import type { PlanItem } from "@shared/plan";
import { jobBrief, type JobBriefWords } from "./job-brief.ts";

const words: JobBriefWords = {
  reachedStep: (step) => `做完「${step}」`,
  waitingAnswer: (question) => `等你回答：${question}`,
  waitingAnswerBare: "在问你一件事",
  waitingFailed: (reason) => `没做成：${reason}`,
  waitingFailedBare: "没做成，等你看",
  waitingReview: "交回来了，等你看结果",
  waitingInterrupted: "被打断了，等你说继续",
  waitingPaused: "主智能体暂停了它",
  waitingStep: (step, waitingFor) => `「${step}」在等${waitingFor}`,
  nextAfterAnswer: (step) => `你答了它就接着：${step}`,
  nextAnswer: "你答了它就接着做",
  nextReview: "看结果，决定收下还是再派",
  nextFailed: "看原因，决定重派还是放下",
  nextInterrupted: "说继续，它从断处接着做",
};

function msg(from: "parent" | "child", kind: ChannelMessage["kind"], text: string): ChannelMessage {
  return { id: `${kind}-${text}`, from, author: "model", kind, text, delivery: "followUp", createdAt: 1 };
}

const plan: PlanItem[] = [
  { text: "读现有导航", status: "done" },
  { text: "对比两种进入方式", status: "in_progress" },
  { text: "写推荐", status: "pending" },
];

describe("jobBrief：一件活的自含摘要", () => {
  test("在问你：上次到哪取最近一次回报，等什么是问题原话，下一步接在计划上", () => {
    const brief = jobBrief(
      {
        status: "waiting",
        messages: [
          msg("parent", "task", "对比子会话的两种进入方式。给出推荐。"),
          msg("child", "progress", "找到了生产路径，正在看边界情况。"),
          msg("child", "question", "子会话是替换主对话，还是在旁边打开？"),
        ],
        plan,
      },
      words,
    );
    assert.equal(brief.why, "对比子会话的两种进入方式。");
    assert.equal(brief.reached, "找到了生产路径，正在看边界情况。");
    assert.equal(brief.waiting, "等你回答：子会话是替换主对话，还是在旁边打开？");
    assert.equal(brief.waitingOnYou, true);
    assert.equal(brief.next, "你答了它就接着：对比两种进入方式");
  });

  test("在跑：不等任何人就不写等什么；没回报过时上次到哪取计划里最后做完的一步", () => {
    const brief = jobBrief({ status: "running", messages: [msg("parent", "task", "做一件事")], plan }, words);
    assert.equal(brief.reached, "做完「读现有导航」");
    assert.equal(brief.waiting, null);
    assert.equal(brief.next, "对比两种进入方式");
  });

  test("计划里有一步在等外部：写出来，但不算等你", () => {
    const brief = jobBrief(
      { status: "running", messages: [], plan: [{ text: "跑基准", status: "waiting", waitingFor: "GPU 排队" }] },
      words,
    );
    assert.equal(brief.waiting, "「跑基准」在等GPU 排队");
    assert.equal(brief.waitingOnYou, false);
  });

  test("做完与没做成：等你看，下一步是你的决定", () => {
    const done = jobBrief({ status: "done", messages: [msg("child", "done", "对比做完了，推荐替换主对话。")], plan: null }, words);
    assert.equal(done.reached, "对比做完了，推荐替换主对话。");
    assert.equal(done.waiting, "交回来了，等你看结果");
    assert.equal(done.next, "看结果，决定收下还是再派");
    const failed = jobBrief({ status: "failed", messages: [msg("child", "failed", "服务器上显存不够。")], plan: null }, words);
    assert.equal(failed.waiting, "没做成：服务器上显存不够。");
    assert.equal(failed.next, "看原因，决定重派还是放下");
  });

  test("什么都没有：各项是 null，由界面写「信息不足」，不拿状态硬凑", () => {
    const brief = jobBrief({ status: "idle", messages: undefined, plan: null }, words);
    assert.deepEqual(brief, { why: null, reached: null, waiting: null, waitingOnYou: false, next: null });
  });

  test("回报里的命令与路径洗掉：洗空了就当没回报", () => {
    const brief = jobBrief({ status: "running", messages: [msg("child", "progress", "/usr/local/bin/train.sh")], plan: null }, words);
    assert.equal(brief.reached, null);
  });
});
