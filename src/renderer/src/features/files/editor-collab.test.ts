/**
 * 人和 agent 同时改同一个文件的安全边界：写入集（谁在写 / 写完了没）、按块的差异、
 * 块的定位与撤销判定、重载后的光标落点。
 *
 * 关注点分三层，测试也按这三层写：
 *   1. 路径解析与写入集——本轮只算最后一条 user 消息之后，上一轮的残留不能制造永久只读
 *   2. 差异块——上下文行、±行数、只差末尾换行要整块丢掉（否则会出现「撤了等于没撤」的块）
 *   3. 定位——用户手改过的块必须找不到（= 不可撤），别处的编辑不能让块整体失效
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import {
  agentWritesInTurn,
  clampCursorLine,
  diffHunks,
  isPossibleWriteTool,
  locateBlock,
  nonOverlappingChanges,
  pruneStaleIds,
  resolveToolPath,
  syncDecision,
  writePhaseOf,
  type EditorHunk,
} from "./editor-collab.ts";

function userItem(id: string): TranscriptItem {
  return { id, role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 };
}

function assistantItem(id: string, blocks: unknown[]): TranscriptItem {
  return { id, role: "assistant", content: blocks, timestamp: 0 } as TranscriptItem;
}

function toolItem(toolCallId: string, isError = false): TranscriptItem {
  return {
    id: `tool-${toolCallId}`,
    role: "tool",
    toolCallId,
    toolName: "write",
    input: {},
    content: [],
    timestamp: 0,
    status: "complete",
    isError,
  } as TranscriptItem;
}

function writeCall(toolCallId: string, path: string, toolName = "write"): unknown {
  return { type: "toolCall", toolCallId, toolName, input: { path } };
}

describe("resolveToolPath", () => {
  test("相对路径按 cwd 拼（两种分隔符都归一成 /）", () => {
    assert.equal(resolveToolPath("main.tex", "C:\\paper\\proj"), "C:/paper/proj/main.tex");
    assert.equal(resolveToolPath("sections/intro.tex", "C:\\paper\\proj"), "C:/paper/proj/sections/intro.tex");
  });

  test("绝对路径原样归一：盘符、POSIX、UNC", () => {
    assert.equal(resolveToolPath("C:\\paper\\main.tex", "/home/x"), "C:/paper/main.tex");
    assert.equal(resolveToolPath("/home/x/main.tex", "/home/x"), "/home/x/main.tex");
    assert.equal(resolveToolPath("\\\\server\\share\\a.tex", "/home/x"), "//server/share/a.tex");
  });

  test("`.` / `..` 折叠，不留尾部分隔符", () => {
    assert.equal(resolveToolPath("./a/../b.tex", "/w"), "/w/b.tex");
    assert.equal(resolveToolPath("a/b/", "/w"), "/w/a/b");
  });

  test("`~` 与空串不认（renderer 不知道家目录，不猜）", () => {
    assert.equal(resolveToolPath("~/papers/main.tex", "/w"), null);
    assert.equal(resolveToolPath("   ", "/w"), null);
    assert.equal(resolveToolPath("main.tex", null), null);
  });
});

describe("agentWritesInTurn", () => {
  test("本轮 write / edit 的路径；有结果 = done，没结果 = writing", () => {
    const transcript: TranscriptItem[] = [
      userItem("u1"),
      assistantItem("a1", [writeCall("c1", "./main.tex"), writeCall("c2", "./refs.bib")]),
      toolItem("c1"),
    ];
    const writes = agentWritesInTurn(transcript, "C:\\paper");
    assert.deepEqual(writes, [
      { path: "C:/paper/main.tex", phase: "done" },
      { path: "C:/paper/refs.bib", phase: "writing" },
    ]);
  });

  test("同一文件本轮再写一次：又回到 writing（上一份 after 已不是它手里的底本）", () => {
    const transcript: TranscriptItem[] = [
      userItem("u1"),
      assistantItem("a1", [writeCall("c1", "main.tex", "edit")]),
      toolItem("c1"),
      assistantItem("a2", [writeCall("c2", "main.tex", "edit")]),
    ];
    assert.deepEqual(agentWritesInTurn(transcript, "/w"), [{ path: "/w/main.tex", phase: "writing" }]);
  });

  test("上一轮没结果的调用不传染到这一轮（否则文件永远只读）", () => {
    const transcript: TranscriptItem[] = [
      userItem("u1"),
      assistantItem("a1", [writeCall("c1", "main.tex")]),
      // 这一轮被中断：结果没回来
      userItem("u2"),
      assistantItem("a2", [writeCall("c2", "other.tex")]),
      toolItem("c2"),
    ];
    assert.deepEqual(agentWritesInTurn(transcript, "/w"), [{ path: "/w/other.tex", phase: "done" }]);
  });

  test("工具报错也算落定：它不会再写了", () => {
    const transcript: TranscriptItem[] = [
      userItem("u1"),
      assistantItem("a1", [writeCall("c1", "main.tex")]),
      toolItem("c1", true),
    ];
    assert.deepEqual(agentWritesInTurn(transcript, "/w"), [{ path: "/w/main.tex", phase: "done" }]);
  });

  test("别的工具（read / bash）不进写入集", () => {
    const transcript: TranscriptItem[] = [
      userItem("u1"),
      assistantItem("a1", [
        writeCall("c1", "a.tex", "read"),
        writeCall("c2", "b.tex", "bash"),
        writeCall("c3", "c.tex", "write"),
      ]),
    ];
    assert.deepEqual(agentWritesInTurn(transcript, "/w"), [{ path: "/w/c.tex", phase: "writing" }]);
  });

  test("没有 user 消息 = 不在任何一轮里，返回空", () => {
    assert.deepEqual(agentWritesInTurn([assistantItem("a1", [writeCall("c1", "a.tex")])], "/w"), []);
  });

  test("writePhaseOf 按 samePath 比（树里 `/`、主进程 `\\`）", () => {
    const writes = agentWritesInTurn(
      [userItem("u1"), assistantItem("a1", [writeCall("c1", "C:\\paper\\main.tex")])],
      null,
    );
    assert.equal(writePhaseOf(writes, "c:/paper/Main.tex"), "writing");
    assert.equal(writePhaseOf(writes, "/paper/main.tex"), null);
  });
});

const BEFORE = [
  "\\documentclass{article}",
  "\\begin{document}",
  "Hello",
  "\\section{One}",
  "para a",
  "para b",
  "para c",
  "para d",
  "old line",
  "\\end{document}",
].join("\n");

const AFTER = [
  "\\documentclass{article}",
  "\\usepackage{amsmath}",
  "\\begin{document}",
  "Hello",
  "\\section{One}",
  "para a",
  "para b",
  "para c",
  "para d",
  "new line",
  "\\end{document}",
].join("\n");

/** 取第 n 项（noUncheckedIndexedAccess 下测试里也要显式认账） */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  assert.ok(value !== undefined, `缺第 ${index} 项`);
  return value;
}

