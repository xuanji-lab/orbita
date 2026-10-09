import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_PENDING_OUTPUT_CHARS,
  OUTPUT_FLUSH_DELAY_MS,
  OutputPipeline,
} from "./output-batcher.ts";
import type { TerminalOutputEvent } from "../shared/terminal.ts";

/** 收集 send 出去的批 */
function collector() {
  const sent: TerminalOutputEvent[] = [];
  const exits: { terminalId: string; exitCode: number }[] = [];
  return {
    sent,
    exits,
    pipeline: new OutputPipeline(
      (event) => sent.push(event),
      (terminalId, exitCode) => exits.push({ terminalId, exitCode }),
    ),
  };
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("OutputPipeline —— 16ms 批量", () => {
  it("16ms 窗口内的多段输出合成一批，序号从 1 起", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { pipeline, sent } = collector();
    pipeline.track("t1");
    pipeline.enqueue("t1", "hel");
    pipeline.enqueue("t1", "lo");
    strictEqual(sent.length, 0);
    t.mock.timers.tick(OUTPUT_FLUSH_DELAY_MS);
    deepStrictEqual(sent, [{ terminalId: "t1", sequence: 1, data: "hello" }]);
  });

  it("一批在飞时不发新批（背压），ack 以后才冲", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { pipeline, sent } = collector();
    pipeline.track("t1");
    pipeline.enqueue("t1", "one");
    t.mock.timers.tick(OUTPUT_FLUSH_DELAY_MS);
    deepStrictEqual(sent.length, 1);
    // 在飞期间又来的输出：timer 到点也不发
    pipeline.enqueue("t1", "two");
    t.mock.timers.tick(OUTPUT_FLUSH_DELAY_MS * 10);
    strictEqual(sent.length, 1);
    // ack 到了（renderer 画完）才冲下一批
    pipeline.acknowledge("t1", 1);
    deepStrictEqual(sent.length, 2);
    deepStrictEqual(sent[1], { terminalId: "t1", sequence: 2, data: "two" });
  });

  it("过期序号的 ack 不动背压；快照的更新序号 ack（>=）能解开它", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { pipeline, sent } = collector();
    pipeline.track("t1");
    pipeline.enqueue("t1", "a");
    t.mock.timers.tick(OUTPUT_FLUSH_DELAY_MS);
    pipeline.enqueue("t1", "b");
    // 过期 ack（< 在飞序号）：忽略
    pipeline.acknowledge("t1", 0);
    t.mock.timers.tick(OUTPUT_FLUSH_DELAY_MS);
    strictEqual(sent.length, 1);
    // renderer 整页刷新后拿快照的 sequence 来 ack（比在飞批新）：同样要解开
    pipeline.acknowledge("t1", 99);
    deepStrictEqual(sent.length, 2);
  });
});

describe("OutputPipeline —— 积压上限与丢弃标记", () => {
  it("pending 超过 1MB 就丢字，冲批时带黄色丢弃标记", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { pipeline, sent } = collector();
    pipeline.track("t1");
    // 一段塞满 1MB，再来一段触发丢弃计数
    pipeline.enqueue("t1", "x".repeat(MAX_PENDING_OUTPUT_CHARS));
    pipeline.enqueue("t1", "overflow-bytes");
    t.mock.timers.tick(OUTPUT_FLUSH_DELAY_MS);
    strictEqual(sent.length, 1);
    const batch = sent[0] ?? { terminalId: "", sequence: 0, data: "" };
    strictEqual(batch.sequence, 1);
    strictEqual(batch.data.includes("overflow-bytes"), false);
    strictEqual(batch.data.includes("已丢弃 14 个字符"), true);
  });

  it("1MB 满格之后的输出全部计丢弃，不再保留", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { pipeline, sent } = collector();
    pipeline.track("t1");
    pipeline.enqueue("t1", "x".repeat(MAX_PENDING_OUTPUT_CHARS));
    pipeline.enqueue("t1", "yyy");
    pipeline.enqueue("t1", "zzz");
    t.mock.timers.tick(OUTPUT_FLUSH_DELAY_MS);
    strictEqual(sent.length, 1);
    strictEqual((sent[0] ?? { data: "" }).data.includes("已丢弃 6 个字符"), true);
  });
});

describe("OutputPipeline —— 退出的时序", () => {
  it("exit 攒到输出排空（ack 冲完最后一批）才发", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { pipeline, sent, exits } = collector();
    pipeline.track("t1");
    pipeline.enqueue("t1", "tail output");
    // exit 时还有一批在飞：不能立刻发
    pipeline.enqueue("t1", "tail output");
    t.mock.timers.tick(OUTPUT_FLUSH_DELAY_MS);
    strictEqual(pipeline.exit("t1", 3), true);
    strictEqual(exits.length, 0);
    pipeline.acknowledge("t1", 1);
    deepStrictEqual(exits, [{ terminalId: "t1", exitCode: 3 }]);
    // 发过 exit 之后的 ack 是空操作
    pipeline.acknowledge("t1", 1);
    deepStrictEqual(exits.length, 1);
    void sent;
  });

  it("输出早就排空的 exit 当场发", () => {
    const { pipeline, exits } = collector();
    pipeline.track("t1");
    strictEqual(pipeline.exit("t1", 0), true);
    deepStrictEqual(exits, [{ terminalId: "t1", exitCode: 0 }]);
  });

  it("不认识的终端 exit 返回 false（调用方自己兜底上报）", () => {
    const { pipeline, exits } = collector();
    strictEqual(pipeline.exit("ghost", 1), false);
    strictEqual(exits.length, 0);
  });
});

describe("OutputPipeline —— drop 与 dispose", () => {
  it("drop 把攒着的尾巴立刻冲出去，之后 enqueue 是空操作", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { pipeline, sent } = collector();
    pipeline.track("t1");
    pipeline.enqueue("t1", "last words");
    pipeline.drop("t1");
    deepStrictEqual(sent, [{ terminalId: "t1", sequence: 1, data: "last words" }]);
    pipeline.enqueue("t1", "noise");
    t.mock.timers.tick(OUTPUT_FLUSH_DELAY_MS * 10);
    strictEqual(sent.length, 1);
  });

  it("dispose 撤掉计时器，不留悬挂回调", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { pipeline, sent } = collector();
    pipeline.track("t1");
    pipeline.enqueue("t1", "pending");
    pipeline.dispose();
    t.mock.timers.tick(OUTPUT_FLUSH_DELAY_MS * 100);
    await drainMicrotasks();
    strictEqual(sent.length, 0);
  });
});
