/**
 * 进程树 CPU 采样的测试：只测解析与求和（真快照在 bash-stall.test.ts 的集成用例里走一遍）。
 *
 * 解析是最容易悄悄错的地方——`/proc` 的 comm 可以带空格与括号，`ps` 的 time 有三种形态，
 * Windows 的时间单位是 100 纳秒。错一位不会报错，只会让「CPU 有没有涨」这个判断反着答。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseLinuxProcStat,
  parsePsCpuTimeToMs,
  parsePsTable,
  parseWindowsProcessTable,
  sumTreeCpuMs,
} from "./proc-tree.ts";

describe("parseLinuxProcStat", () => {
  test("comm 带空格与括号也切得对（从最后一个 ) 起算）", () => {
    // 第 2 字段 comm = "(my weird) name"；ppid=1，utime=150，stime=50
    const line =
      "1234 (my weird) name) S 1 1234 1234 0 -1 4194560 100 0 0 0 150 50 0 0 20 0 1 0 500 1000 100";
    const node = parseLinuxProcStat(line, 100);
    assert.deepEqual(node, { parentPid: 1, cpuMs: 2_000 });
  });

  test("字段不够 / ppid 非数字 → null", () => {
    assert.equal(parseLinuxProcStat("1234 (sh)"), null);
    assert.equal(parseLinuxProcStat("1234 (sh) S x 1 1 0 0 0 0 0 0 10 10 0"), null);
  });
});

describe("parsePsCpuTimeToMs（macOS 等没有 /proc 的平台）", () => {
  test("三种形态：MM:SS.ss / HH:MM:SS / D-HH:MM:SS", () => {
    assert.equal(parsePsCpuTimeToMs("0:05.42"), 5_420);
    assert.equal(parsePsCpuTimeToMs("12:34"), 754_000);
    assert.equal(parsePsCpuTimeToMs("1:02:03"), 3_723_000);
    assert.equal(parsePsCpuTimeToMs("2-01:02:03"), 176_523_000);
  });

  test("读不到（ps 给 - 或空）→ null", () => {
    assert.equal(parsePsCpuTimeToMs("-"), null);
    assert.equal(parsePsCpuTimeToMs(""), null);
    assert.equal(parsePsCpuTimeToMs("oops"), null);
  });

  test("表解析：CPU 读不到的行整行丢掉（当 0 会把「在干活」判成停滞）", () => {
    const table = parsePsTable("  1     0 0:01.00\n  2     1      -\n  3  oops 0:00.10\n");
    assert.deepEqual([...table.keys()], [1]);
  });
});

describe("parseWindowsProcessTable", () => {
  test("KernelModeTime + UserModeTime 是 100ns 单位 → 除 10000 得毫秒", () => {
    const table = parseWindowsProcessTable("  100   4   500000  500000\r\n  101 100 0 0\r\n");
    assert.deepEqual(table.get(100), { parentPid: 4, cpuMs: 100 });
    assert.deepEqual(table.get(101), { parentPid: 100, cpuMs: 0 });
  });

  test("受保护进程吐空值 → 整行丢，不当 0（否则会少算 CPU → 误报停滞）", () => {
    const table = parseWindowsProcessTable("4 0\n8 4 100 100");
    assert.deepEqual([...table.keys()], [8]);
  });
});

describe("sumTreeCpuMs：内存 BFS 求整棵子树", () => {
  const table = new Map([
    [10, { parentPid: 1, cpuMs: 10 }],
    [11, { parentPid: 10, cpuMs: 20 }],
    [12, { parentPid: 11, cpuMs: 5 }], // 孙进程：中间那层常常先退，必须算进来
    [20, { parentPid: 1, cpuMs: 999 }], // 兄弟树：不属于 root
  ]);

  test("root + 全部后代，不算兄弟", () => {
    assert.equal(sumTreeCpuMs(table, 10), 35);
    assert.equal(sumTreeCpuMs(table, 11), 25);
  });

  test("root 不在表里（已退出）→ null，调用方必须放弃判定", () => {
    assert.equal(sumTreeCpuMs(table, 99), null);
  });

  test("pid 复用造出的环不会死循环", () => {
    const cyclic = new Map([
      [1, { parentPid: 2, cpuMs: 1 }],
      [2, { parentPid: 1, cpuMs: 1 }],
    ]);
    assert.equal(sumTreeCpuMs(cyclic, 1), 2);
  });
});
