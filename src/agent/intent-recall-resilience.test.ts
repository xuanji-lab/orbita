/**
 * 召回韧性的模块级模拟：**消费者抛错不掐流**（intent-recall-client 的护栏）。
 *
 * 转发链上一次打嗝（renderer 重载 / 广播端异常），十几分钟的召回不作废——
 * 事件照常继续读，终态判定在 IO 编排里独立进行。用真 node:http 假 lab 盖住。
 * （渲染层崩溃恢复的「恢复包」机制不在本 PR：运行卡是渲染层 ephemeral 状态，
 * 重载后由终态记录（已落盘）接棒。）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { runIntentRecall, type RecallRunInput } from "./intent-recall-client.ts";
import type { IntentRecallStreamEvent } from "../shared/intent-recall.ts";

function baseInput(port: number): RecallRunInput {
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    sessionId: "s1",
    turnId: "t1",
    title: "标题",
    q: "帮我看看",
  };
}

test("消费者抛错不掐流：转发链一次打嗝，召回继续读到终态", async () => {
  const lines = [
    { type: "accepted", runId: "r1", qaTotal: 10, swarm: { endpoint: "deepseek", model: "x" }, budgetMs: 900000, peak: false, startedAt: 1 },
    { type: "heartbeat", t: 2 },
    { type: "done", runId: "r1", injection: "注入", needsFeedback: false, timing: { totalMs: 5, gateMs: 1, s1Ms: 1, s3Ms: 2, s4Ms: 1 } },
  ];
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    for (const line of lines) res.write(`${JSON.stringify(line)}\n`);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const seen: IntentRecallStreamEvent[] = [];
  let thrown = false;
  const outcome = await runIntentRecall(baseInput(port), new AbortController().signal, (event) => {
    // 第一次转发抛错（模拟 renderer 断开）：流必须继续
    if (!thrown && event.type === "accepted") {
      thrown = true;
      throw new Error("consumer hiccup");
    }
    seen.push(event);
  });
  assert.equal(thrown, true);
  assert.equal(outcome.kind, "done");
  assert.ok(seen.length >= 2); // 打嗝之后的事件照常到达
  server.close();
});
