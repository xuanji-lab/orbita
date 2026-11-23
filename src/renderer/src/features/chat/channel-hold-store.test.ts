import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChannelMessage } from "../../../../shared/channel.ts";
import { READING_QUIET_MS, type HeldReport } from "./channel-hold.ts";
import {
  createChannelHoldStore,
  HOLD_ON_KEY,
  HOLD_PENDING_KEY,
  holdNow,
  type ChannelHoldHost,
  type HoldStorage,
} from "./channel-hold-store.ts";

function memoryStorage(seed: Record<string, string> = {}): HoldStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
}

function report(id: string, childId: string, kind: ChannelMessage["kind"], createdAt = 1): HeldReport {
  return {
    id,
    childId,
    childWorkbench: `/wb/${childId}`,
    recovered: false,
    message: { id, from: "child", author: "model", kind, text: `${kind}:${id}`, delivery: "followUp", createdAt },
  };
}

/** 一个带假时钟与假宿主的 store；parent 恒为 "p" */
function setup(seed: Record<string, string> = {}) {
  let clock = 1_000_000;
  const storage = memoryStorage(seed);
  const store = createChannelHoldStore({ storage, now: () => clock, startTimer: false });
  const delivered: HeldReport[][] = [];
  let phase: "idle" | "turn" | "compaction" = "idle";
  const queuedForPull: HeldReport[] = [];
  const host: ChannelHoldHost = {
    phaseOf: () => phase,
    deliver: (_parent, items) => void delivered.push([...items]),
    pullQueued: () => queuedForPull.splice(0),
  };
  store.attachHost(host);
  return {
    store,
    storage,
    delivered,
    queuedForPull,
    advance: (ms: number) => void (clock += ms),
    setPhase: (next: typeof phase) => void (phase = next),
    now: () => clock,
  };
}

/** 模拟 useChatSession 里的到达路由：该攒就攒，否则「照旧投」（这里记成 delivered） */
function arrive(env: ReturnType<typeof setup>, item: HeldReport): "held" | "delivered" {
  env.store.track("p", item);
  if (holdNow(env.store, "p", false)) {
    env.store.hold("p", [item]);
    return "held";
  }
  env.delivered.push([item]);
  env.store.untrack("p", [item.id]);
  return "delivered";
}

describe("开关关着（默认）：done / failed / question 各自的走向", () => {
  for (const kind of ["done", "failed", "progress", "question"] as const) {
    it(`${kind}：用户没在读 → 照旧投，不攒`, () => {
      const env = setup();
      strictEqual(arrive(env, report("m1", "c1", kind)), "delivered");
      strictEqual(env.store.getView("p")?.held.length, 0);
    });
  }

  it("用户在读（往上翻）→ 先攒着；回到底部再静止 N 秒后自动投，合成一次", () => {
    const env = setup();
    env.store.setViewing("p", { scrolledUp: true });
    strictEqual(arrive(env, report("m1", "c1", "done")), "held");
    strictEqual(arrive(env, report("m2", "c2", "failed")), "held");
    strictEqual(env.store.getView("p")?.reading, "scrolled-up");
    env.advance(60_000);
    env.store.tick(env.now());
    strictEqual(env.delivered.length, 0, "还往上翻着，不投");

    env.store.setViewing("p", { scrolledUp: false }); // 滚回底部，本身算一次活动
    env.advance(READING_QUIET_MS - 1);
    env.store.tick(env.now());
    strictEqual(env.delivered.length, 0, "静止窗口没过");
    env.advance(2);
    env.store.tick(env.now());
    strictEqual(env.delivered.length, 1);
    deepStrictEqual(env.delivered[0]?.map((item) => item.id), ["m1", "m2"], "一次投两条");
    strictEqual(env.store.getView("p")?.held.length, 0);
  });

  it("输入框有字 → 攒；清空并静止后才投", () => {
    const env = setup();
    env.store.setDraft("p", true);
    strictEqual(arrive(env, report("m1", "c1", "done")), "held");
    env.advance(120_000);
    env.store.tick(env.now());
    strictEqual(env.delivered.length, 0);
    env.store.setDraft("p", false);
    env.store.noteActivity(env.now()); // 清空输入框是键盘动作
    env.advance(READING_QUIET_MS + 1);
    env.store.tick(env.now());
    strictEqual(env.delivered.length, 1);
  });

  it("窗口不在前台 → 攒；回前台后静止才投", () => {
    const env = setup();
    env.store.setWindowFocused(false);
    strictEqual(arrive(env, report("m1", "c1", "done")), "held");
    env.advance(300_000);
    env.store.tick(env.now());
    strictEqual(env.delivered.length, 0);
    env.store.setWindowFocused(true);
    env.store.setViewing("p", { scrolledUp: false });
    env.advance(READING_QUIET_MS + 1);
    env.store.tick(env.now());
    strictEqual(env.delivered.length, 1);
  });

  it("父会话在跑：不自动投，轮结束（idle）后下一次复查才投", () => {
    const env = setup();
    env.store.setDraft("p", true);
    arrive(env, report("m1", "c1", "done"));
    env.store.setDraft("p", false);
    env.advance(READING_QUIET_MS + 1);
    env.setPhase("turn");
    env.store.tick(env.now());
    strictEqual(env.delivered.length, 0);
    env.setPhase("idle");
    env.store.tick(env.now());
    strictEqual(env.delivered.length, 1);
  });
});

