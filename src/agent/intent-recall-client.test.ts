/**
 * intent-recall 客户端的网络面测试：node:http 起真服务，盖住 NDJSON 流式、
 * 60 秒静默（用缩短的静默窗口而不是假时钟——IO 编排层用真实计时更容易暴露
 * reader 的中断行为）、外部取消、连接失败与半截流。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { runIntentRecall, type RecallRunInput } from "./intent-recall-client.ts";
import {
  INTENT_LAB_SILENT,
  INTENT_LAB_STREAM_ENDED,
  INTENT_LAB_UNREACHABLE,
  type IntentRecallStreamEvent,
} from "../shared/intent-recall.ts";

const INPUT: RecallRunInput = {
  baseUrl: "http://127.0.0.1:1",
  sessionId: "s1",
  turnId: "turn-1",
  title: "标题",
  q: "问题",
};

interface TestServer {
  url: string;
  close(): Promise<void>;
}

async function withServer(
  handler: (respond: (lines: string[]) => void, req: unknown, res?: ServerResponse) => void,
  run: (server: TestServer) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    const respond = (lines: string[]): void => {
      for (const line of lines) res.write(`${line}\n`);
      res.end();
    };
    handler(respond, req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    await run({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("完整事件流：accepted → stage → done，返回注入块", async () => {
  await withServer(
    (respond) => {
      respond([
        '{"type":"accepted","runId":"r1","qaTotal":100,"swarm":{"endpoint":"vllm","model":"27b"},"budgetMs":1500000,"peak":false,"startedAt":1}',
        '{"type":"stage","stage":"s1","status":"start","round":1}',
        '{"type":"stage","stage":"s1","status":"done","round":1,"ms":3000}',
        '{"type":"intent","scene":"sc"}',
        '{"type":"stage","stage":"s3","status":"start","round":1}',
        '{"type":"progress","stage":"s3","round":1,"done":100,"total":100,"passed":12,"etaMs":null}',
        '{"type":"stage","stage":"s3","status":"done","round":1,"ms":9000}',
        '{"type":"stage","stage":"s4","status":"start","round":1}',
        '{"type":"review","summary":"一句","selected":[],"ask":[],"retried":false}',
        '{"type":"stage","stage":"s4","status":"done","round":1,"ms":4000}',
        '{"type":"done","runId":"r1","injection":"<intent>背景</intent>","needsFeedback":false,"timing":{"totalMs":16000,"s1Ms":3000,"s3Ms":9000,"s4Ms":4000}}',
      ]);
    },
    async ({ url }) => {
      const events: IntentRecallStreamEvent[] = [];
      const outcome = await runIntentRecall({ ...INPUT, baseUrl: url }, new AbortController().signal, (e) => events.push(e));
      assert.equal(outcome.kind, "done");
      if (outcome.kind === "done") {
        assert.equal(outcome.injection, "<intent>背景</intent>");
        assert.equal(outcome.needsFeedback, false);
      }
      assert.equal(events.at(-1)?.type, "done");
    },
  );
});

test("error 事件：按契约的 retryable 透传", async () => {
  await withServer(
    (respond) => {
      respond(['{"type":"error","stage":"budget","message":"超预算","retryable":false,"elapsedMs":10}']);
    },
    async ({ url }) => {
      const outcome = await runIntentRecall({ ...INPUT, baseUrl: url }, new AbortController().signal, () => {});
      assert.equal(outcome.kind, "error");
      if (outcome.kind === "error") {
        assert.equal(outcome.stage, "budget");
        assert.equal(outcome.retryable, false);
        assert.equal(outcome.message, "超预算");
      }
    },
  );
});

test("半截流（无 done/error 收尾）：判失败，不猜", async () => {
  await withServer(
    (respond) => {
      respond(['{"type":"accepted","runId":"r1","qaTotal":1,"swarm":{"endpoint":"e","model":"m"},"budgetMs":1,"peak":false,"startedAt":1}']);
    },
    async ({ url }) => {
      const outcome = await runIntentRecall({ ...INPUT, baseUrl: url }, new AbortController().signal, () => {});
      assert.equal(outcome.kind, "error");
      if (outcome.kind === "error") assert.equal(outcome.message, INTENT_LAB_STREAM_ENDED);
    },
  );
});

test("外部取消：返回 cancelled，不发错误", async () => {
  await withServer(
    (_respond, _req) => {
      // 挂着不回——等客户端先取消
    },
    async ({ url }) => {
      const controller = new AbortController();
      const outcome = runIntentRecall({ ...INPUT, baseUrl: url }, controller.signal, () => {});
      controller.abort();
      assert.equal((await outcome).kind, "cancelled");
    },
  );
});

test("连接失败（端口没人听）：INTENT_LAB_UNREACHABLE 且可重试", async () => {
  const outcome = await runIntentRecall(
    { ...INPUT, baseUrl: "http://127.0.0.1:1" },
    new AbortController().signal,
    () => {},
  );
  assert.equal(outcome.kind, "error");
  if (outcome.kind === "error") {
    assert.equal(outcome.message, INTENT_LAB_UNREACHABLE);
    assert.equal(outcome.retryable, true);
  }
});

test("非 200：状态码与服务端正文里的 error 一起透传（2026-10-15 联调教训）", async () => {
  const server: Server = createServer((req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "S3 预设 deepseek 需要 endpoints.deepseek：端点 deepseek 未配置或缺 baseUrl / apiKey / model" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    const outcome = await runIntentRecall(
      { ...INPUT, baseUrl: `http://127.0.0.1:${port}` },
      new AbortController().signal,
      () => {},
    );
    assert.equal(outcome.kind, "error");
    if (outcome.kind === "error") {
      assert.equal(outcome.stage, "config");
      assert.match(outcome.message, /HTTP 400 — S3 预设 deepseek 需要 endpoints\.deepseek/);
      assert.equal(outcome.retryable, true);
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("非 200 正文读到一半被取消：照样结掉（cancelled），不挂住也不打崩进程", { timeout: 5000 }, async () => {
  const server: Server = createServer((_req, res) => {
    // 只发状态行与半截正文，不收尾——模拟服务端慢 / 卡住
    res.writeHead(500, { "Content-Type": "application/json" });
    res.write('{"error":"半截');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    const controller = new AbortController();
    const pending = runIntentRecall({ ...INPUT, baseUrl: `http://127.0.0.1:${port}` }, controller.signal, () => {});
    await new Promise((r) => setTimeout(r, 150));
    controller.abort();
    const outcome = await pending;
    assert.equal(outcome.kind, "cancelled");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("挂在流上时外部取消能打断 reader", { timeout: 5000 }, async () => {
  await withServer(
    (_respond, _req) => {
      // 一行都不发，连接挂着
    },
    async ({ url }) => {
      const controller = new AbortController();
      const outcome = runIntentRecall({ ...INPUT, baseUrl: url }, controller.signal, () => {});
      await new Promise((r) => setTimeout(r, 50));
      controller.abort();
      assert.equal((await outcome).kind, "cancelled");
    },
  );
});

test("静默判定：窗口内一行不来判死（注入短窗口）", { timeout: 5000 }, async () => {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    // 发一行后**不 end**——连接挂着，静默计时从最后一行起算
    res.write('{"type":"heartbeat","t":1}\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    const outcome = runIntentRecall(
      { ...INPUT, baseUrl: `http://127.0.0.1:${port}` },
      new AbortController().signal,
      () => {},
      120,
    );
    const settled = await outcome;
    assert.equal(settled.kind, "error");
    if (settled.kind === "error") {
      assert.equal(settled.message, INTENT_LAB_SILENT);
      assert.equal(settled.retryable, true);
    }
  } finally {
    server.close();
  }
});

test("v3 请求体：不带 recent、force 缺省不带字段、force=true 带 force:true", async () => {
  const bodies: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end('{"type":"done","runId":"r","injection":"x","needsFeedback":false,"timing":{"totalMs":1,"gateMs":0,"s1Ms":1,"s3Ms":1,"s4Ms":1}}\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  await runIntentRecall({ ...INPUT, baseUrl: url }, new AbortController().signal, () => {});
  await runIntentRecall({ ...INPUT, baseUrl: url, force: true }, new AbortController().signal, () => {});
  server.close();
  const [plain, forced] = bodies as [{ force?: boolean; recent?: unknown }, { force?: boolean; recent?: unknown }];
  assert.equal("recent" in plain, false, "v3 请求不再带 recent");
  assert.equal("force" in plain, false, "缺省不带 force 字段");
  assert.equal(forced.force, true);
  assert.equal("recent" in forced, false);
});

test("v5 请求体：models 缺省不带字段；带时原样随行（各环节选择 + S3 预设）", async () => {
  const bodies: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end('{"type":"done","runId":"r","injection":"x","needsFeedback":false,"timing":{"totalMs":1,"gateMs":0,"s1Ms":1,"s3Ms":1,"s4Ms":1}}\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  await runIntentRecall({ ...INPUT, baseUrl: url }, new AbortController().signal, () => {});
  await runIntentRecall(
    {
      ...INPUT,
      baseUrl: url,
      models: {
        gate: "vllm27b",
        s1: "deepseek",
        s3: "two-stage",
      },
    },
    new AbortController().signal,
    () => {},
  );
  server.close();
  const [plain, withModels] = bodies as [{ models?: unknown }, { models?: { gate?: unknown; s1?: string; s3?: string } }];
  assert.equal("models" in plain, false, "缺省不带 models 字段（沿用服务端配置）");
  assert.equal(withModels.models?.gate, "vllm27b");
  assert.equal(withModels.models?.s1, "deepseek");
  assert.equal(withModels.models?.s3, "two-stage");
});

/**
 * 灰屏攻坚（2026-09-26）的回归：真机上 13 分钟的 S3 流里 progress 行全部失踪
 * 而心跳照到——传输层换成 node:http 后，这里盖住真实流量形状：一块多行、行跨块、
 * 多字节字符跨块，一条 progress 都不能丢。
 */
