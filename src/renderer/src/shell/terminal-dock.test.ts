import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dockResizerBottomOffset,
  moveDockTo,
  recallTerminalOpen,
  rememberTerminalOpen,
  restoreTerminalState,
  TERMINAL_DOCK_RESIZER_SIZE,
  terminalHeaderIsTitlebar,
  type TerminalOpenMemory,
} from "./terminal-dock.ts";
import type { RightPanelKind } from "./RightRail.tsx";
// RightPanelKind 是纯类型：原生剥离把这行删掉，不会加载 RightRail.tsx（JSX）

describe("rememberTerminalOpen / recallTerminalOpen（底部终端的按会话记忆）", () => {
  it("记下与恢复；没记过的会话恢复成关着", () => {
    let memory: TerminalOpenMemory = new Map();
    memory = rememberTerminalOpen(memory, "s1", true);
    deepStrictEqual(recallTerminalOpen(memory, "s1"), true);
    deepStrictEqual(recallTerminalOpen(memory, "s2"), false);
  });

  it("首页（session 为 null）不是会话：不记也不恢复", () => {
    let memory: TerminalOpenMemory = new Map();
    memory = rememberTerminalOpen(memory, null, true);
    deepStrictEqual(memory.size, 0);
    deepStrictEqual(recallTerminalOpen(memory, null), false);
  });

  it("原 Map 不被改写（记忆是不可变的：切走那条的记录留给它自己）", () => {
    const first = rememberTerminalOpen(new Map(), "s1", true);
    const second = rememberTerminalOpen(first, "s2", false);
    deepStrictEqual([...first.entries()], [["s1", true]]);
    deepStrictEqual([...second.entries()].sort(), [
      ["s1", true],
      ["s2", false],
    ]);
  });
});

describe("restoreTerminalState（切会话那一拍按当前停靠位归位）", () => {
  it("停靠在右栏：面板照记忆恢复，底部终端不存在（恒关）", () => {
    deepStrictEqual(restoreTerminalState("terminal" as RightPanelKind, true, "right"), {
      panel: "terminal",
      bottomOpen: false,
    });
    deepStrictEqual(restoreTerminalState("files" as RightPanelKind, true, "right"), {
      panel: "files",
      bottomOpen: false,
    });
    deepStrictEqual(restoreTerminalState(null, true, "right"), { panel: null, bottomOpen: false });
  });

  it("停靠在底部：面板照记忆恢复，底部终端按自己的记忆恢复（可同开）", () => {
    deepStrictEqual(restoreTerminalState("files" as RightPanelKind, true, "bottom"), {
      panel: "files",
      bottomOpen: true,
    });
    deepStrictEqual(restoreTerminalState("files" as RightPanelKind, false, "bottom"), {
      panel: "files",
      bottomOpen: false,
    });
    deepStrictEqual(restoreTerminalState(null, true, "bottom"), { panel: null, bottomOpen: true });
  });

  it("记忆里的 \"terminal\" 是停靠位还在右栏的年代记下的：换到底部后翻译成底部终端开着", () => {
    deepStrictEqual(restoreTerminalState("terminal" as RightPanelKind, false, "bottom"), {
      panel: null,
      bottomOpen: true,
    });
  });
});

describe("moveDockTo（扳动停靠开关：终端跟着搬家）", () => {
  it("搬到底部：终端在底部展开；右栏正显示终端就让位，其它面板不动", () => {
    deepStrictEqual(moveDockTo("bottom", "terminal" as RightPanelKind), {
      panel: null,
      bottomOpen: true,
    });
    deepStrictEqual(moveDockTo("bottom", "files" as RightPanelKind), {
      panel: "files",
      bottomOpen: true,
    });
    deepStrictEqual(moveDockTo("bottom", null), { panel: null, bottomOpen: true });
  });

  it("搬回右栏：面板位换成终端，底部收起", () => {
    deepStrictEqual(moveDockTo("right", "files" as RightPanelKind), {
      panel: "terminal",
      bottomOpen: false,
    });
    deepStrictEqual(moveDockTo("right", null), { panel: "terminal", bottomOpen: false });
  });
});

describe("dockResizerBottomOffset（拖高热区骑在分界线上下各一半）", () => {
  it("热区 12px：底边 = 分界线 + 6，上缘伸进对话区 6px（槽里那半被裁掉，热区挂 pane-col）", () => {
    deepStrictEqual(TERMINAL_DOCK_RESIZER_SIZE, 12);
    deepStrictEqual(dockResizerBottomOffset(260), 254);
    deepStrictEqual(dockResizerBottomOffset(400), 394);
  });
});

describe("terminalHeaderIsTitlebar（底部终端的头部不是窗口拖拽区）", () => {
  it("右栏 = 窗口顶行，挂 titlebar；底部 = 窗口中间，不拖窗口也不双击最大化", () => {
    deepStrictEqual(terminalHeaderIsTitlebar("right"), true);
    deepStrictEqual(terminalHeaderIsTitlebar("bottom"), false);
  });
});
