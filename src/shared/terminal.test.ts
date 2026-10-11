import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendReplay,
  clampTerminalDimension,
  isTerminalId,
  pageTerminalOutput,
  stripTerminalControlSequences,
  TERMINAL_DIMENSION_MAX,
  TERMINAL_READ_MAX_LIMIT,
  type TerminalOutputEvent,
} from "./terminal.ts";

describe("isTerminalId —— renderer 铸的 id 过形状闸", () => {
  it("uuid（带连字符）认", () => {
    strictEqual(isTerminalId("3f2504e0-4f89-11d3-9a0c-0305e82c3301"), true);
  });

  it("路径分隔符、空白、控制字符与超长串不认", () => {
    strictEqual(isTerminalId("../../etc/passwd"), false);
    strictEqual(isTerminalId("has space"), false);
    strictEqual(isTerminalId(""), false);
    strictEqual(isTerminalId("a".repeat(65)), false);
    strictEqual(isTerminalId(123), false);
    strictEqual(isTerminalId(undefined), false);
  });
});

describe("clampTerminalDimension —— 行列夹取", () => {
  it("非有限数回退 fallback，负数与 0 抬到 1，越界压到上界，小数向下取整", () => {
    strictEqual(clampTerminalDimension(undefined, 80), 80);
    strictEqual(clampTerminalDimension(Number.NaN, 24), 24);
    strictEqual(clampTerminalDimension(0, 80), 1);
    strictEqual(clampTerminalDimension(-5, 80), 1);
    strictEqual(clampTerminalDimension(TERMINAL_DIMENSION_MAX + 1, 80), TERMINAL_DIMENSION_MAX);
    strictEqual(clampTerminalDimension(12.7, 80), 12);
    strictEqual(clampTerminalDimension(120, 80), 120);
  });
});

describe("appendReplay —— 快照重放缓冲", () => {
  const batch = (sequence: number, data: string): TerminalOutputEvent => ({
    terminalId: "t1",
    sequence,
    data,
  });

  it("按序追加，sequence 前进", () => {
    let buffer = { output: "", sequence: 0 };
    buffer = appendReplay(buffer, batch(1, "abc"), 1024);
    buffer = appendReplay(buffer, batch(2, "def"), 1024);
    deepStrictEqual(buffer, { output: "abcdef", sequence: 2 });
  });

  it("旧批与重复批（sequence 不前进）整个丢掉——renderer 重挂载靠它去重", () => {
    const buffer = { output: "abc", sequence: 3 };
    deepStrictEqual(appendReplay(buffer, batch(2, "stale"), 1024), buffer);
    deepStrictEqual(appendReplay(buffer, batch(3, "repeat"), 1024), buffer);
  });

  it("超容量从头部截断，只留末尾——重放永远从最近的历史开始", () => {
    let buffer = { output: "", sequence: 0 };
    buffer = appendReplay(buffer, batch(1, "a".repeat(600)), 1024);
    buffer = appendReplay(buffer, batch(2, "b".repeat(600)), 1024);
    strictEqual(buffer.output.length, 1024);
    // 前 176 个 a 被截掉，留下 424 个 a + 全部 600 个 b
    strictEqual(buffer.output, "a".repeat(424) + "b".repeat(600));
    strictEqual(buffer.sequence, 2);
  });
});