describe("diffHunks", () => {
  test("两处改动各自成块，带上下文行", () => {
    const hunks = diffHunks(BEFORE, AFTER);
    assert.equal(hunks.length, 2);
    assert.deepEqual(
      hunks.map((hunk) => [hunk.added, hunk.removed]),
      [
        [1, 0],
        [1, 1],
      ],
    );
    // 第一块是纯插入：改动前的块 = 上下文本身（上下各 3 行）
    assert.deepEqual(at(hunks, 0).before, [
      "\\documentclass{article}",
      "\\begin{document}",
      "Hello",
      "\\section{One}",
    ]);
    assert.deepEqual(at(hunks, 0).after, [
      "\\documentclass{article}",
      "\\usepackage{amsmath}",
      "\\begin{document}",
      "Hello",
      "\\section{One}",
    ]);
    assert.equal(at(hunks, 0).preview, "\\usepackage{amsmath}");
  });

  test("内容相同 = 没有块；只差末尾换行也整块丢掉", () => {
    assert.deepEqual(diffHunks("a\nb", "a\nb"), []);
    assert.deepEqual(diffHunks("a\nb\n", "a\nb"), []);
  });

  test("CRLF 与 LF 的同一份内容不算改动", () => {
    assert.deepEqual(diffHunks("a\r\nb\r\n", "a\nb\n"), []);
  });

  test("纯删除块的预览取被删的第一行", () => {
    const hunks = diffHunks("a\nx\nb", "a\nb");
    assert.equal(hunks.length, 1);
    assert.equal(at(hunks, 0).added, 0);
    assert.equal(at(hunks, 0).removed, 1);
    assert.equal(at(hunks, 0).preview, "x");
  });

  test("addedSpans 只圈新增的行（上下文不涂），相邻多行合成一段", () => {
    const hunks = diffHunks(BEFORE, AFTER);
    assert.deepEqual(at(hunks, 0).addedSpans, [{ line: 1, count: 1 }]);
    assert.deepEqual(at(hunks, 1).addedSpans, [{ line: 3, count: 1 }]);
    const merged = diffHunks("a\nb", "a\nx\ny\nb");
    assert.deepEqual(at(merged, 0).addedSpans, [{ line: 1, count: 2 }]);
  });
});

