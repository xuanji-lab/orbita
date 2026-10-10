import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchGuestScreenshot, GUEST_COMMAND_TIMEOUT_MS } from "./bridge-client.ts";
import { COMPUTER_USE_CMD_DIR } from "../../shared/computer-use.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0x01, 0x02]);

interface FakeBridgeRequest {
  seq: number;
  command: string;
  maxWidth?: number;
}

/**
 * 假桥：轮询 cmd 目录，对每个 req 应用 handler 并写回 resp（+ 可选 jpg），删 req。
 * 协议纪律与真桥一致：jpg 先于 resp 落盘，全部 tmp+rename。
 */
function startFakeBridge(
  outDir: string,
  handler: (req: FakeBridgeRequest) => { resp: Record<string, unknown>; jpg?: Buffer },
): { requests: FakeBridgeRequest[]; stop(): void } {
  const cmdDir = join(outDir, COMPUTER_USE_CMD_DIR);
  const requests: FakeBridgeRequest[] = [];
  let stopped = false;
  void (async () => {
    while (!stopped) {
      try {
        const { readdir } = await import("node:fs/promises");
        const files = (await readdir(cmdDir)).filter((f) => f.endsWith(".req.json")).sort();
        for (const file of files) {
          const baseName = file.slice(0, -".req.json".length);
          const req = JSON.parse(await readFile(join(cmdDir, file), "utf8")) as FakeBridgeRequest;
          requests.push(req);
          const { resp, jpg } = handler(req);
          if (jpg !== undefined) {
            const jpgTmp = join(cmdDir, `${baseName}.jpg.tmp`);
            await writeFile(jpgTmp, jpg);
            const jpgFinal = join(cmdDir, `${baseName}.jpg`);
            await rm(jpgFinal, { force: true });
            const { rename } = await import("node:fs/promises");
            await rename(jpgTmp, jpgFinal);
          }
          const respTmp = join(cmdDir, `${baseName}.resp.json.tmp`);
          await writeFile(respTmp, JSON.stringify(resp), "utf8");
          const { rename } = await import("node:fs/promises");
          const respFinal = join(cmdDir, `${baseName}.resp.json`);
          await rm(respFinal, { force: true });
          await rename(respTmp, respFinal);
          await rm(join(cmdDir, file), { force: true });
        }
      } catch {
        // 目录还没建 / 同步抖动，下一轮
      }
      await sleep(20);
    }
  })();
  return {
    requests,
    stop: () => {
      stopped = true;
    },
  };
}

describe("bridge-client（文件协议）", () => {
  test("screenshot 全链：req 落盘 → resp + jpg 回来 → 临时文件清干净", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    const bridge = startFakeBridge(dir, (req) => ({
      resp: { ok: true, nativeWidth: 2560, nativeHeight: 1440, width: 640, height: 360, jpeg: `cmd-${String(req.seq).padStart(6, "0")}.jpg` },
      jpg: FAKE_JPEG,
    }));
    try {
      const shot = await fetchGuestScreenshot(dir, 640);
      assert.deepEqual(Array.from(shot.jpeg), Array.from(FAKE_JPEG));
      assert.equal(shot.nativeWidth, 2560);
      assert.equal(shot.nativeHeight, 1440);
      assert.equal(bridge.requests[0]?.command, "screenshot");
      assert.equal(bridge.requests[0]?.maxWidth, 640);
      // 清理纪律：cmd 目录里 req/resp/jpg 都不许残留
      const { readdir } = await import("node:fs/promises");
      const left = await readdir(join(dir, COMPUTER_USE_CMD_DIR));
      assert.deepEqual(left, [], `应清理干净，实际残留：${left.join(", ")}`);
    } finally {
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("桥回错误命令响应 → 原话抛出，文件清理", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    const bridge = startFakeBridge(dir, () => ({ resp: { ok: false, error: "截图失败：显示器没就绪" } }));
    try {
      await assert.rejects(fetchGuestScreenshot(dir, 1280), /截图失败：显示器没就绪/);
    } finally {
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("桥死了不回 → 超时抛「没有响应」", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    try {
      await assert.rejects(fetchGuestScreenshot(dir, 1280, 300), /没有响应/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("半截 resp（同步抖动）不当成功也不当失败——等到完整文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    try {
      const promise = fetchGuestScreenshot(dir, 1280, 3_000);
      await sleep(150); // 等 req 落盘
      const { readdir } = await import("node:fs/promises");
      const cmdDir = join(dir, COMPUTER_USE_CMD_DIR);
      const reqFile = (await readdir(cmdDir)).find((f) => f.endsWith(".req.json"));
      assert.ok(reqFile, "req 应已落盘");
      const baseName = reqFile.slice(0, -".req.json".length);
      // 先写半截，再写全——模拟撞上半截文件的那一轮
      await writeFile(join(cmdDir, `${baseName}.resp.json`), '{"ok":true,"nativeWidth":', "utf8");
      await sleep(300);
      await writeFile(join(cmdDir, `${baseName}.jpg`), FAKE_JPEG);
      await writeFile(
        join(cmdDir, `${baseName}.resp.json`),
        JSON.stringify({ ok: true, nativeWidth: 100, nativeHeight: 50, width: 100, height: 50, jpeg: `${baseName}.jpg` }),
        "utf8",
      );
      const shot = await promise;
      assert.equal(shot.nativeWidth, 100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("超时默认值是协议常量", () => {
    assert.equal(GUEST_COMMAND_TIMEOUT_MS, 15_000);
  });
});