test("字节级切块：一块多行、行跨块、多字节跨块——progress 一条不丢", async () => {
  const progressLines = Array.from(
    { length: 40 },
    (_, i) => `{"type":"progress","stage":"s3","round":1,"done":${i + 1},"total":40,"passed":${i},"etaMs":${i === 0 ? "null" : 12000}}`,
  );
  const payload = [
    '{"type":"accepted","runId":"r1","qaTotal":40,"swarm":{"endpoint":"vllm","model":"27b"},"budgetMs":1500000,"peak":false,"startedAt":1}',
    '{"type":"intent","scene":"排查灰屏与进度条","want":"找到丢行层"}',
    ...progressLines,
    '{"type":"done","runId":"r1","injection":"<intent>背景</intent>","needsFeedback":false,"timing":{"totalMs":16000,"gateMs":1,"s1Ms":3000,"s3Ms":9000,"s4Ms":4000}}',
  ].join("\n") + "\n"; // lab 的 send 每行都带换行；半截行（无收尾换行）按契约判半截流
  await withServer(
    (_respond, _req, res) => {
      // 7 字节一块（行会被劈开；scene 的中文会跨块），块间让出事件循环
      void (async () => {
        for (let i = 0; i < payload.length; i += 7) {
          res?.write(payload.slice(i, i + 7));
          await new Promise((r) => setTimeout(r, 1));
        }
        res?.end();
      })();
    },
    async ({ url }) => {
      const seen: IntentRecallStreamEvent[] = [];
      const outcome = await runIntentRecall({ ...INPUT, baseUrl: url }, new AbortController().signal, (e) => seen.push(e));
      assert.equal(outcome.kind, "done");
      const progressSeen = seen.filter((e) => e.type === "progress");
      assert.equal(progressSeen.length, 40, "40 条 progress 一条不丢");
      assert.equal(seen.filter((e) => e.type === "intent").length, 1, "多字节 scene 完整解析");
      if (progressSeen[39]?.type === "progress") assert.equal(progressSeen[39].done, 40);
    },
  );
});

/** 进入前 signal 已 aborted：直接 cancelled，不悬挂（node:http 重写的边界）。 */
test("预中止：signal 进来时就已 aborted，返回 cancelled 不发请求", async () => {
  await withServer(
    (respond) => respond(['{"type":"error","stage":"config","message":"不该到这","retryable":false}']),
    async ({ url }) => {
      const controller = new AbortController();
      controller.abort();
      const events: IntentRecallStreamEvent[] = [];
      const outcome = await runIntentRecall({ ...INPUT, baseUrl: url }, controller.signal, (e) => events.push(e));
      assert.equal(outcome.kind, "cancelled");
      assert.equal(events.length, 0, "预中止不消费任何事件");
    },
  );
});