describe("开关开着：不自动开轮", () => {
  it("done / failed / progress 全攒着，再久也不自动投", () => {
    const env = setup();
    env.store.setHoldOn("p", true);
    for (const [id, kind] of [["m1", "done"], ["m2", "failed"], ["m3", "progress"]] as const) {
      strictEqual(arrive(env, report(id, `c-${id}`, kind)), "held");
    }
    env.advance(10 * 60_000);
    env.store.tick(env.now());
    strictEqual(env.delivered.length, 0);
    strictEqual(env.store.getView("p")?.summary.children, 3);
    strictEqual(env.store.getView("p")?.summary.hasQuestion, false);
  });

  it("question 也不自动投，但摘要里标出来（界面据此给小红点）", () => {
    const env = setup();
    env.store.setHoldOn("p", true);
    strictEqual(arrive(env, report("q1", "c1", "question")), "held");
    env.advance(10 * 60_000);
    env.store.tick(env.now());
    strictEqual(env.delivered.length, 0);
    strictEqual(env.store.getView("p")?.summary.hasQuestion, true);
  });

  it("「现在讨论」= release：攒着的一次全交给宿主；之后列表为空", () => {
    const env = setup();
    env.store.setHoldOn("p", true);
    arrive(env, report("m1", "c1", "done"));
    arrive(env, report("q1", "c2", "question"));
    env.store.release("p");
    strictEqual(env.delivered.length, 1);
    deepStrictEqual(env.delivered[0]?.map((item) => item.id), ["m1", "q1"]);
    strictEqual(env.store.getView("p")?.held.length, 0);
  });

  it("「稍后」只收起提示条：攒着的和 question 都还在；question 新来会把它重新展开", () => {
    const env = setup();
    env.store.setHoldOn("p", true);
    arrive(env, report("m1", "c1", "done"));
    env.store.setCollapsed("p", true);
    strictEqual(env.store.getView("p")?.collapsed, true);
    strictEqual(env.store.getView("p")?.held.length, 1);
    arrive(env, report("m2", "c2", "progress"));
    strictEqual(env.store.getView("p")?.collapsed, true, "普通回报不拆开「稍后」");
    arrive(env, report("q1", "c3", "question"));
    strictEqual(env.store.getView("p")?.collapsed, false, "question 在等人，重新展开");
  });

  it("打开开关的那一刻，排队里还没发的子回报也拉回攒着", () => {
    const env = setup();
    env.queuedForPull.push(report("m1", "c1", "done"));
    env.store.setHoldOn("p", true);
    strictEqual(env.store.getView("p")?.held.length, 1);
  });

  it("关掉开关：攒着的按『在不在读』重判，不在读就立刻投", () => {
    const env = setup();
    env.store.setHoldOn("p", true);
    arrive(env, report("m1", "c1", "done"));
    env.store.setHoldOn("p", false);
    strictEqual(env.delivered.length, 1);
  });

  it("开关按会话记：别的会话不受影响", () => {
    const env = setup();
    env.store.setHoldOn("p", true);
    strictEqual(env.store.isHoldOn("p"), true);
    strictEqual(env.store.isHoldOn("other"), false);
  });
});