/** 撤销参考实现：用 after 块定位，换成 before 块（与编辑器里的 dispatch 同一算法） */
function undo(docText: string, hunk: EditorHunk): string | null {
  const lines = docText.split("\n");
  const range = locateBlock(lines, hunk.after, hunk.anchorLine);
  if (range === null) return null;
  return [...lines.slice(0, range.start), ...hunk.before, ...lines.slice(range.end)].join("\n");
}

describe("locateBlock / 撤销", () => {
  test("撤掉一块之后另一块仍然可撤（行号平移不影响）", () => {
    const hunks = diffHunks(BEFORE, AFTER);
    const afterFirst = undo(AFTER, at(hunks, 0));
    assert.notEqual(afterFirst, null);
    // 第一块撤回后，第二块在新文档里仍能找到并撤回 → 回到原文
    const restored = undo(afterFirst as string, at(hunks, 1));
    assert.equal(restored, BEFORE);
  });

  test("用户手改过的块不可撤（找不到就是找不到，不猜）", () => {
    const hunks = diffHunks(BEFORE, AFTER);
    const edited = AFTER.replace("new line", "my own line");
    assert.equal(undo(edited, at(hunks, 1)), null);
  });

  test("别处插行不影响定位（上下文行跟着走）", () => {
    const hunks = diffHunks(BEFORE, AFTER);
    const edited = AFTER.replace("Hello", "Hello\nUser added");
    const range = locateBlock(edited.split("\n"), at(hunks, 1).after, at(hunks, 1).anchorLine);
    assert.deepEqual(range, { start: 7, end: 12 });
  });

  test("多处命中取离锚最近的；一样近就返回 null（宁可不撤也不撤错）", () => {
    const block = ["ctx", "new"];
    const lines = ["ctx", "new", "a", "ctx", "new"];
    // 锚是 1 起的行号：5 → 目标行 4，两处里第 4 行更近
    assert.deepEqual(locateBlock(lines, block, 5), { start: 3, end: 5 });
    // 目标行 1（第 2 行）：第一处更近
    assert.deepEqual(locateBlock(lines, block, 2), { start: 0, end: 2 });
    const same = ["ctx", "new", "ctx", "new"];
    // 目标行 1（第 2 行）到两处一样近 → 分不清，不撤
    assert.equal(locateBlock(same, block, 2), null);
  });

  test("空块不定位（否则会撤到文件开头）", () => {
    assert.equal(locateBlock(["a", "b"], []), null);
  });
});

describe("clampCursorLine", () => {
  test("原来那一行保住；越过末尾贴到末行", () => {
    assert.equal(clampCursorLine(5, 10), 5);
    assert.equal(clampCursorLine(99, 10), 10);
    assert.equal(clampCursorLine(0, 10), 1);
    assert.equal(clampCursorLine(Number.NaN, 10), 1);
  });
});

describe("syncDecision —— 回合落定怎么处理盘上的新内容", () => {
  const decide = (over: Partial<Parameters<typeof syncDecision>[0]>) =>
    syncDecision({ diskChanged: false, conflicted: false, dirty: false, editedThisTurn: false, agentTouched: false, ...over });

  test("盘上没变、也没有 agent 写过：什么都不做", () => {
    assert.equal(decide({ conflicted: true, dirty: true, editedThisTurn: true }), "nothing");
    assert.equal(decide({ dirty: true }), "nothing");
  });

  test("冲突未裁决：等用户（不覆盖他眼前的状态）", () => {
    assert.equal(decide({ diskChanged: true, conflicted: true }), "wait");
    assert.equal(decide({ diskChanged: true, conflicted: true, dirty: true, editedThisTurn: true, agentTouched: true }), "wait");
  });

  test("有未保存改动：只挂冲突条，绝不重载", () => {
    assert.equal(decide({ diskChanged: true, dirty: true, editedThisTurn: true, agentTouched: true }), "keep");
    // 用户改完又改回去（文档与基线一致），本轮仍然动过 → 也不能静默重载
    assert.equal(decide({ diskChanged: true, editedThisTurn: true }), "keep");
  });

  test("干净且本轮没动过：静默重载", () => {
    assert.equal(decide({ diskChanged: true }), "reload");
  });

  test("agent 本轮写过、盘上却没变（写回的就是基线）：用户手里有字也要问", () => {
    // 父会话复现的那个交错：agent read → 用户打字（只在内存）→ agent 原样 write 回去。
    // 盘上 sha 全程没变，所以它不是「磁盘冲突」，而是「agent 的写被你的版本取代」——
    // 必须给冲突条让用户选，不许自动补存。
    assert.equal(decide({ dirty: true, editedThisTurn: true, agentTouched: true }), "keep");
    assert.equal(decide({ editedThisTurn: true, agentTouched: true }), "keep");
    // 用户没动过（干净）→ 没什么可问的，静默走完
    assert.equal(decide({ agentTouched: true }), "nothing");
    // agent 没碰过这个文件 → 用户自己的未保存内容照常自动保存
    assert.equal(decide({ dirty: true, editedThisTurn: true }), "nothing");
  });
});

