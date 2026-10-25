/**
 * intent-lab 主进程客户端的网络面测试：node:http 起真服务，盖住 /ingest 的两种入参
 * （服务地址 / 已带 /ingest 的完整 URL）与服务端拒绝。
 *
 * 这条测试的来由（2026-10-24 探针）：调用方把**已带 /ingest** 的地址交进来，客户端
 * 又拼一次，实际请求 `POST /ingest/ingest` → 404，每轮存档全丢且界面无感。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { ingestEndpoint, postIntentIngest } from "./intent-lab-client.ts";

interface Received {
  method: string;
  url: string;
  body: string;
}

interface TestServer {
  url: string;
  received: Received[];
  close(): Promise<void>;
}

async function withServer(status: number, run: (server: TestServer) => Promise<void>): Promise<void> {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      received.push({ method: req.method ?? "", url: req.url ?? "", body });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    await run({
      url: `http://127.0.0.1:${port}`,
      received,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("ingestEndpoint：服务地址与已带 /ingest 的完整 URL 都落到同一个端点", () => {
  assert.equal(ingestEndpoint("http://127.0.0.1:8723"), "http://127.0.0.1:8723/ingest");
  assert.equal(ingestEndpoint("http://127.0.0.1:8723/"), "http://127.0.0.1:8723/ingest");
  assert.equal(ingestEndpoint("http://127.0.0.1:8723/ingest"), "http://127.0.0.1:8723/ingest");
  assert.equal(ingestEndpoint("http://127.0.0.1:8723/ingest/"), "http://127.0.0.1:8723/ingest");
});

test("完整 URL 输入：只发一次 POST /ingest（不再拼成 /ingest/ingest）", async () => {
  await withServer(200, async (server) => {
    await postIntentIngest(`${server.url}/ingest`, { q: "问" });
    assert.equal(server.received.length, 1);
    assert.equal(server.received[0]?.method, "POST");
    assert.equal(server.received[0]?.url, "/ingest");
    assert.deepEqual(JSON.parse(server.received[0]?.body ?? "{}"), { q: "问" });
  });
});

test("base URL 输入：客户端补上 /ingest", async () => {
  await withServer(200, async (server) => {
    await postIntentIngest(server.url, { q: "问" });
    assert.equal(server.received[0]?.url, "/ingest");
  });
});

test("服务端非 200：抛给调用方（存档失败由调用方只记日志）", async () => {
  await withServer(500, async (server) => {
    await assert.rejects(() => postIntentIngest(`${server.url}/ingest`, {}), /HTTP 500/);
  });
});
