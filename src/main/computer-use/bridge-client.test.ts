import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { fetchGuestScreenshot } from "./bridge-client.ts";

/** 127.0.0.1 上起临时端口的服务，回实际端口 */
async function listenOn(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert(address !== null && typeof address === "object", "服务应已监听");
  return address.port;
}

/** 记录最近一次请求的断言线索 */
const seen: { auth: string | undefined; path: string } = { auth: undefined, path: "" };

function mockGuest(handle: (reqPath: string, auth: string | undefined, res: ServerResponse) => void): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    seen.path = `${url.pathname}${url.search}`;
    seen.auth = req.headers.authorization;
    handle(url.pathname, req.headers.authorization, res);
  });
}

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03]);
const ENDPOINT = { ip: "127.0.0.1", port: 0, token: "tok123" };

describe("bridge-client（对 mock HTTP）", () => {
  test("正常：200 + 尺寸头 + JPEG 字节；请求带 Bearer token 与 maxWidth 查询参数", async () => {
    const server = mockGuest((reqPath, auth, res) => {
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "X-Native-Width": "2560",
        "X-Native-Height": "1440",
      });
      res.end(Buffer.from(JPEG_BYTES));
    });
    try {
      const port = await listenOn(server);
      const shot = await fetchGuestScreenshot({ ...ENDPOINT, port }, 1280);
      assert.deepEqual([...shot.jpeg], [...JPEG_BYTES]);
      assert.equal(shot.nativeWidth, 2560);
      assert.equal(shot.nativeHeight, 1440);
      assert.equal(seen.auth, "Bearer tok123");
      assert.equal(seen.path, "/screenshot?maxWidth=1280");
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });

  test("401：token 不对 → 人话错误", async () => {
    const server = mockGuest((_reqPath, _auth, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end('{"ok":false}');
    });
    try {
      const port = await listenOn(server);
      await assert.rejects(fetchGuestScreenshot({ ...ENDPOINT, port }, 1280), /401/);
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });

  test("500：其他状态码 → 错误带状态码", async () => {
    const server = mockGuest((_reqPath, _auth, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    try {
      const port = await listenOn(server);
      await assert.rejects(fetchGuestScreenshot({ ...ENDPOINT, port }, 1280), /500/);
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });

  test("缺尺寸头 → 报错，不把 NaN 当尺寸用", async () => {
    const server = mockGuest((_reqPath, _auth, res) => {
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      res.end(Buffer.from(JPEG_BYTES));
    });
    try {
      const port = await listenOn(server);
      await assert.rejects(fetchGuestScreenshot({ ...ENDPOINT, port }, 1280), /X-Native-Width/);
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });

  test("空响应体 → 报「空截图」", async () => {
    const server = mockGuest((_reqPath, _auth, res) => {
      res.writeHead(200, { "X-Native-Width": "10", "X-Native-Height": "10" });
      res.end();
    });
    try {
      const port = await listenOn(server);
      await assert.rejects(fetchGuestScreenshot({ ...ENDPOINT, port }, 1280), /空截图/);
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });

  test("超时：桥不回话 → 到点放弃，错误提超时", async () => {
    const server = mockGuest(() => {
      /* 故意不响应 */
    });
    try {
      const port = await listenOn(server);
      await assert.rejects(fetchGuestScreenshot({ ...ENDPOINT, port }, 1280, 100), /超时/);
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });

  test("连不上：端口没人听 → 错误带地址", async () => {
    await assert.rejects(
      fetchGuestScreenshot({ ip: "127.0.0.1", port: 1, token: "tok123" }, 1280, 500),
      /127\.0\.0\.1:1/,
    );
  });
});