describe("isPossibleWriteTool —— 只读不止 write/edit", () => {
  test("shell / 终端执行 / 任一 MCP 工具都算", () => {
    assert.equal(isPossibleWriteTool("bash"), true);
    assert.equal(isPossibleWriteTool("powershell"), true);
    assert.equal(isPossibleWriteTool("terminal_execute"), true);
    assert.equal(isPossibleWriteTool("mcp__fs__write_file"), true);
  });

  test("读工具与只开终端的工具不算", () => {
    assert.equal(isPossibleWriteTool("read"), false);
    assert.equal(isPossibleWriteTool("grep"), false);
    assert.equal(isPossibleWriteTool("terminal_open"), false);
    assert.equal(isPossibleWriteTool("terminal_read"), false);
    assert.equal(isPossibleWriteTool("compile_latex"), false);
  });
});

describe("agentWritesInTurn —— 回合起点", () => {
  test("按开轮时记下的起点扫：上一轮的写不算这一轮（P2 误只读）", () => {
    const transcript: TranscriptItem[] = [
      userItem("u1"),
      assistantItem("a1", [writeCall("c1", "main.tex")]),
      toolItem("c1"),
      // 开轮那一刻只有这些；新的 user item 晚到
    ];
    // 起点 = 3（开轮时的长度），还没有任何工具调用 → 空
    assert.deepEqual(agentWritesInTurn(transcript, "/w", 3), []);
    // 新 user item 与真实的本轮调用到齐之后
    const later: TranscriptItem[] = [...transcript, userItem("u2"), assistantItem("a2", [writeCall("c2", "other.tex")])];
    assert.deepEqual(agentWritesInTurn(later, "/w", 3), [{ path: "/w/other.tex", phase: "writing" }]);
    // 不带起点（面板中途挂上）退回「最后一条 user 消息」的老口径
    assert.deepEqual(agentWritesInTurn(later, "/w"), [{ path: "/w/other.tex", phase: "writing" }]);
  });
});

describe("nonOverlappingChanges —— 整轮撤销的间隔守卫", () => {
  test("重叠的后一块被丢掉，其余保留（CodeMirror 不接重叠）", () => {
    const { keep, dropped } = nonOverlappingChanges([
      { id: "a", from: 10, to: 20 },
      { id: "b", from: 15, to: 25 },
      { id: "c", from: 20, to: 30 },
    ]);
    assert.deepEqual(keep.map((item) => item.id), ["a", "c"]);
    assert.deepEqual(dropped.map((item) => item.id), ["b"]);
  });

  test("首尾相接（from === lastTo）不算重叠；乱序输入会先排序", () => {
    const { keep, dropped } = nonOverlappingChanges([
      { id: "b", from: 5, to: 8 },
      { id: "a", from: 0, to: 5 },
    ]);
    assert.deepEqual(keep.map((item) => item.id), ["a", "b"]);
    assert.equal(dropped.length, 0);
  });
});

describe("pruneStaleIds —— 撤掉别的块之后不可撤的块仍在", () => {
  test("还在清单里的 stale 保留，消失的去掉", () => {
    const next = pruneStaleIds(new Set(["a", "b"]), [{ id: "a" }, { id: "c" }]);
    assert.deepEqual([...next], ["a"]);
  });

  test("没有 stale 时返回同一个对象（不触发重渲染）", () => {
    const stale = new Set<string>();
    assert.equal(pruneStaleIds(stale, [{ id: "a" }]), stale);
  });
});
