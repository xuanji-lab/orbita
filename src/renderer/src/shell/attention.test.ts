import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ChannelMessage } from "../../../shared/channel.ts";
import type { SessionMeta } from "../../../shared/session.ts";
import type { SessionRunState } from "../features/notify/completion-notice.ts";
import { attentionItems, attentionLine, freshAttention, type AttentionWords } from "./attention.ts";

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: id,
    titleSource: "user",
    cwd: "/w",
    workspaceId: "w",
    providerId: "p",
    modelId: "m",
    thinkingLevel: "medium",
    piSessionFile: null,
    pinned: false,
    archived: false,
    recentQueries: [],
    stats: null,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

const words: AttentionWords = {
  asks: "在问你一件事",
  failedWith: (reason) => `没做成：${reason}`,
  failed: "没做成，等你看",
  planAwaiting: "计划写好了，等你点头",
  interrupted: "被打断了，等你说继续",
  waiting: "等你回复",
};

function msg(kind: ChannelMessage["kind"], text: string): ChannelMessage {
  return { id: text, from: kind === "task" ? "parent" : "child", author: "model", kind, text, delivery: "followUp", createdAt: 1 } as ChannelMessage;
}

describe("侧栏顶上的「等你」", () => {
  const states: Record<string, SessionRunState> = { ask1: "waiting", ask2: "waiting", bad: "failed", run: "running", done: "done" };
  const stateOf = (m: SessionMeta): SessionRunState => states[m.id] ?? null;

  test("跨工作区只挑在问的与没做成的；在问的在前，同档最近动过的在前", () => {
    const items = attentionItems(
      [
        { workspaceId: "a", rows: [meta("bad", { updatedAt: 9 }), meta("run"), meta("ask1", { updatedAt: 1 })] },
        { workspaceId: "b", rows: [meta("ask2", { updatedAt: 5 }), meta("done")] },
        { workspaceId: null, rows: [] },
      ],
      stateOf,
    );
    assert.deepEqual(
      items.map((item) => [item.meta.id, item.workspaceId]),
      [["ask2", "b"], ["ask1", "a"], ["bad", "a"]],
    );
  });

  test("子会话在问：取最后一条提问的第一句；带路径命令的洗掉后只说在问你", () => {
    const item = { meta: meta("k", { parentId: "main" }), state: "waiting" as const, workspaceId: "a" };
    const why = { planAwaiting: false, childInterrupted: false };
    assert.equal(
      attentionLine(item, [msg("task", "做一件事"), msg("question", "长序列那组要排队两天，要不要先缩小批次？后面再说。")], why, words),
      "长序列那组要排队两天，要不要先缩小批次？",
    );
    assert.equal(attentionLine(item, [msg("question", "要不要跑 /usr/local/bin/train.sh？")], why, words), "在问你一件事");
    assert.equal(attentionLine(item, undefined, why, words), "在问你一件事");
  });

  test("子会话没做成：带上原因；根会话按为什么在等说", () => {
    const failed = { meta: meta("k", { parentId: "main" }), state: "failed" as const, workspaceId: "a" };
    const none = { planAwaiting: false, childInterrupted: false };
    assert.equal(attentionLine(failed, [msg("failed", "服务器上显存不够，跑不起来。")], none, words), "没做成：服务器上显存不够，跑不起来。");
    const root = { meta: meta("r"), state: "waiting" as const, workspaceId: null };
    assert.equal(attentionLine(root, undefined, { planAwaiting: true, childInterrupted: false }, words), "计划写好了，等你点头");
    assert.equal(attentionLine(root, undefined, { planAwaiting: false, childInterrupted: true }, words), "被打断了，等你说继续");
    assert.equal(attentionLine(root, undefined, none, words), "等你回复");
    assert.equal(attentionLine({ ...root, state: "failed" }, undefined, none, words), "没做成，等你看");
  });


  test("提示音只为新冒出来的那件响：响过的不再响", () => {
    assert.deepEqual(freshAttention(["a", "b"], new Set(["a"])), ["b"]);
    assert.deepEqual(freshAttention(["a"], new Set(["a", "b"])), []);
  });
});
