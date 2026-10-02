import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allowedKinds,
  channelStatus,
  composeChannelPrompt,
  hasExchange,
  parseChannelMessage,
  parseChannelPrompt,
  sortChannelMessages,
  summarizeChannel,
  type ChannelMessage,
} from "./channel.ts";

/** 通道消息工厂：只覆写要测的字段，其余给合法默认 */
function message(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: "m1",
    from: "parent",
    author: "model",
    kind: "task",
    text: "去把外壳重做",
    delivery: "followUp",
    createdAt: 1,
    ...overrides,
  };
}

describe("allowedKinds", () => {
  it("父只能发 task / reply / stop；子只能发 question / progress / done / failed", () => {
    deepStrictEqual([...allowedKinds("parent")], ["task", "reply", "stop"]);
    deepStrictEqual([...allowedKinds("child")], ["question", "progress", "done", "failed"]);
  });
});

describe("parseChannelMessage", () => {
  it("完整的一行原样认出（parent · task · model）", () => {
    const raw = message();
    deepStrictEqual(parseChannelMessage(raw), raw);
  });

  it("child 侧的 question 与 parent 侧的 user 作者（代父发言）都合法", () => {
    strictEqual(parseChannelMessage(message({ from: "child", kind: "question", createdAt: 5 })) !== null, true);
    strictEqual(parseChannelMessage(message({ kind: "reply", author: "user" })) !== null, true);
  });

  it("缺 id / 空 id / 缺 text / createdAt 非数都是坏行", () => {
    strictEqual(parseChannelMessage({ ...message(), id: undefined }), null);
    strictEqual(parseChannelMessage({ ...message(), id: "" }), null);
    strictEqual(parseChannelMessage({ ...message(), text: undefined }), null);
    strictEqual(parseChannelMessage({ ...message(), createdAt: "soon" }), null);
    strictEqual(parseChannelMessage(null), null);
    strictEqual(parseChannelMessage("task"), null);
  });

  it("kind 与 from 不匹配算坏行——child 发 task 只能来自手改文件", () => {
    strictEqual(parseChannelMessage(message({ from: "child", kind: "task" })), null);
    strictEqual(parseChannelMessage(message({ from: "parent", kind: "question" })), null);
    strictEqual(parseChannelMessage(message({ from: "parent", kind: "progress" })), null);
  });

  it("user 作者只允许出现在 parent 侧——child 侧没有「代子发言」的入口", () => {
    strictEqual(
      parseChannelMessage(message({ from: "child", kind: "question", author: "user" })),
      null,
    );
  });

  it("stop 只能由用户发起（parent · user）；model 作者的 stop 是坏行——只能来自手改文件", () => {
    deepStrictEqual(
      parseChannelMessage(message({ kind: "stop", author: "user", text: "" })),
      message({ kind: "stop", author: "user", text: "" }),
    );
    strictEqual(parseChannelMessage(message({ kind: "stop", author: "model" })), null);
    strictEqual(
      parseChannelMessage(message({ from: "child", kind: "stop", author: "user" })),
      null,
    );
  });

  it("author 缺席或坏值归 model；只有字面 \"user\" 才算用户代发", () => {
    deepStrictEqual(
      parseChannelMessage({ ...message({ kind: "reply" }), author: undefined })?.author,
      "model",
    );
    deepStrictEqual(
      parseChannelMessage({ ...message({ kind: "reply" }), author: 42 })?.author,
      "model",
    );
  });

  it("delivery 缺席归 followUp；只有字面 \"steer\" 才算 steer", () => {
    deepStrictEqual(
      parseChannelMessage({ ...message({ kind: "reply" }), delivery: undefined })?.delivery,
      "followUp",
    );
    deepStrictEqual(
      parseChannelMessage({ ...message({ kind: "reply" }), delivery: "later" })?.delivery,
      "followUp",
    );
    deepStrictEqual(
      parseChannelMessage(message({ kind: "reply", delivery: "steer" }))?.delivery,
      "steer",
    );
  });
});

