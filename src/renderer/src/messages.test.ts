import { deepStrictEqual } from "node:assert/strict";
import { describe, test } from "node:test";
import { en } from "./messages-en.ts";
import { zh } from "./messages-zh.ts";

/**
 * 「纯中文」的可执行定义：zh 表里每一条（函数用样例参数调一遍）出现的拉丁字母词，
 * 只能是下面白名单里的——品牌名、协议 / 格式名、模型与服务商名、按键名、
 * 其他应用的名字（迁移来源）、文件名。其余一律写中文。
 *
 * 新增文案撞到这里时：先想能不能说成中文；确实是专名，再加进白名单并写明它属于哪一类。
 */
const ALLOWED_LATIN = new Set([
  // 品牌
  "orbita",
  // 协议 / 格式 / 技术名
  "MCP",
  "API",
  "URL",
  "JSON",
  "JSONL",
  "SSE",
  "HTTP",
  "Markdown",
  "stdio",
  // 计量单位（与原型「42 tok/s」一致）
  "token",
  "tok",
  // 按键名
  "Ctrl",
  "Alt",
  "Shift",
  "Enter",
  "Esc",
  "Cmd",
]);

type Entry = { path: string; text: string };

/** 把表摊平成 (键路径, 文本)；函数按参数个数塞样例参数 */
function flatten(table: object, prefix = ""): Entry[] {
  const out: Entry[] = [];
  for (const [key, value] of Object.entries(table)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof value === "string") out.push({ path, text: value });
    else if (typeof value === "function") {
      const fn = value as (...args: unknown[]) => unknown;
      // 数量取 1 和 3 各调一次：单复数、量词分支都走到
      for (const sample of [1, 3]) {
        out.push({ path: `${path}(${sample})`, text: String(fn(...Array.from({ length: fn.length }, () => sample))) });
      }
    } else if (typeof value === "object" && value !== null) out.push(...flatten(value, path));
  }
  return out;
}

/** 表的形状：键路径的集合（函数只记键，不记返回值） */
function shape(table: object, prefix = ""): string[] {
  return Object.entries(table).flatMap(([key, value]) => {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    return typeof value === "object" && value !== null ? shape(value, path) : [`${path}:${typeof value}`];
  });
}

describe("messages —— 中英两张表", () => {
  test("形状一致：zh 与 en 的键、值类型一一对应（类型已经管着，这里防 as 之类的绕过）", () => {
    deepStrictEqual(shape(zh).sort(), shape(en).sort());
  });

  test("zh 是纯中文：拉丁字母词只能是白名单里的专名", () => {
    const offenders: string[] = [];
    for (const { path, text } of flatten(zh)) {
      // 带点、连字符的算一个词（mcp.json、SKILL.md）；单个大写字母是按键（Ctrl+Alt+D）
      const words = text.match(/[A-Za-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*/g) ?? [];
      const bad = words.filter((word) => !ALLOWED_LATIN.has(word) && !/^[A-Z]$/.test(word));
      if (bad.length > 0) offenders.push(`${path}: ${bad.join(", ")}  ←  ${text}`);
    }
    deepStrictEqual(offenders, []);
  });

  test("zh 用全角标点：不出现半角逗号、问号、冒号、括号接汉字", () => {
    const offenders = flatten(zh)
      .filter(({ text }) => /[\u4e00-\u9fff][,?:!;()]|[,?:!;()][\u4e00-\u9fff]/.test(text))
      .map(({ path, text }) => `${path}: ${text}`);
    deepStrictEqual(offenders, []);
  });
});