describe("stripTerminalControlSequences —— 读视图的纯文本化", () => {
  it("CSI：颜色、光标移动、清屏、私有模式整条摘掉，正文留着", () => {
    strictEqual(
      stripTerminalControlSequences("\u001b[32mgreen\u001b[0m plain"),
      "green plain",
    );
    strictEqual(stripTerminalControlSequences("a\u001b[2J\u001b[1;1Hb"), "ab");
    strictEqual(stripTerminalControlSequences("\u001b[?25lhidden\u001b[?25h"), "hidden");
    // 带中间字节与私有参数字符的序列（SGR 的 38;2;r;g;b、DEC 专用 ? ）
    strictEqual(stripTerminalControlSequences("\u001b[38;2;255;0;0mred\u001b[0m"), "red");
  });

  it("OSC：窗口标题与超链接按 BEL / ST 两种收尾都认", () => {
    strictEqual(stripTerminalControlSequences("\u001b]0;my title\u0007body"), "body");
    strictEqual(stripTerminalControlSequences("\u001b]8;;https://x.dev\u001b\\link\u001b]8;;\u001b\\"), "link");
  });

  it("DCS / nF / 单字符转义", () => {
    // DCS 的载荷（sixel、应用层协议）属于序列本身，不显示——连同终止符一起摘掉
    strictEqual(stripTerminalControlSequences("\u001bP1;2q payload \u001b\\rest"), "rest");
    strictEqual(stripTerminalControlSequences("\u001b(Bascii"), "ascii");
    // ESC 7 / ESC 8 是「存 / 取光标」：转义本身不显示，但后面的正文要留
    strictEqual(stripTerminalControlSequences("save\u001b7pos\u001b8"), "save7pos8");
  });

  it("回车：CRLF 折成换行，落单的 CR（PowerShell 进度条）丢掉，其余 C0 只留 \n 与 \t", () => {
    strictEqual(stripTerminalControlSequences("one\r\ntwo\r\n"), "one\ntwo\n");
    strictEqual(stripTerminalControlSequences("progress 10%\rprogress 99%\rdone"), "progress 10%progress 99%done");
    strictEqual(stripTerminalControlSequences("keep\n\ttabs"), "keep\n\ttabs");
    strictEqual(stripTerminalControlSequences("bell\u0007nul\u0000del\u007f"), "bellnuldel");
  });

  it("半条序列不当序列处理：剩下的 ESC 由控制符那一轮收掉，不吞后面的正文", () => {
    // 没配对的 OSC（没有 BEL / ST 收尾）整条都不算序列：ESC 当控制符收掉，正文全留
    strictEqual(stripTerminalControlSequences("bad \u001b]0;title"), "bad ]0;title");
    strictEqual(stripTerminalControlSequences("tail \u001b"), "tail ");
    // 只有 ESC [ 两个字符（没等到终字节）：ESC 当控制符收掉，[ 是正文
    strictEqual(stripTerminalControlSequences("\u001b["), "[");
  });

  it("空缓冲与纯序列缓冲都回空串", () => {
    strictEqual(stripTerminalControlSequences(""), "");
    strictEqual(stripTerminalControlSequences("\u001b[0m\u001b[2J"), "");
  });
});

describe("pageTerminalOutput —— 读视图分页", () => {
  const raw = "line-1\nline-2\nline-3\nline-4\nline-5\n";

  it("缺席 offset = 读末尾 limit 个字符", () => {
    const view = pageTerminalOutput(raw, { limit: 10 });
    strictEqual(view.text, "-4\nline-5\n"); // 末尾 10 个字符
    strictEqual(view.startOffset, raw.length - 10);
    strictEqual(view.endOffset, raw.length);
    strictEqual(view.total, raw.length);
    strictEqual(view.hasMore, false); // 读的就是末尾，没有下一页
  });

  it("默认 limit = 12000，短输出一页读全、没有下一页", () => {
    const view = pageTerminalOutput(raw);
    strictEqual(view.text, raw);
    strictEqual(view.startOffset, 0);
    strictEqual(view.endOffset, raw.length);
    strictEqual(view.hasMore, false);
  });

  it("offset 续读：把上一次的 endOffset 传回去就接着往后", () => {
    const first = pageTerminalOutput(raw, { offset: 0, limit: 7 });
    strictEqual(first.text, "line-1\n");
    strictEqual(first.hasMore, true);
    const second = pageTerminalOutput(raw, { offset: first.endOffset, limit: 7 });
    strictEqual(second.text, "line-2\n");
    strictEqual(second.startOffset, 7);
  });

  it("越界夹取而非报错：limit 超大压到上限、offset 负值抬到 0、超大 offset 读到空", () => {
    const view = pageTerminalOutput(raw, { limit: 999_999 });
    strictEqual(view.text.length, raw.length);
    strictEqual(pageTerminalOutput(raw, { offset: -20, limit: 6 }).startOffset, 0);
    const past = pageTerminalOutput(raw, { offset: 9_999 });
    strictEqual(past.text, "");
    strictEqual(past.startOffset, raw.length);
    strictEqual(past.endOffset, raw.length);
    strictEqual(past.hasMore, false);
  });

  it("limit < 1 抬到 1；坏值（NaN / 数字字符串）按 fallback 与夹取处理", () => {
    strictEqual(pageTerminalOutput(raw, { limit: 0 }).text.length, 1);
    strictEqual(pageTerminalOutput(raw, { limit: Number.NaN }).text, raw);
    strictEqual(pageTerminalOutput(raw, { offset: "0", limit: "6" } as never).text, "line-1");
    strictEqual(pageTerminalOutput(raw, { limit: 999_999 }).text.length <= TERMINAL_READ_MAX_LIMIT, true);
  });

  it("offset 指纯文本视图的坐标：raw 里的控制序列不占位", () => {
    const colored = "\u001b[31mabc\u001b[0mdef";
    const view = pageTerminalOutput(colored, { offset: 0, limit: 3 });
    strictEqual(view.text, "abc");
    strictEqual(view.total, 6);
  });
});
