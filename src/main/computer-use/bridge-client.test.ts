import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchGuestScreenshot,
  GUEST_COMMAND_TIMEOUT_MS,
  isPlainScreenshotFileName,
  sendGuestCommand,
} from "./bridge-client.ts";
import { COMPUTER_USE_CMD_DIR } from "../../shared/computer-use.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0x01, 0x02]);

interface FakeBridgeRequest {
  seq: number;
  command: string;
  maxWidth?: number;
  /** 各命令自己的字段（click 的 x/y、key 的 key…），断言时按名字取 */
  [field: string]: unknown;
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
            await rename(jpgTmp, jpgFinal);
          }
          const respTmp = join(cmdDir, `${baseName}.resp.json.tmp`);
          await writeFile(respTmp, JSON.stringify(resp), "utf8");
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

  // ── 通用命令往返（PR2：agent 的 click / type / key / scroll 走它）──────────

  test("通用命令：字段原样到桥、回执回传、文件清干净", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    const bridge = startFakeBridge(dir, () => ({ resp: { ok: true, dryRun: true, vks: [17, 65] } }));
    try {
      const resp = await sendGuestCommand(dir, "key", { key: "ctrl+a" });
      assert.deepEqual(resp, { ok: true, dryRun: true, vks: [17, 65] });
      assert.equal(bridge.requests[0]?.command, "key");
      assert.equal(bridge.requests[0]?.["key"], "ctrl+a");
      assert.deepEqual(await readdir(join(dir, COMPUTER_USE_CMD_DIR)), []);
    } finally {
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("通用命令：桥回错误响应 → 原话抛出（模型要能照抄给用户）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    const bridge = startFakeBridge(dir, () => ({ resp: { ok: false, error: "不认识的按键名：hyper" } }));
    try {
      await assert.rejects(sendGuestCommand(dir, "key", { key: "hyper+x" }), /不认识的按键名：hyper/);
    } finally {
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("通用命令：桥死了不回 → 超时抛出", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    try {
      await assert.rejects(sendGuestCommand(dir, "click", { x: 1, y: 2 }, 300), /没有响应/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── 截图文件名：路径穿越闸门（审查意见 A）────────────────────────────────
//
// resp 是 guest 进程写的内容，是整条协议里唯一的不可信输入。没有这一关的话，
// 被攻陷的 guest 回一个 `..\..\Users\<me>\.ssh\id_ed25519`，宿主就会替它把任意文件
// 读出来、base64 之后经 IPC 送进 renderer。

describe("截图文件名闸门", () => {
  test("纯文件名才放行；目录 / 反斜杠 / .. / 盘符一律拒", () => {
    for (const name of ["cmd-000001.jpg", "a.jpg", "截图.jpg"]) {
      assert.equal(isPlainScreenshotFileName(name), true, name);
    }
    for (const name of [
      "",
      "..",
      "../x.jpg",
      "..\\x.jpg",
      "..\\..\\Users\\me\\.ssh\\id_ed25519",
      "sub/x.jpg",
      "sub\\x.jpg",
      "a/../b.jpg",
      "/etc/passwd",
      "C:\\Windows\\win.ini",
      "C:x.jpg",
      "a/..",
    ]) {
      assert.equal(isPlainScreenshotFileName(name), false, name);
    }
  });

  test("恶意 resp：jpeg 指向 cmd 目录之外 → 抛错，绝不读那个文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    const secretPath = join(dir, "id_ed25519");
    const secret = "PRIVATE-KEY-CONTENT";
    // 哨兵：cmd 目录是 <dir>/cmd，所以 `..\id_ed25519` 正好指向它
    await writeFile(secretPath, secret, "utf8");
    const bridge = startFakeBridge(dir, () => ({
      resp: { ok: true, nativeWidth: 100, nativeHeight: 50, width: 100, height: 50, jpeg: "..\\id_ed25519" },
    }));
    try {
      await assert.rejects(fetchGuestScreenshot(dir, 1280), /非法的截图文件名/);
      assert.equal(await readFile(secretPath, "utf8"), secret, "哨兵文件应原封不动");
    } finally {
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("恶意 resp：绝对路径与正斜杠穿越同样拒（不同写法都堵）", async () => {
    for (const jpeg of ["/etc/passwd", "C:\\Windows\\win.ini", "../x.jpg", "..", "sub/../x.jpg"]) {
      const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
      const bridge = startFakeBridge(dir, () => ({
        resp: { ok: true, nativeWidth: 100, nativeHeight: 50, width: 100, height: 50, jpeg },
      }));
      try {
        await assert.rejects(fetchGuestScreenshot(dir, 1280), /非法的截图文件名/, jpeg);
      } finally {
        bridge.stop();
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
});
