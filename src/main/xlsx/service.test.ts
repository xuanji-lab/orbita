/**
 * xlsx 解析线程的持有者（service.ts）的账：正常回执、线程崩溃后重建、**旧线程的 exit
 * 不能牵连新线程的在途请求**（评审在 #341 抓到的竞态）、超时丢线程、内存上限传给了 Worker。
 *
 * `node:worker_threads` 整个换成假线程：这里要验的是「谁给谁结账」的时序，不是真解析
 * （真解析在 read.test.ts 里对着真文件跑）。假线程是 EventEmitter：测试自己 emit
 * `error` / `exit` / `message`，时序完全可控。
 */
import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// service.ts 用 __dirname 定位打包产物；测试以 ESM 加载它时没有这个绑定，
// 而自由变量会落到 globalThis 上——生产里主进程 bundle 是 CJS，__dirname 本来就有。
(globalThis as unknown as { __dirname: string }).__dirname = HERE;

class FakeWorker extends EventEmitter {
  static created: FakeWorker[] = [];
  readonly sent: unknown[] = [];
  readonly options: unknown;
  terminated = false;

  constructor(_path: string, options?: unknown) {
    super();
    this.options = options;
    FakeWorker.created.push(this);
  }

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }
}

mock.module("node:worker_threads", { namedExports: { Worker: FakeWorker } });
const service = await import("./service.ts");

/** 等一个 tick，让 promise 的 then/catch 都跑过 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const lastWorker = (): FakeWorker => {
  const worker = FakeWorker.created.at(-1);
  assert.ok(worker !== undefined, "没有创建线程");
  return worker;
};

const lastRequestId = (worker: FakeWorker): number => {
  const message = worker.sent.at(-1) as { id: number } | undefined;
  assert.ok(message !== undefined, "没有发出请求");
  return message.id;
};

const preview = { kind: "unreadable", reason: "corrupt", detail: "x", size: 1, modifiedAt: 0 } as const;

describe("readXlsxInWorker", () => {
  test("回执按 id 对号：resolve 预览结果", async () => {
    const promise = service.readXlsxInWorker("/tmp/a.xlsx", 0);
    const worker = lastWorker();
    assert.equal(worker.sent.length > 0, true);
    worker.emit("message", { id: lastRequestId(worker), ok: true, preview });
    assert.deepEqual(await promise, preview);
  });

  test("Worker 带堆上限（resourceLimits）", () => {
    const worker = lastWorker();
    assert.deepEqual(worker.options, {
      resourceLimits: { maxOldGenerationSizeMb: service.XLSX_WORKER_HEAP_MB },
    });
  });

  test("线程 error 后重建：旧线程随后的 exit 不牵连新线程的在途请求", async () => {
    const before = FakeWorker.created.length;
    // 第一次请求挂在崩溃的线程上
    const doomed = service.readXlsxInWorker("/tmp/big.xlsx", 0);
    const oldWorker = lastWorker();
    const failures: string[] = [];
    doomed.catch((cause: Error) => failures.push(cause.message));
    oldWorker.emit("error", new Error("heap out of memory"));
    await flush();
    assert.equal(failures.length, 1, "崩溃线程上的请求要被拒");

    // 新线程接住下一条请求
    const fresh = service.readXlsxInWorker("/tmp/ok.xlsx", 0);
    const newWorker = lastWorker();
    assert.notEqual(newWorker, oldWorker);
    assert.equal(FakeWorker.created.length, before + 1, "应当只重建一条线程");

    // 旧线程的 exit 晚到：不能把新线程的请求也结掉
    oldWorker.emit("exit", 1);
    await flush();
    let settled = false;
    void fresh.then(
      () => (settled = true),
      () => (settled = true),
    );
    await flush();
    assert.equal(settled, false, "新线程的请求不该被旧线程的 exit 结算");

    newWorker.emit("message", { id: lastRequestId(newWorker), ok: true, preview });
    assert.deepEqual(await fresh, preview);
  });

  test("超时：拒掉这条请求、丢弃整条线程，下一次请求重建", async () => {
    const slow = service.readXlsxInWorker("/tmp/slow.xlsx", 0, 20);
    const timedOut = lastWorker();
    await assert.rejects(slow, /解析超时/);
    assert.equal(timedOut.terminated, true, "超时线程要被丢弃");

    const next = service.readXlsxInWorker("/tmp/next.xlsx", 0, 20);
    const replacement = lastWorker();
    assert.notEqual(replacement, timedOut, "超时之后要重建线程，不能再用被丢弃的那条");
    // 收尾：让它也超时，别给测试进程留一个悬着的计时器
    await assert.rejects(next, /解析超时/);
  });

  test("worker 回执 ok:false：reject 带原因", async () => {
    const promise = service.readXlsxInWorker("/tmp/bad.xlsx", 0);
    const worker = lastWorker();
    worker.emit("message", { id: lastRequestId(worker), ok: false, error: "坏了" });
    await assert.rejects(promise, /坏了/);
  });
});
