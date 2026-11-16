/**
 * L3 guest 服务客户端（qemu-guest.ts）的单测。
 *
 * 不起 VM：这里起一个**本地 HTTP 服务冒充 guest 的 CGI**，把协议的两端都钉住——
 *   - 请求体是「每行一个 k=v」（文本 base64、令牌 t=）；
 *   - 回执是 JSON（ok:false 的 error 原话要能传到模型那里）；
 *   - 截图走 image/png，尺寸从 **PNG 头**读（不信任 guest 自报的数字）；
 *   - 服务没应答 / 回的不是图 / 桌面还没起来，这三种失败各自给出能照着做的文案。
 */
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { deflateSync } from "node:zlib";
import {
  deskCommand,
  deskScreenshot,
  deskText,
  guestUnreachableMessage,
  pngSize,
  waitForDesk,
  type GuestDeskChannel,
} from "./qemu-guest.ts";

const TOKEN = "test-token";

interface Recorded {
  cmd: string;
  fields: Record<string, string>;
}

/** 一张真的 PNG（宽高可控）：IHDR + IDAT（filter 0 的原始扫描线）+ IEND，CRC 真算 */
function makePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData) >>> 0);
    return Buffer.concat([length, typeAndData, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const raw = Buffer.alloc(height * (1 + width * 3), 0x40);
  for (let row = 0; row < height; row += 1) raw[row * (1 + width * 3)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function parseBody(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of body.split("\n")) {
    if (line === "") continue;
    const index = line.indexOf("=");
    if (index < 0) continue;
    fields[line.slice(0, index)] = line.slice(index + 1);
  }
  return fields;
}

describe("qemu-guest：guest 服务客户端的协议两端", () => {
  const recorded: Recorded[] = [];
  let pingCount = 0;
  let desktopFrom = 1;
  /** shot 的两种回法：正常 PNG / CGI 自己的失败 JSON（scrot 没产出那种） */
  let shotMode: "ok" | "failed" = "ok";
  let server: http.Server;
  let channel: GuestDeskChannel;

  before(async () => {
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const fields = parseBody(Buffer.concat(chunks).toString("utf8"));
        const cmd = fields["cmd"] ?? "";
        recorded.push({ cmd, fields });
        if (fields["t"] !== TOKEN) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end('{"ok":false,"error":"令牌不符"}');
          return;
        }
        switch (cmd) {
          case "shot": {
            if (shotMode === "failed") {
              response.writeHead(200, { "content-type": "application/json" });
              response.end('{"ok":false,"error":"截图失败：scrot 没有产出"}');
              return;
            }
            response.writeHead(200, { "content-type": "image/png" });
            response.end(makePng(8, 6));
            return;
          }
          case "ping": {
            pingCount += 1;
            response.writeHead(200, { "content-type": "application/json" });
            const desktop = pingCount >= desktopFrom ? 1 : 0;
            response.end(
              desktop === 1
                ? '{"ok":true,"w":1280,"h":800,"desktop":1,"version":"p3-guestd-1"}'
                : '{"ok":true,"w":1280,"h":800,"desktop":0}',
            );
            return;
          }
          case "reject": {
            response.writeHead(200, { "content-type": "application/json" });
            response.end('{"ok":false,"error":"xdotool 不认这个键：NoSuchKey"}');
            return;
          }
          default: {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ ok: true, echoed: cmd }));
            return;
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    channel = { port: address.port, token: TOKEN };
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("命令：请求体是 k=v 行，令牌跟着走；回执字段原样交给上层", async () => {
    const reply = await deskCommand(channel, { cmd: "click", x: 10, y: 20 }, 5_000);
    assert.equal(reply.ok, true);
    assert.equal(reply.fields["echoed"], "click");
    const sent = recorded.at(-1);
    assert.equal(sent?.fields["cmd"], "click");
    assert.equal(sent?.fields["x"], "10");
    assert.equal(sent?.fields["t"], TOKEN);
  });

  it("文本字段走 base64（绕开引号与换行），不是原样拼进 body", () => {
    assert.equal(Buffer.from(deskText("echo 'a\"b'"), "base64").toString("utf8"), "echo 'a\"b'");
  });

  it("guest 说不行：ok:false 不抛异常，error 是 guest 的原话", async () => {
    const reply = await deskCommand(channel, { cmd: "reject" }, 5_000);
    assert.equal(reply.ok, false);
    assert.match(reply.error ?? "", /xdotool 不认这个键/);
  });

  it("令牌不符：同样是 ok:false（服务端拒绝，不是异常）", async () => {
    const reply = await deskCommand({ port: channel.port, token: "wrong" }, { cmd: "ping" }, 5_000);
    assert.equal(reply.ok, false);
    assert.match(reply.error ?? "", /令牌不符/);
  });

  it("截图：回 PNG 原始字节，尺寸从 IHDR 读", async () => {
    const shot = await deskScreenshot(channel, {}, 5_000);
    assert.equal(shot.width, 8);
    assert.equal(shot.height, 6);
    assert.equal(shot.png.subarray(1, 4).toString("ascii"), "PNG");
  });

  it("截图缩放参数是 scrot 的百分比", async () => {
    await deskScreenshot(channel, { thumbPercent: 50 }, 5_000);
    assert.equal(recorded.at(-1)?.fields["thumb"], "50");
  });

  it("截图失败：把 guest 那句原因原样带出来（不是只报「不是图」）", async () => {
    shotMode = "failed";
    await assert.rejects(deskScreenshot(channel, {}, 5_000), /scrot 没有产出/);
    shotMode = "ok";
  });

  it("PNG 头不对：pngSize 拒掉（deskScreenshot 靠它算图宽，信错了就是点到别处）", () => {
    assert.equal(pngSize(Buffer.from("not a png at all")), null);
    assert.equal(pngSize(Buffer.alloc(0)), null);
    const good = makePng(3, 2);
    assert.deepEqual(pngSize(good), { width: 3, height: 2 });
  });

  it("服务没应答：人话里点名端口，并指出去哪看日志", async () => {
    const closed = { port: 1, token: TOKEN };
    const reply = await deskCommand(closed, { cmd: "ping" }, 1_000);
    assert.equal(reply.ok, false);
    assert.match(reply.error ?? "", /127\.0\.0\.1:1/);
    assert.match(reply.error ?? "", /logs\//);
    assert.match(guestUnreachableMessage(closed, new Error("ECONNREFUSED")), /ECONNREFUSED/);
  });

  it("就绪：桌面还没起来时继续等，起来之后返回屏幕尺寸与版本", async () => {
    desktopFrom = Number.POSITIVE_INFINITY;
    const waiting = waitForDesk(channel, { timeoutMs: 5_000, intervalMs: 50 });
    // 前两次 ping 报 desktop:0；把闸门打开后下一轮就该成功
    setTimeout(() => {
      desktopFrom = pingCount + 1;
    }, 150);
    const ready = await waiting;
    assert.deepEqual(ready, { width: 1280, height: 800, version: "p3-guestd-1" });
  });

  it("就绪超时：报「桌面还没起来」，而不是一个裸的 timeout", async () => {
    desktopFrom = Number.POSITIVE_INFINITY;
    await assert.rejects(waitForDesk(channel, { timeoutMs: 300, intervalMs: 50 }), /桌面还没起来/);
    desktopFrom = 1;
  });
});
