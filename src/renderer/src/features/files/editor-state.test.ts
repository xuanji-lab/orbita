/**
 * 源码编辑器的纯逻辑账：自动保存调度（防抖 / 取消 / 编译前 flush）、脏状态、冲突判定
 * （自身保存不算冲突）、关标签时的未保存处理、换行保留、光标行列。
 *
 * 定时器用手动时钟注入——不睡真实 1.5 秒，测试是确定性的。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { contentHash } from "../../../../shared/files.ts";
import {
  closeDecision,
  createAutosaveScheduler,
  cursorPosition,
  detectLineEnding,
  isDirty,
  isEditableTexFile,
  isExternalChange,
  toDiskText,
  type TimerSource,
} from "./editor-state.ts";

/** 手动时钟：advance 把到点的回调按预定顺序跑掉 */
function fakeTimers(): TimerSource & { advance: (ms: number) => void; pending: () => number } {
  interface Job {
    id: number;
    at: number;
    run: () => void;
  }
  let now = 0;
  let seq = 0;
  const jobs = new Map<number, Job>();
  return {
    set: (run, ms) => {
      const id = ++seq;
      jobs.set(id, { id, at: now + ms, run });
      return id;
    },
    clear: (handle) => {
      jobs.delete(handle as number);
    },
    advance: (ms) => {
      now += ms;
      const due = [...jobs.values()].filter((job) => job.at <= now).sort((a, b) => a.at - b.at);
      for (const job of due) {
        if (!jobs.has(job.id)) continue;
        jobs.delete(job.id);
        job.run();
      }
    },
    pending: () => jobs.size,
  };
}

describe("自动保存调度（停手 1.5 s）", () => {
  test("连续改动只在停手后触发一次", () => {
    const timers = fakeTimers();
    let saves = 0;
    const scheduler = createAutosaveScheduler({ delayMs: 1500, save: () => (saves += 1), timers });
    scheduler.schedule();
    timers.advance(1000);
    scheduler.schedule();
    timers.advance(1000);
    scheduler.schedule();
    assert.equal(saves, 0, "还在打字，不该写盘");
    timers.advance(1499);
    assert.equal(saves, 0);
    timers.advance(1);
    assert.equal(saves, 1, "停手满 1.5 s 写一次");
    assert.equal(scheduler.pending(), false);
  });

  test("取消之后到点也不再写", () => {
    const timers = fakeTimers();
    let saves = 0;
    const scheduler = createAutosaveScheduler({ delayMs: 1500, save: () => (saves += 1), timers });
    scheduler.schedule();
    scheduler.cancel();
    timers.advance(5000);
    assert.equal(saves, 0);
    assert.equal(scheduler.pending(), false);
  });

  test("编译前 flush：待执行的立刻写、不等计时；没有待执行的不空写", () => {
    const timers = fakeTimers();
    let saves = 0;
    const scheduler = createAutosaveScheduler({ delayMs: 1500, save: () => (saves += 1), timers });
    assert.equal(scheduler.flush(), false);
    scheduler.schedule();
    assert.equal(scheduler.flush(), true);
    assert.equal(saves, 1, "flush 当场写，不等 1.5 s");
    timers.advance(5000);
    assert.equal(saves, 1, "原来的计时已经取消，不会再写第二次");
  });
});

describe("脏状态与换行", () => {
  test("LF 文件：文本变了才脏", () => {
    const saved = contentHash("hello\nworld\n");
    assert.equal(isDirty("hello\nworld\n", saved, "\n"), false);
    assert.equal(isDirty("hello\nworld!\n", saved, "\n"), true);
  });

  test("CRLF 原文件按磁盘格式比指纹：编辑器内部是 \\n 也不算脏", () => {
    const disk = "a\r\nb\r\n";
    const saved = contentHash(disk);
    // CodeMirror 文档内部是 \n，保存时按原文件的 CRLF 序列化
    assert.equal(isDirty("a\nb\n", saved, "\r\n"), false);
    assert.equal(isDirty("a\nc\n", saved, "\r\n"), true);
  });

  test("detectLineEnding：CRLF / LF / 混合按多数", () => {
    assert.equal(detectLineEnding("a\r\nb\r\n"), "\r\n");
    assert.equal(detectLineEnding("a\nb\n"), "\n");
    assert.equal(detectLineEnding("a\r\nb\r\nc\n"), "\r\n");
    assert.equal(detectLineEnding("a\r\nb\nc\n"), "\n");
    assert.equal(detectLineEnding("single line"), "\n");
  });

  test("toDiskText：归一后再按目标换行拼回，不重复 \\r", () => {
    assert.equal(toDiskText("a\nb", "\r\n"), "a\r\nb");
    assert.equal(toDiskText("a\r\nb", "\n"), "a\nb");
    assert.equal(toDiskText("a\r\nb", "\r\n"), "a\r\nb");
  });
});

describe("冲突判定", () => {
  test("盘上指纹与基线不同 = 外部改动", () => {
    const saved = contentHash("mine");
    assert.equal(isExternalChange(contentHash("theirs"), saved), true);
    assert.equal(isExternalChange(contentHash("mine"), saved), false);
  });

  test("自身保存不算冲突：写完把基线换成新指纹，下一次比对相等", () => {
    const before = contentHash("v1");
    const after = contentHash("v2");
    // 写盘成功后基线更新为 after
    assert.equal(isExternalChange(after, after), false);
    assert.equal(isExternalChange(after, before), true, "旧基线会把它当成冲突——所以基线必须跟着写更新");
  });
});

describe("关标签 / 切标签时的未保存处理", () => {
  test("干净直接关；脏先存再关；冲突不替用户决定", () => {
    assert.equal(closeDecision({ dirty: false, conflicted: false }), "close");
    assert.equal(closeDecision({ dirty: true, conflicted: false }), "save");
    assert.equal(closeDecision({ dirty: true, conflicted: true }), "block");
    // 冲突但已不脏（例如重载后）没有要写的：按干净处理
    assert.equal(closeDecision({ dirty: false, conflicted: true }), "close");
  });
});

describe("编辑器覆盖的文件类型与光标", () => {
  test("只有 .tex 走编辑器，大小写不敏感", () => {
    assert.equal(isEditableTexFile("papers/main.tex"), true);
    assert.equal(isEditableTexFile("C:\\p\\MAIN.TEX"), true);
    assert.equal(isEditableTexFile("refs.bib"), false);
    assert.equal(isEditableTexFile("main.tex.bak"), false);
  });

  test("cursorPosition：1 起算的行列", () => {
    const text = "abc\ndef\nghi";
    const doc = {
      lineAt: (offset: number) => {
        const start = text.lastIndexOf("\n", offset - 1) + 1;
        const end = text.indexOf("\n", start);
        return { number: text.slice(0, start).split("\n").length, from: start, to: end < 0 ? text.length : end };
      },
    };
    assert.deepEqual(cursorPosition(doc, 0), { line: 1, column: 1 });
    assert.deepEqual(cursorPosition(doc, 2), { line: 1, column: 3 });
    // 偏移 4 = 第二行第一列
    assert.deepEqual(cursorPosition(doc, 4), { line: 2, column: 1 });
  });
});