describe("channelStatus", () => {
  it("空通道与只有 task 的通道都是 running——没有需要用户动手的事", () => {
    strictEqual(channelStatus([]), "running");
    strictEqual(channelStatus([message()]), "running");
  });

  it("子的 question 置 waiting——用户此刻唯一需要动手的", () => {
    strictEqual(
      channelStatus([message(), message({ id: "m2", from: "child", kind: "question", createdAt: 2 })]),
      "waiting",
    );
  });

  it("父 reply 后回 running", () => {
    strictEqual(
      channelStatus([
        message(),
        message({ id: "m2", from: "child", kind: "question", createdAt: 2 }),
        message({ id: "m3", kind: "reply", createdAt: 3 }),
      ]),
      "running",
    );
  });

  it("done / failed 是 closed——子自己再发消息（没有父 reply）不重开，状态不回头", () => {
    const done = message({ id: "m2", from: "child", kind: "done", text: "完成", createdAt: 2 });
    strictEqual(channelStatus([message(), done]), "done");
    // done 之后子又报了一条 progress / question（没有经过父 reopen）：状态不回头
    strictEqual(
      channelStatus([
        message(),
        done,
        message({ id: "m3", from: "child", kind: "progress", createdAt: 3 }),
        message({ id: "m4", from: "child", kind: "question", createdAt: 4 }),
      ]),
      "done",
    );
    strictEqual(
      channelStatus([message(), message({ id: "m2", from: "child", kind: "failed", createdAt: 2 })]),
      "failed",
    );
  });

  it("done → progress 仍 done——子多嘴一句不该让通道列悄悄又变回「等你处理」", () => {
    strictEqual(
      channelStatus([
        message(),
        message({ id: "m2", from: "child", kind: "done", createdAt: 2 }),
        message({ id: "m3", from: "child", kind: "progress", createdAt: 3 }),
      ]),
      "done",
    );
  });

  it("done → reply → running——用户 reopen 后代父回信，通道翻回 running", () => {
    strictEqual(
      channelStatus([
        message(),
        message({ id: "m2", from: "child", kind: "done", createdAt: 2 }),
        message({ id: "m3", kind: "reply", createdAt: 3 }),
      ]),
      "running",
    );
  });

  it("done → reply → question → waiting——reopen 之后照常推导，子接着干活再发问", () => {
    strictEqual(
      channelStatus([
        message(),
        message({ id: "m2", from: "child", kind: "done", createdAt: 2 }),
        message({ id: "m3", kind: "reply", createdAt: 3 }),
        message({ id: "m4", from: "child", kind: "question", createdAt: 4 }),
      ]),
      "waiting",
    );
  });

  it("done → reply → done → done——reopen 之后子再次报完成，通道再次 closed", () => {
    strictEqual(
      channelStatus([
        message(),
        message({ id: "m2", from: "child", kind: "done", createdAt: 2 }),
        message({ id: "m3", kind: "reply", createdAt: 3 }),
        message({ id: "m4", from: "child", kind: "done", createdAt: 4 }),
      ]),
      "done",
    );
  });

  it("按时间算，不按账本行的先后——账本只追加但排序是派生职责", () => {
    strictEqual(
      channelStatus([
        message({ id: "m2", from: "child", kind: "question", createdAt: 2 }),
        message({ id: "m1", createdAt: 1 }),
      ]),
      "waiting",
    );
  });
});

