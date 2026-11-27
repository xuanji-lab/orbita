import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionMeta, SessionWindowDetail } from "@shared/session";
import { createLatestWins, readOpenDetail, type OpenReaders } from "./open-session.ts";

const metaOf = (id: string): SessionMeta => ({ id }) as unknown as SessionMeta;
const detailOf = (id: string): SessionWindowDetail =>
  ({ meta: metaOf(id), transcript: [], window: { total: 0, hasMore: false, compactionsBefore: 0 } }) as unknown as SessionWindowDetail;

/** 记下每个读取口被调用了几次的桩 */
function readers(known: readonly string[] = ["a", "b"]): OpenReaders & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    load: async (id) => {
      calls.push(`load:${id}`);
      return known.includes(id) ? detailOf(id) : null;
    },
    meta: async (id) => {
      calls.push(`meta:${id}`);
      return known.includes(id) ? metaOf(id) : null;
    },
  };
}

describe("readOpenDetail", () => {
  it("槽已在：只取 meta，不碰 session:load（整份读盘的那条）", async () => {
    const r = readers();
    const detail = await readOpenDetail("a", true, r);
    deepStrictEqual(r.calls, ["meta:a"]);
    strictEqual(detail?.meta.id, "a");
    strictEqual(detail?.seed, null);
  });

  it("槽不在：读首屏尾窗，并带回来要种进槽", async () => {
    const r = readers();
    const detail = await readOpenDetail("a", false, r);
    deepStrictEqual(r.calls, ["load:a"]);
    strictEqual(detail?.meta.id, "a");
    strictEqual(detail?.seed?.meta.id, "a");
  });

  it("会话不存在：两条路都回 null", async () => {
    const r = readers();
    strictEqual(await readOpenDetail("zzz", true, r), null);
    strictEqual(await readOpenDetail("zzz", false, r), null);
  });

  it("读取失败原样抛出（交给调用方设错误）", async () => {
    const r: OpenReaders = {
      load: async () => {
        throw new Error("EIO");
      },
      meta: async () => {
        throw new Error("EIO");
      },
    };
    await readOpenDetail("a", true, r).then(
      () => strictEqual("不该成功", ""),
      (cause: unknown) => strictEqual((cause as Error).message, "EIO"),
    );
  });
});

describe("createLatestWins", () => {
  it("连点两条：先点的票作废，后点的有效", () => {
    const wins = createLatestWins();
    const first = wins.begin();
    const second = wins.begin();
    strictEqual(wins.isLatest(first), false);
    strictEqual(wins.isLatest(second), true);
  });

  it("后点的先回来、先点的后回来：后回来的先点那张仍然作废（不盖掉后点的）", async () => {
    const wins = createLatestWins();
    const applied: string[] = [];
    const open = (id: string, delay: number) => {
      const ticket = wins.begin();
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          if (wins.isLatest(ticket)) applied.push(id);
          resolve();
        }, delay),
      );
    };
    await Promise.all([open("slow", 20), open("fast", 1)]);
    deepStrictEqual(applied, ["fast"]);
  });

  it("supersede：点回已经绑着的那条（不发读取）也会作废还在路上的那次", () => {
    const wins = createLatestWins();
    const pending = wins.begin();
    wins.supersede();
    strictEqual(wins.isLatest(pending), false);
  });

  it("单独一次打开：自己就是最新的", () => {
    const wins = createLatestWins();
    strictEqual(wins.isLatest(wins.begin()), true);
  });
});