describe("question 被用户直接回答后", () => {
  it("收件箱代父回复：该子会话更早的 question 不再留着，done 仍留", () => {
    const env = setup();
    env.store.setHoldOn("p", true);
    arrive(env, report("q1", "c1", "question", 5));
    arrive(env, report("d1", "c1", "done", 6));
    env.store.settleAnswered("p", "c1", 10);
    deepStrictEqual(env.store.getView("p")?.held.map((item) => item.id), ["d1"]);
    const stored = JSON.parse(env.storage.data.get(HOLD_PENDING_KEY) ?? "{}") as Record<string, { messageId: string }[]>;
    deepStrictEqual(stored["p"]?.map((ref) => ref.messageId), ["d1"]);
  });
});

describe("刷新 / 重启后攒着的还在", () => {
  it("开关落盘：重建 store 后仍开着", () => {
    const first = setup();
    first.store.setHoldOn("p", true);
    const second = setup({ [HOLD_ON_KEY]: first.storage.data.get(HOLD_ON_KEY) ?? "" });
    strictEqual(second.store.isHoldOn("p"), true);
  });

  it("到达时记引用，重建后从账本回读成「恢复」项；恢复项不自动投，只能点『现在讨论』", async () => {
    const first = setup();
    first.store.setHoldOn("p", true);
    arrive(first, report("m1", "c1", "done"));
    arrive(first, report("m2", "c2", "question"));
    const saved = first.storage.data.get(HOLD_PENDING_KEY) ?? "";

    const second = setup({ [HOLD_PENDING_KEY]: saved });
    const ledgers: Record<string, ChannelMessage[]> = {
      c1: [report("m1", "c1", "done").message],
      c2: [report("m2", "c2", "question").message],
    };
    await second.store.restore(async (_parent, child) => ledgers[child] ?? []);
    const held = second.store.getView("p")?.held ?? [];
    deepStrictEqual(held.map((item) => [item.id, item.recovered, item.childWorkbench]), [
      ["m1", true, "/wb/c1"],
      ["m2", true, "/wb/c2"],
    ]);
    second.advance(10 * 60_000);
    second.store.tick(second.now());
    strictEqual(second.delivered.length, 0, "恢复项不自动投");
    second.store.release("p");
    strictEqual(second.delivered[0]?.length, 2);
  });

  it("账本里找不到的、已被回答的 question 在恢复时抹掉，不留幽灵", async () => {
    const saved = JSON.stringify({
      p: [
        { childId: "c1", messageId: "gone", childWorkbench: "" },
        { childId: "c2", messageId: "q", childWorkbench: "" },
        { childId: "c3", messageId: "ok", childWorkbench: "" },
      ],
    });
    const env = setup({ [HOLD_PENDING_KEY]: saved });
    const q = report("q", "c2", "question", 5).message;
    const reply: ChannelMessage = { id: "r", from: "parent", author: "user", kind: "reply", text: "好", delivery: "steer", createdAt: 9 };
    const ledgers: Record<string, ChannelMessage[]> = { c1: [], c2: [q, reply], c3: [report("ok", "c3", "done").message] };
    await env.store.restore(async (_p, child) => ledgers[child] ?? []);
    deepStrictEqual(env.store.getView("p")?.held.map((item) => item.id), ["ok"]);
    const stored = JSON.parse(env.storage.data.get(HOLD_PENDING_KEY) ?? "{}") as Record<string, { messageId: string }[]>;
    deepStrictEqual(stored["p"]?.map((ref) => ref.messageId), ["ok"]);
  });

  it("投出去之后引用被抹掉：再重启不会重复出现", () => {
    const env = setup();
    env.store.setHoldOn("p", true);
    arrive(env, report("m1", "c1", "done"));
    env.store.release("p");
    env.store.untrack("p", ["m1"]); // 引擎在投递时抹账
    strictEqual(JSON.parse(env.storage.data.get(HOLD_PENDING_KEY) ?? "{}")["p"], undefined);
  });
});