describe("channelStatus · stopped（用户终止）", () => {
  const stop = (id: string, createdAt: number): ChannelMessage =>
    message({ id, kind: "stop", author: "user", text: "", createdAt });

  it("stop 落账 → stopped；waiting 的通道被用户终止也翻 stopped（不再是等你回复）", () => {
    strictEqual(channelStatus([message(), stop("m2", 2)]), "stopped");
    strictEqual(
      channelStatus([
        message(),
        message({ id: "m2", from: "child", kind: "question", createdAt: 2 }),
        stop("m3", 3),
      ]),
      "stopped",
    );
  });

  it("done / failed 之后用户再终止 → stopped：封死父模型 reopen 的口子", () => {
    strictEqual(
      channelStatus([
        message(),
        message({ id: "m2", from: "child", kind: "done", createdAt: 2 }),
        stop("m3", 3),
      ]),
      "stopped",
    );
  });

  it("父模型的 reply 不能重开 stopped——否则父模型一回信就把用户的裁决绕了过去", () => {
    strictEqual(
      channelStatus([
        message(),
        stop("m2", 2),
        message({ id: "m3", kind: "reply", author: "model", createdAt: 3 }),
      ]),
      "stopped",
    );
  });

  it("子后续的 progress / question / done / failed 同样不重开 stopped", () => {
    strictEqual(
      channelStatus([
        message(),
        stop("m2", 2),
        message({ id: "m3", from: "child", kind: "progress", createdAt: 3 }),
        message({ id: "m4", from: "child", kind: "question", createdAt: 4 }),
        message({ id: "m5", from: "child", kind: "done", createdAt: 5 }),
      ]),
      "stopped",
    );
  });

  it("用户代父发言（author user 的 reply）重开 → running，之后照常推导", () => {
    strictEqual(
      channelStatus([
        message(),
        stop("m2", 2),
        message({ id: "m3", kind: "reply", author: "user", createdAt: 3 }),
      ]),
      "running",
    );
    strictEqual(
      channelStatus([
        message(),
        stop("m2", 2),
        message({ id: "m3", kind: "reply", author: "user", createdAt: 3 }),
        message({ id: "m4", from: "child", kind: "question", createdAt: 4 }),
      ]),
      "waiting",
    );
  });

  it("重开之后可再次终止；双 stop 不改变状态", () => {
    strictEqual(
      channelStatus([
        stop("m1", 1),
        message({ id: "m2", kind: "reply", author: "user", createdAt: 2 }),
        stop("m3", 3),
      ]),
      "stopped",
    );
    strictEqual(channelStatus([stop("m1", 1), stop("m2", 2)]), "stopped");
  });
});

describe("hasExchange", () => {
  it("只有 task = 没有往来；task 之外任意一条都算（stop 也算——终止过的通道继续占位）", () => {
    strictEqual(hasExchange([]), false);
    strictEqual(hasExchange([message()]), false);
    strictEqual(
      hasExchange([message(), message({ id: "m2", from: "child", kind: "progress", createdAt: 2 })]),
      true,
    );
    strictEqual(hasExchange([message({ kind: "reply" })]), true);
    strictEqual(hasExchange([message(), message({ id: "m2", kind: "stop", author: "user", createdAt: 2 })]), true);
  });
});

describe("sortChannelMessages", () => {
  it("按 createdAt 正序；同毫秒保持账本顺序（稳定）", () => {
    const m1 = message({ id: "a", createdAt: 3 });
    const m2 = message({ id: "b", kind: "reply", createdAt: 1 });
    const m3 = message({ id: "c", from: "child", kind: "question", createdAt: 2 });
    const m4 = message({ id: "d", kind: "reply", createdAt: 2 });
    deepStrictEqual(
      sortChannelMessages([m1, m2, m3, m4]).map((m) => m.id),
      ["b", "c", "d", "a"],
    );
  });
});

