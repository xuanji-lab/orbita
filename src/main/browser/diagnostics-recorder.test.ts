/**
 * BrowserDiagnostics 的接线回归：监听挂摘不累积、detach 翻回未开、重开后照常。
 * （#224 验收发现：崩溃 / 被抢后重开，once("detach") 会一次次攒下去。）
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { WebContents } from "electron";
import { BrowserDiagnostics } from "./diagnostics-recorder.ts";

/** 假 WebContents：只实现 recorder 用到的面——debugger 的监听计数、sendCommand 全成功 */
function fakeContents(id: number) {
  const message = new Set<unknown>();
  const detach = new Set<() => void>();
  const debuggerApi = {
    isAttached: () => true,
    attach: () => {},
    sendCommand: (method: string) => {
      if (method === "Page.getFrameTree") {
        return Promise.resolve({ frameTree: { frame: { id: "main-frame", loaderId: "L1" } } });
      }
      return Promise.resolve({});
    },
    on: (name: string, fn: unknown) => {
      (name === "detach" ? detach : message).add(fn);
    },
    removeListener: (name: string, fn: unknown) => {
      (name === "detach" ? detach : message).delete(fn);
    },
  };
  const contents = { id, on: () => {}, once: () => {}, debugger: debuggerApi } as unknown as WebContents;
  return {
    contents,
    counts: () => ({ message: message.size, detach: detach.size }),
    fireDetach: () => {
      for (const fn of [...detach]) fn();
    },
  };
}

describe("BrowserDiagnostics 接线", () => {
  test("首调打开采集；detach 翻回未开；重开后 message / detach 监听各保持 1 个，不累积", async () => {
    const diag = new BrowserDiagnostics();
    const wc = fakeContents(7);

    const first = await diag.open(wc.contents);
    assert.equal(first.justEnabled, true);
    assert.deepEqual(wc.counts(), { message: 1, detach: 1 });

    // 页面崩溃 / 调试器被抢 → detach：enabled 翻回 false，下一次 open 重开
    wc.fireDetach();
    const second = await diag.open(wc.contents);
    assert.equal(second.justEnabled, true);
    assert.deepEqual(wc.counts(), { message: 1, detach: 1 });

    // 不 detach 直接再 open：采集已开，不重走 enable，监听数不变
    const third = await diag.open(wc.contents);
    assert.equal(third.justEnabled, false);
    assert.deepEqual(wc.counts(), { message: 1, detach: 1 });
  });
});
