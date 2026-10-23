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
  "GitHub",
  // 协议 / 格式 / 技术名
  "MCP",
  "Git",
  "API",
  "URL",
  "JSON",
  "JSONL",
  "SSE",
  "HTTP",
  "Markdown",
  "stdio",
  "http",
  "https",
  // 图片格式名（附图的准入提示）
  "PNG",
  "JPEG",
  "GIF",
  "WebP",
  "MB",
  // 文档格式名（PDF 预览与引用）
  "PDF",
  // 格式记号（环境变量 / 请求头一行的写法，原样照填）
  "KEY",
  "VALUE",
  // 命令名与工具名前缀（用户照抄的字面量）
  "node",
  "npx",
  "mcp",
  // 计量单位（与原型「42 tok/s」一致；复数形式同属一个单位词）
  "token",
  "tok",
  "tokens",
  // 通用缩写：代码托管与模型的 ID
  "PR",
  "ID",
  // git 尾注名（原样写进提交，不能翻）
  "Co-Authored-By",
  // 迁移来源（其他应用的名字）
  "Proma",
  // 意图系统的本机服务与管线（召回走它；界面里只有名字没有第二写法）
  "intent-lab",
  "DeepSeek",
  "deepseek",
  "endpoints",
  // 排版工具链的名字（用户照抄的字面量：发行版 / 构建器 / 包管理器 / 文件类型）
  "LaTeX",
  "latexmk",
  "tlmgr",
  "tex",
  "Claude",
  "Code",
  // Claude 订阅的档位名（产品自称，不译）与登录域名
  "Pro",
  "Max",
  "claude.ai",
  "Kimi",
  "opencode",
  "Reasonix",
  "ZCode",
  "Desktop",
  // 登录状态导入的来源浏览器（其他应用的名字）
  "Chrome",
  "Edge",
  "Brave",
  "Arc",
  "Chromium",
  // 技术名：登录状态导入的对象就是 cookie（说「登录 cookie」最准，不译成「小甜饼」）
  "cookie",
  // 系统名（macOS 钥匙串授权的提示）
  "macOS",
  // 文件名
  "mcp.json",
  "SKILL.md",
  "AGENTS.md",
  // MCP 配置的字段名与变量名（用户要照抄进 mcp.json 的字面量）
  "workspaces",
  "workspaceFolder",
  // 产品名（迁移来源的显示名，与 Proma / Kimi / opencode 同类）
  "Codex",
  // 语音厂商控制台里的字段名与资源 ID（火山引擎豆包语音，用户原样照填）
  "APP",
  "Access",
  "Token",
  "Resource",
  "volc.seedasr.sauc.duration",
  "volc.bigasr.sauc.duration",
  // 语音厂商凭证字段名（阶跃星辰 API Key，用户原样照填）
  "Key",
  // 按键名
  "Ctrl",
  "Alt",
  "Shift",
  "Enter",
  "Esc",
  "Tab",
  "Cmd",
]);

type Entry = { path: string; text: string };

/**
 * 函数条目默认拿数字样例（1 与 3）调用；参数不是「任意数 / 任意串」的在这里给样例。
 * 值取英文——zh 函数把它原样拼进句子时，守卫要能看出来这是参数不是文案，
 * 所以样例都用白名单里的词或纯数字。
 */
const SAMPLE_ARGS: Record<string, unknown[][]> = {
  thinkingLevel: [["xhigh", "claude-opus-4-6"], ["medium", null]],
  // 语音文案的参数是厂商 id：两家各调一遍，插值出来的名字才被守卫看到
  "voice.failures.not-configured": [["doubao"], ["stepfun"]],
  "voice.failures.unauthorized": [["doubao"], ["stepfun"]],
  "voice.failures.rejected": [["doubao"], ["stepfun"]],
  "voice.failures.network": [["doubao"], ["stepfun"]],
  "voice.failures.timeout": [["doubao"], ["stepfun"]],
  "voice.failures.server": [["doubao"], ["stepfun"]],
  "voice.connecting": [["doubao"], ["stepfun"]],
  "voice.testOk": [["doubao"], ["stepfun"]],
};

/** 把表摊平成 (键路径, 文本)；函数按参数个数塞样例参数 */
function flatten(table: object, prefix = ""): Entry[] {
  const out: Entry[] = [];
  for (const [key, value] of Object.entries(table)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof value === "string") out.push({ path, text: value });
    else if (typeof value === "function") {
      const fn = value as (...args: unknown[]) => unknown;
      // 数量取 1 和 3 各调一次：单复数、量词分支都走到
      const samples = SAMPLE_ARGS[path] ?? [1, 3].map((n) => Array.from({ length: fn.length }, () => n));
      for (const args of samples) out.push({ path: `${path}(${args.join(", ")})`, text: String(fn(...args)) });
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
      // 路径（/v1/messages、/compact）与带单位的数（128k、1M）先剔掉：它们是字面量不是词
      const bare = text.replace(/\/[\w./-]+/g, " ").replace(/\d+(?:\.\d+)?[kKM]\b/g, " ");
      // 带点、连字符的算一个词（mcp.json、SKILL.md）；单个大写字母是按键（Ctrl+Alt+D）
      const words = bare.match(/[A-Za-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*/g) ?? [];
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

  test("首页批语落当天日期：中文「阅 月.日」，英文照美式缩写（Sept，不写 Sep）", () => {
    deepStrictEqual(
      [zh.chat.homeMark(9, 25), en.chat.homeMark(9, 25), en.chat.homeMark(3, 1), en.chat.homeMark(12, 31)],
      ["字迹工整　阅 9.25", "Neat. — Sept 25", "Neat. — March 1", "Neat. — Dec 31"],
    );
  });

  test("zh 的相对时间与数量：量词齐全，数字与汉字之间一个空格", () => {
    deepStrictEqual(
      [zh.time.minutesAgo(5), zh.time.hoursAgo(2), zh.time.daysAgo(3), zh.chat.subSessionCount(2)],
      ["5 分钟前", "2 小时前", "3 天前", "2 个子会话"],
    );
    deepStrictEqual([en.time.hoursAgo(2), en.chat.subSessionCount(1), en.chat.subSessionCount(2)], [
      "2h ago",
      "1 sub-session",
      "2 sub-sessions",
    ]);
  });
});
