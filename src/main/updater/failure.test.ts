/**
 * 失败分类的测试（updater/failure.ts）。
 *
 * 每档都钉一个真实会出现的形状：Electron net 的错误码、HttpError 的 statusCode、
 * 我们自己抛的 ERR_UPDATER_*，以及认不出来时的 unknown（宁少说一句）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { failureKindOf } from "./failure.ts";

function httpError(status: number, message = `HTTP_ERROR_${status}`): Error {
  return Object.assign(new Error(message), { statusCode: status, code: `HTTP_ERROR_${status}` });
}

describe("failureKindOf", () => {
  test("Node / Electron 的网络失败码 → network", () => {
    assert.equal(failureKindOf(Object.assign(new Error("getaddrinfo ENOTFOUND api.github.com"), { code: "ENOTFOUND" })), "network");
    assert.equal(failureKindOf(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), "network");
    assert.equal(failureKindOf(new Error("net::ERR_CONNECTION_CLOSED")), "network");
    assert.equal(failureKindOf(new Error("net::ERR_NAME_NOT_RESOLVED")), "network");
  });

  test("404 与「更新源缺文件」→ not-found", () => {
    assert.equal(failureKindOf(httpError(404)), "not-found");
    assert.equal(failureKindOf(new Error("HTTP_ERROR_404")), "not-found");
    assert.equal(
      failureKindOf(Object.assign(new Error("no latest.yml"), { code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" })),
      "not-found",
    );
    assert.equal(
      failureKindOf(Object.assign(new Error("no asset"), { code: "ERR_UPDATER_ASSET_NOT_FOUND" })),
      "not-found",
    );
  });

  test("429 / GitHub 的 403 限流 → rate-limit", () => {
    assert.equal(failureKindOf(httpError(429)), "rate-limit");
    assert.equal(failureKindOf(httpError(403, "API rate limit exceeded for 1.2.3.4")), "rate-limit");
    assert.equal(failureKindOf(httpError(403, "Resource not accessible by integration")), "unknown");
  });

  test("5xx → server", () => {
    assert.equal(failureKindOf(httpError(500)), "server");
    assert.equal(failureKindOf(httpError(503)), "server");
  });

  test("认不出来 → unknown（不把普通错误说成断网）", () => {
    assert.equal(failureKindOf(new Error("Cannot parse update info")), "unknown");
    assert.equal(failureKindOf("something odd"), "unknown");
  });
});
