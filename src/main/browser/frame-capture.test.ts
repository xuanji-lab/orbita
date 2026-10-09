import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { WebContents } from "electron";
import { captureFrame, captureRegion } from "./frame-capture.ts";
import { CdpTimeoutError, withTimeout } from "./cdp.ts";

/** 假 webContents：只实现 frame-capture / cdp 会碰到的面。calls 记录调用顺序供断言 */
function fakeContents(
  cdpShot: (method: string, params?: object) => Promise<unknown>,
  capturePage: () => Promise<unknown> = () => Promise.reject(new Error("no capturePage in this test")),
): { contents: WebContents; calls: string[] } {
  const calls: string[] = [];
  const contents = {
    setBackgroundThrottling: () => calls.push("throttle"),
    invalidate: () => calls.push("invalidate"),
    capturePage: () => {
      calls.push("capturePage");
      return capturePage();
    },
    debugger: {
      isAttached: () => true,
      attach: () => calls.push("attach"),
      sendCommand: (method: string, params?: object) => {
        calls.push(`cdp:${method}`);
        return cdpShot(method, params);
      },
    },
  };
  return { contents: contents as unknown as WebContents, calls };
}

const okCdp = async () => ({ data: Buffer.from("cdp-frame").toString("base64") });
const okPage = async () => ({ isEmpty: () => false, toPNG: () => Buffer.from("capture-page-frame") });

describe("captureFrame", () => {
  test("主路成功：用 CDP 的 PNG，不碰 capturePage；拍前先逼一帧", async () => {
    const { contents, calls } = fakeContents(okCdp);
    assert.equal((await captureFrame(contents))?.toString(), "cdp-frame");
    assert.ok(calls.includes("invalidate"), "拍前应 invalidate 请求重绘");
    assert.ok(calls.includes("throttle"), "拍前应关后台节流");
    assert.ok(!calls.includes("capturePage"), "主路成功不应走补路");
  });

  test("主路超时：换 capturePage 补拍一次，返回补路的帧", async () => {
    const { contents, calls } = fakeContents(
      async () => {
        throw new CdpTimeoutError("The page did not respond in time.");
      },
      okPage,
    );
    assert.equal((await captureFrame(contents))?.toString(), "capture-page-frame");
    assert.ok(calls.includes("capturePage"));
  });

  test("主路非超时错误（如调试器装不上）也试一次补路；补路救得了就用补路", async () => {
    const { contents } = fakeContents(
      async () => {
        throw new Error("Could not inspect the page (occupied).");
      },
      okPage,
    );
    assert.equal((await captureFrame(contents))?.toString(), "capture-page-frame");
  });

  test("主路超时且补路也失败：换成给模型的说法——不是命令用错、别重试、改用读取工具", async () => {
    const byError = fakeContents(
      async () => {
        throw new CdpTimeoutError("The page did not respond in time.");
      },
      async () => {
        throw new Error("Current display surface not available");
      },
    );
    await assert.rejects(captureFrame(byError.contents), (cause: unknown) => {
      assert.ok(cause instanceof Error);
      assert.match(cause.message, /cannot be captured right now/);
      assert.match(cause.message, /not a mistake in your command/);
      assert.match(cause.message, /browser_extract or browser_observe/);
      return true;
    });

    const byEmpty = fakeContents(
      async () => {
        throw new CdpTimeoutError("The page did not respond in time.");
      },
      async () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
    );
    await assert.rejects(captureFrame(byEmpty.contents), /cannot be captured right now/);
  });

  test("主路非超时错误且补路也失败：原样抛真错误，不说成「截不到」", async () => {
    const { contents } = fakeContents(
      async () => {
        throw new Error("Could not inspect the page (occupied).");
      },
      async () => {
        throw new Error("Current display surface not available");
      },
    );
    await assert.rejects(captureFrame(contents), /Could not inspect the page/);
  });

  test("主路回空 data（页面还没画过东西）回 null，交给调用方按「还没渲染」处理", async () => {
    const { contents } = fakeContents(async () => ({ data: undefined }));
    assert.equal(await captureFrame(contents), null);
  });
});

describe("captureRegion", () => {
  test("clip 原样传给 Page.captureScreenshot；成功回 PNG", async () => {
    let sent: object | undefined;
    const { contents } = fakeContents(async (_method, params) => {
      sent = params;
      return { data: Buffer.from("region-frame").toString("base64") };
    });
    const clip = { x: 10, y: 20, width: 100, height: 80, scale: 2 };
    assert.equal((await captureRegion(contents, clip))?.toString(), "region-frame");
    assert.equal((sent as { clip?: unknown } | undefined)?.clip, clip);
  });

  test("超时：同样换成「这页截不到」的说法", async () => {
    const { contents } = fakeContents(async () => {
      throw new CdpTimeoutError("The page did not respond in time.");
    });
    await assert.rejects(captureRegion(contents, { x: 0, y: 0, width: 50, height: 50, scale: 1 }), /cannot be captured right now/);
  });

  test("非超时错误原样抛", async () => {
    const { contents } = fakeContents(async () => {
      throw new Error("Could not inspect the page (occupied).");
    });
    await assert.rejects(captureRegion(contents, { x: 0, y: 0, width: 50, height: 50, scale: 1 }), /Could not inspect the page/);
  });
});

describe("withTimeout 的错误类型", () => {
  test("到点用传入的错误类型拒绝——调用方能 instanceof 认出超时", async () => {
    await assert.rejects(
      withTimeout(new Promise(() => undefined), 20, "slow", CdpTimeoutError),
      (cause: unknown) => cause instanceof CdpTimeoutError,
    );
  });
});
