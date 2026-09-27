import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { HostPacer } from "./host-pacer.ts";

/** 假时钟：sleep 推进时间，不真的等 */
const fakeClock = () => {
  let now = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    slept,
  };
};

describe("HostPacer", () => {
  test("同一站点相邻两次至少隔 minInterval；隔够了不等", async () => {
    const clock = fakeClock();
    const pacer = new HostPacer({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
    assert.equal(await pacer.wait("https://www.scopus.com/results"), 0);
    clock.advance(300);
    assert.equal(await pacer.wait("https://www.scopus.com/record?id=1"), 700);
    clock.advance(5000);
    assert.equal(await pacer.wait("https://www.scopus.com/"), 0);
  });

  test("不同站点互不影响；file:// 与 about: 不节流", async () => {
    const clock = fakeClock();
    const pacer = new HostPacer({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
    await pacer.wait("https://a.example/");
    assert.equal(await pacer.wait("https://b.example/"), 0);
    assert.equal(await pacer.wait("file:///tmp/chart.html"), 0);
    assert.equal(await pacer.wait("file:///tmp/chart.html"), 0);
    assert.equal(await pacer.wait("not a url"), 0);
  });

  test("并发调用按预约排队，不会看到同一个「上次」而同时放行", async () => {
    const clock = fakeClock();
    const waits: number[] = [];
    const pacer = new HostPacer({
      minIntervalMs: 1000,
      now: clock.now,
      // 不推进时间：模拟三个调用在同一时刻进来
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await Promise.all([pacer.wait("https://x.test/1"), pacer.wait("https://x.test/2"), pacer.wait("https://x.test/3")]);
    assert.deepEqual(waits, [1000, 2000]);
  });
});
