import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChannelSummary } from "@shared/channel";
import type { SessionMeta, SessionWindowDetail, TranscriptRecord } from "@shared/session";
import { openChildIds, readChildTails, TailCache } from "./child-tails.ts";
import { pickSummaries } from "./summaries-pick.ts";

const metaOf = (id: string): SessionMeta => ({ id }) as unknown as SessionMeta;
const summaryOf = (childId: string, status: string): ChannelSummary => ({ childId, status }) as unknown as ChannelSummary;
const detailOf = (id: string): SessionWindowDetail =>
  ({ meta: metaOf(id), transcript: [{ id: `r-${id}` } as unknown as TranscriptRecord], window: { total: 1, hasMore: false, compactionsBefore: 0 } }) as unknown as SessionWindowDetail;
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("openChildIds", () => {
  const kids = [metaOf("a"), metaOf("b"), metaOf("c"), metaOf("d")];
  const summaries = new Map([
    ["a", summaryOf("a", "running")],
    ["b", summaryOf("b", "done")],
    ["c", summaryOf("c", "stopped")],
  ]);

  it("摘要还没取回来：一个都不读（以前把「没有摘要」当成「开着」，全读一遍）", () => {
    deepStrictEqual(openChildIds(kids, new Map(), false), []);
    // 就算手里有旧摘要，没 ready 也不读
    deepStrictEqual(openChildIds(kids, summaries, false), []);
  });

  it("摘要取回后：只读通道还开着（running）的", () => {
    deepStrictEqual(openChildIds(kids, summaries, true), ["a"]);
  });

  it("取回后没有摘要的子会话没有通道，不读", () => {
    strictEqual(openChildIds(kids, summaries, true).includes("d"), false);
  });
});

describe("pickSummaries", () => {
  const loadedA = { parentId: "pa", summaries: new Map([["x", summaryOf("x", "running")]]) };

  it("还没取回来过：空表 + ready=false", () => {
    deepStrictEqual(pickSummaries(null, "pa"), { summaries: new Map(), ready: false });
  });

  it("取回的就是这个父：原样给出，ready=true", () => {
    const state = pickSummaries(loadedA, "pa");
    strictEqual(state.ready, true);
    strictEqual(state.summaries, loadedA.summaries);
  });

  it("换了父会话：旧父的摘要不能拿来判新父，当作还没取回来", () => {
    const state = pickSummaries(loadedA, "pb");
    strictEqual(state.ready, false);
    strictEqual(state.summaries.size, 0);
  });

  it("没有父会话：空表 + ready=false", () => {
    strictEqual(pickSummaries(loadedA, null).ready, false);
  });
});

describe("TailCache", () => {
  it("updatedAt 没变就是新的；变了是旧的，但旧的还能 peek 到（重读完成前先画旧的）", () => {
    const cache = new TailCache(4);
    cache.set("a", 100, []);
    strictEqual(cache.isFresh("a", 100), true);
    strictEqual(cache.isFresh("a", 101), false);
    strictEqual(cache.peek("a") !== undefined, true);
    strictEqual(cache.peek("zzz"), undefined);
  });

  it("超过上限丢最久没用的，用过的（peek）续命", () => {
    const cache = new TailCache(2);
    cache.set("a", 1, []);
    cache.set("b", 1, []);
    cache.peek("a");
    cache.set("c", 1, []);
    strictEqual(cache.size, 2);
    strictEqual(cache.peek("b"), undefined);
    strictEqual(cache.peek("a") !== undefined, true);
  });
});

describe("readChildTails", () => {
  function loader(delay = 0) {
    const calls: string[] = [];
    let active = 0;
    let peak = 0;
    return {
      calls,
      peak: () => peak,
      load: async (id: string): Promise<SessionWindowDetail | null> => {
        calls.push(id);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, delay));
        active -= 1;
        return detailOf(id);
      },
    };
  }

  it("缓存里是新的就不读；updatedAt 变了的才读", async () => {
    const cache = new TailCache(16);
    const l = loader();
    const first = await readChildTails([{ id: "r1-a", updatedAt: 1 }, { id: "r1-b", updatedAt: 1 }], { load: l.load, cache, isCancelled: () => false });
    strictEqual(first, 2);
    // 再挂载一次（同样的 updatedAt）：一次都不读
    const again = await readChildTails([{ id: "r1-a", updatedAt: 1 }, { id: "r1-b", updatedAt: 1 }], { load: l.load, cache, isCancelled: () => false });
    strictEqual(again, 0);
    // 只有 a 更新了：只重读 a
    const changed = await readChildTails([{ id: "r1-a", updatedAt: 2 }, { id: "r1-b", updatedAt: 1 }], { load: l.load, cache, isCancelled: () => false });
    strictEqual(changed, 1);
    deepStrictEqual(l.calls, ["r1-a", "r1-b", "r1-a"]);
  });

  it("读到的尾窗写进缓存", async () => {
    const cache = new TailCache(16);
    await readChildTails([{ id: "r2-a", updatedAt: 5 }], { load: loader().load, cache, isCancelled: () => false });
    strictEqual(cache.isFresh("r2-a", 5), true);
    strictEqual(cache.peek("r2-a")?.length, 1);
  });

  it("切走（取消）后，排队里还没发出去的不再发", async () => {
    const cache = new TailCache(16);
    const l = loader(5);
    let cancelled = false;
    const wanted = Array.from({ length: 12 }, (_, n) => ({ id: `r3-${n}`, updatedAt: 1 }));
    const run = readChildTails(wanted, { load: l.load, cache, isCancelled: () => cancelled, concurrency: 4 });
    await tick();
    cancelled = true;
    const issued = await run;
    // 取消那一刻只有头 4 路在途；其余 8 条没有发
    strictEqual(issued <= 4, true, `发出了 ${issued} 次`);
    strictEqual(l.calls.length, issued);
  });

  it("并发不超过上限", async () => {
    const cache = new TailCache(32);
    const l = loader(3);
    const wanted = Array.from({ length: 10 }, (_, n) => ({ id: `r4-${n}`, updatedAt: 1 }));
    await readChildTails(wanted, { load: l.load, cache, isCancelled: () => false, concurrency: 3 });
    strictEqual(l.peak(), 3);
    strictEqual(l.calls.length, 10);
  });

  it("同一条（id + updatedAt）在途只发一次：两个面板实例同时要", async () => {
    const cache = new TailCache(16);
    const l = loader(10);
    const want = [{ id: "r5-a", updatedAt: 1 }];
    const [x, y] = await Promise.all([
      readChildTails(want, { load: l.load, cache, isCancelled: () => false }),
      readChildTails(want, { load: l.load, cache, isCancelled: () => false }),
    ]);
    strictEqual(l.calls.length, 1);
    strictEqual(x + y, 1);
  });

  it("读失败记一个空尾窗，同一版不重试", async () => {
    const cache = new TailCache(16);
    let calls = 0;
    const load = async (): Promise<SessionWindowDetail | null> => {
      calls += 1;
      throw new Error("EIO");
    };
    await readChildTails([{ id: "r6-a", updatedAt: 1 }], { load, cache, isCancelled: () => false });
    await readChildTails([{ id: "r6-a", updatedAt: 1 }], { load, cache, isCancelled: () => false });
    strictEqual(calls, 1);
    strictEqual(cache.peek("r6-a")?.length, 0);
  });
});
