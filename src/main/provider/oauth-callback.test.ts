import assert from "node:assert/strict";
import { test } from "node:test";
import { listenForCallback } from "./oauth.ts";

test("默认沿用 Claude 登录的老行为：redirect_uri 写 localhost、只绑本机；只认 /callback 路径", async () => {
  const server = await listenForCallback("s1");
  try {
    assert.match(server.redirectUri, /^http:\/\/localhost:\d+\/callback$/);
    const port = new URL(server.redirectUri).port;
    assert.equal((await fetch(`http://127.0.0.1:${port}/favicon.ico`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/callback?code=c&state=s1`)).status, 200);
    assert.deepEqual(await server.waitForCode(), { code: "c", state: "s1" });
  } finally {
    server.close();
  }
});

test("redirectHost: 127.0.0.1 时 redirect_uri 写 127.0.0.1（RFC 8252 的 loopback 字面量）", async () => {
  const server = await listenForCallback("s", { redirectHost: "127.0.0.1" });
  try {
    assert.match(server.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  } finally {
    server.close();
  }
});

test("strictErrors：授权页的 error 要 state 对得上才算；缺 state / 错 state 的被忽略，对的那次才结束等待", async () => {
  const server = await listenForCallback("good", { strictErrors: true });
  const port = new URL(server.redirectUri).port;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/callback?error=access_denied`)).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&state=bad`)).status, 400);
    const race = await Promise.race([server.waitForOutcome(), new Promise<"still-waiting">((resolve) => setTimeout(() => resolve("still-waiting"), 50))]);
    assert.equal(race, "still-waiting");
    await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&state=good&error_description=nope`);
    assert.deepEqual(await server.waitForOutcome(), { kind: "error", error: "access_denied", description: "nope" });
  } finally {
    server.close();
  }
});

test("不开 strictErrors（Claude 登录的老行为）：error 一到就结束等待，waitForCode 为 null", async () => {
  const server = await listenForCallback("good");
  const port = new URL(server.redirectUri).port;
  try {
    await fetch(`http://127.0.0.1:${port}/callback?error=access_denied`);
    assert.equal(await server.waitForCode(), null);
  } finally {
    server.close();
  }
});

test("close()：等待以 closed 结束；响应带 no-store", async () => {
  const server = await listenForCallback("s");
  const port = new URL(server.redirectUri).port;
  const response = await fetch(`http://127.0.0.1:${port}/callback?code=c`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  await response.arrayBuffer();
  server.close();
  assert.deepEqual(await server.waitForOutcome(), { kind: "closed" });
});