describe("summarizeChannel", () => {
  const key = { parentId: "p1", childId: "c1" };

  it("lastAt 是最后一条的时间、messageCount 全量、key 与标题透传", () => {
    const summary = summarizeChannel(key, "重做外壳", [
      message({ id: "m1", createdAt: 1 }),
      message({ id: "m2", from: "child", kind: "question", createdAt: 5 }),
      message({ id: "m3", kind: "reply", createdAt: 3 }),
    ]);
    deepStrictEqual(summary, {
      parentId: "p1",
      childId: "c1",
      childTitle: "重做外壳",
      status: "waiting",
      messageCount: 3,
      lastAt: 5,
      hasExchange: true,
    });
  });

  it("空账本零值（lastAt 0）而不是缺字段——通道列排序不用特判", () => {
    const summary = summarizeChannel(key, "新派出", []);
    strictEqual(summary.lastAt, 0);
    strictEqual(summary.messageCount, 0);
    strictEqual(summary.status, "running");
    strictEqual(summary.hasExchange, false);
  });

  it("只派出没说话的通道 hasExchange=false——不占通道列的位置", () => {
    const summary = summarizeChannel(key, "新派出", [message()]);
    strictEqual(summary.hasExchange, false);
    strictEqual(summary.status, "running");
  });
});

describe("composeChannelPrompt / parseChannelPrompt", () => {
  it("往返：compose 出来的信封能被 parse 还原出 from/kind/peer/message", () => {
    const msg = message({ id: "m9", from: "parent", kind: "task" });
    const prompt = composeChannelPrompt(msg, { id: "p1", title: "重做外壳" });
    deepStrictEqual(parseChannelPrompt(prompt), {
      from: "parent",
      kind: "task",
      peerId: "p1",
      messageId: "m9",
    });
  });

  it("子→父方向同样往返", () => {
    const msg = message({ id: "m2", from: "child", kind: "question" });
    const prompt = composeChannelPrompt(msg, { id: "c1", title: "调研分支" });
    deepStrictEqual(parseChannelPrompt(prompt), {
      from: "child",
      kind: "question",
      peerId: "c1",
      messageId: "m2",
    });
  });

  it("标题含引号与换行——清洗后不破坏首行属性，且仍能正常解析", () => {
    const msg = message({ id: "m3", from: "parent", kind: "task" });
    const prompt = composeChannelPrompt(msg, { id: "p2", title: 'A "quoted"\ntitle' });
    strictEqual(prompt.split("\n")[0]?.includes('title="A \'quoted\' title"'), true);
    deepStrictEqual(parseChannelPrompt(prompt), {
      from: "parent",
      kind: "task",
      peerId: "p2",
      messageId: "m3",
    });
  });

  it("空标题落 Untitled", () => {
    const msg = message({ id: "m4", from: "parent", kind: "task" });
    const prompt = composeChannelPrompt(msg, { id: "p3", title: "" });
    strictEqual(prompt.split("\n")[0]?.includes('title="Untitled"'), true);
  });

  it("英文说明按 from 分叉：parent 让子调 report_to_parent，child 让父调 reply_subsession 并带 id/标题", () => {
    const toChild = composeChannelPrompt(message({ from: "parent", kind: "task" }), {
      id: "p1",
      title: "母任务",
    });
    strictEqual(toChild.includes("report_to_parent"), true);
    const toParent = composeChannelPrompt(message({ from: "child", kind: "done" }), {
      id: "c1",
      title: "子任务",
    });
    strictEqual(toParent.includes("reply_subsession"), true);
    strictEqual(toParent.includes("c1"), true);
    strictEqual(toParent.includes("子任务"), true);
  });

  it("非信封文本 → null", () => {
    strictEqual(parseChannelPrompt("just a normal message"), null);
    strictEqual(parseChannelPrompt(""), null);
  });

  it("kind 与 from 不配 → null（child 发 task 只能来自手改文件）", () => {
    const badPrompt = composeChannelPrompt(message({ from: "parent", kind: "task" }), {
      id: "p1",
      title: "x",
    }).replace('from="parent" kind="task"', 'from="child" kind="task"');
    strictEqual(parseChannelPrompt(badPrompt), null);
  });

  it("首行之外出现信封不算——只看第一行", () => {
    const prompt = composeChannelPrompt(message({ from: "parent", kind: "task" }), {
      id: "p1",
      title: "x",
    });
    strictEqual(parseChannelPrompt(`Some preface\n${prompt}`), null);
  });
});
