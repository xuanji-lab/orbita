import { deepStrictEqual } from "node:assert/strict";
import { describe, test } from "node:test";
import {
  flushAllDocx,
  flushAllDocxForLeave,
  flushDocxAt,
  flushDocxForLeave,
  hasPendingDocx,
  registerDocxFlush,
  type DocxFlushOutcome,
} from "./docx-flush.ts";

const ok: DocxFlushOutcome = { ok: true };

describe("docx 切走前的 flush 登记表", () => {
  test("没登记过的路径：直接成功（不是 docx / 已经关掉）", async () => {
    deepStrictEqual(await flushDocxAt("/nowhere/paper.docx"), ok);
    deepStrictEqual(await flushDocxAt(null), ok);
  });

  test("登记后会调到那一个 flush，注销之后不再调", async () => {
    let calls = 0;
    const off = registerDocxFlush("/a/paper.docx", {
      flush: async () => {
        calls += 1;
        return ok;
      },
      pending: () => true,
    });
    await flushDocxAt("/a/paper.docx");
    deepStrictEqual(calls, 1);
    off();
    await flushDocxAt("/a/paper.docx");
    deepStrictEqual(calls, 1);
  });

  test("失败原样传给调用方（取值不吞）", async () => {
    const failing = { ok: false as const, reason: "conflict" as const };
    const off = registerDocxFlush("/b/paper.docx", { flush: async () => failing, pending: () => true });
    deepStrictEqual(await flushDocxAt("/b/paper.docx"), failing);
    off();
  });

  test("同一路径重新登记：旧的注销函数不会把新的摘掉", async () => {
    const first = registerDocxFlush("/c/paper.docx", { flush: async () => ok, pending: () => false });
    let secondCalled = 0;
    const second = registerDocxFlush("/c/paper.docx", {
      flush: async () => {
        secondCalled += 1;
        return ok;
      },
      pending: () => true,
    });
    first();
    await flushDocxAt("/c/paper.docx");
    deepStrictEqual(secondCalled, 1);
    second();
  });

  test("flushAllDocx：按登记顺序逐份 flush，任何一份失败就整次失败", async () => {
    const calls: string[] = [];
    const offA = registerDocxFlush("/d/a.docx", {
      flush: async () => {
        calls.push("a");
        return ok;
      },
      pending: () => true,
    });
    const offB = registerDocxFlush("/d/b.docx", {
      flush: async () => {
        calls.push("b");
        return { ok: false, reason: "blocked" };
      },
      pending: () => true,
    });
    const offC = registerDocxFlush("/d/c.docx", {
      flush: async () => {
        calls.push("c");
        return ok;
      },
      pending: () => false,
    });
    deepStrictEqual(await flushAllDocx(), { ok: false, reason: "blocked" });
    deepStrictEqual(calls, ["a", "b"]);
    offA();
    offB();
    offC();
    deepStrictEqual(await flushAllDocx(), ok);
  });

  test("ForLeave：没有待存改动就不调用 flush（不把一次点击变成异步等待）", async () => {
    let calls = 0;
    const off = registerDocxFlush("/f/idle.docx", {
      flush: async () => {
        calls += 1;
        return ok;
      },
      pending: () => false,
    });
    deepStrictEqual(await flushDocxForLeave("/f/idle.docx"), ok);
    deepStrictEqual(calls, 0);
    deepStrictEqual(await flushAllDocxForLeave(), ok);
    deepStrictEqual(calls, 0);
    off();
  });

  test("ForLeave：有待存改动才真的 flush，并把 cause 传成 leave", async () => {
    const causes: string[] = [];
    const off = registerDocxFlush("/g/dirty.docx", {
      flush: async (cause) => {
        causes.push(cause);
        return { ok: false, reason: "failed" };
      },
      pending: () => true,
    });
    deepStrictEqual(await flushDocxForLeave("/g/dirty.docx"), { ok: false, reason: "failed" });
    deepStrictEqual(causes, ["leave"]);
    off();
  });

  test("hasPendingDocx 是同步的：任一份待存就是 true", () => {
    const before = hasPendingDocx();
    const off = registerDocxFlush("/e/paper.docx", { flush: async () => ok, pending: () => true });
    deepStrictEqual(hasPendingDocx(), true);
    off();
    deepStrictEqual(hasPendingDocx(), before);
  });
});
