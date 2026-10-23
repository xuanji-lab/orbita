import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  closeTab,
  crumbSegments,
  crumbSegmentsFromRoot,
  dropTabsAtRoot,
  fileTabName,
  focusRootToDrop,
  openTab,
  panelLayoutAttrs,
  shouldCollapseOnNarrow,
  tabScrollTarget,
  toggleGroupCollapsed,
  TREE_BREAKPOINT,
  type FileTab,
} from "./panel-layout.ts";

const tab = (path: string, root = "/ws"): FileTab => ({ root, path });

describe("openTab", () => {
  it("新文件排到队尾", () => {
    deepStrictEqual(openTab([tab("/ws/a.ts")], "/ws", "/ws/b.ts"), [
      tab("/ws/a.ts"),
      tab("/ws/b.ts"),
    ]);
  });

  it("同一文件复用标签：不重复、不换位（root 只随首次记录）", () => {
    const tabs = [tab("/ws/a.ts"), tab("/ws/b.ts")];
    deepStrictEqual(openTab(tabs, "/ws", "/ws/a.ts"), tabs);
    strictEqual(openTab(tabs, "/ws", "/ws/a.ts").length, 2);
  });

  it("不改传入数组（React state 纪律）", () => {
    const tabs = [tab("/ws/a.ts")];
    openTab(tabs, "/ws", "/ws/b.ts");
    deepStrictEqual(tabs, [tab("/ws/a.ts")]);
  });
});

describe("closeTab", () => {
  const tabs = [tab("/ws/a.ts"), tab("/ws/b.ts"), tab("/ws/c.ts")];

  it("关的是激活标签：激活右邻", () => {
    deepStrictEqual(closeTab(tabs, "/ws/b.ts", "/ws/b.ts"), {
      tabs: [tab("/ws/a.ts"), tab("/ws/c.ts")],
      activePath: "/ws/c.ts",
    });
  });

  it("关的是队尾激活标签：退给左邻", () => {
    deepStrictEqual(closeTab(tabs, "/ws/c.ts", "/ws/c.ts"), {
      tabs: [tab("/ws/a.ts"), tab("/ws/b.ts")],
      activePath: "/ws/b.ts",
    });
  });

  it("关的不是激活标签：激活不动", () => {
    deepStrictEqual(closeTab(tabs, "/ws/a.ts", "/ws/c.ts"), {
      tabs: [tab("/ws/a.ts"), tab("/ws/b.ts")],
      activePath: "/ws/a.ts",
    });
  });

  it("关最后一个标签：回纯树（activePath null）", () => {
    deepStrictEqual(closeTab([tab("/ws/a.ts")], "/ws/a.ts", "/ws/a.ts"), {
      tabs: [],
      activePath: null,
    });
  });

  it("activePath 为 null 时关一个残留标签：不凭空激活", () => {
    deepStrictEqual(closeTab([tab("/ws/a.ts")], null, "/ws/a.ts"), { tabs: [], activePath: null });
  });

  it("关不存在的标签：无事发生", () => {
    deepStrictEqual(closeTab(tabs, "/ws/a.ts", "/ws/ghost.ts"), { tabs, activePath: "/ws/a.ts" });
  });
});

describe("dropTabsAtRoot", () => {
  const focus = (path: string): FileTab => tab(path, "/focus");

  it("只丢掉那个根的标签，会话根的标签留着", () => {
    const tabs = [tab("/ws/a.ts"), focus("/focus/a.ts"), tab("/ws/b.ts")];
    deepStrictEqual(dropTabsAtRoot(tabs, "/ws/a.ts", "/focus"), {
      tabs: [tab("/ws/a.ts"), tab("/ws/b.ts")],
      activePath: "/ws/a.ts",
    });
  });

  it("丢的是激活标签：激活右邻", () => {
    const tabs = [tab("/ws/a.ts"), focus("/focus/a.ts"), tab("/ws/b.ts")];
    deepStrictEqual(dropTabsAtRoot(tabs, "/focus/a.ts", "/focus"), {
      tabs: [tab("/ws/a.ts"), tab("/ws/b.ts")],
      activePath: "/ws/b.ts",
    });
  });

  it("右边没有幸存者时退左边；全丢完 = 没有激活文件", () => {
    const tabs = [tab("/ws/a.ts"), focus("/focus/a.ts"), focus("/focus/b.ts")];
    deepStrictEqual(dropTabsAtRoot(tabs, "/focus/a.ts", "/focus"), {
      tabs: [tab("/ws/a.ts")],
      activePath: "/ws/a.ts",
    });
    deepStrictEqual(dropTabsAtRoot([focus("/focus/a.ts")], "/focus/a.ts", "/focus"), {
      tabs: [],
      activePath: null,
    });
  });

  it("没有该根的标签：原样返回（不改传入数组）", () => {
    const tabs = [tab("/ws/a.ts")];
    const result = dropTabsAtRoot(tabs, "/ws/a.ts", "/focus");
    deepStrictEqual(result, { tabs, activePath: "/ws/a.ts" });
    deepStrictEqual(tabs, [tab("/ws/a.ts")]);
  });
});

describe("focusRootToDrop", () => {
  it("专注中（run）同一工作区再渲染：不动", () => {
    strictEqual(focusRootToDrop("focus", "focus", false, false), null);
  });

  it("run → done：返回专注工作区（左栏视图还在，但这一轮结束了）", () => {
    strictEqual(focusRootToDrop("focus", "focus", false, true), "focus");
  });

  it("done 之后再渲染 / 再专注一轮：不重复收", () => {
    strictEqual(focusRootToDrop("focus", "focus", true, true), null);
    strictEqual(focusRootToDrop("focus", "focus", true, false), null);
  });

  it("结束专注 / 退回会话列表：丢上一个根", () => {
    strictEqual(focusRootToDrop("focus", null, false, false), "focus");
    strictEqual(focusRootToDrop("focus", null, true, false), "focus");
  });

  it("换到另一个工作区：丢上一个根，不丢新的", () => {
    strictEqual(focusRootToDrop("focus", "other", false, false), "focus");
  });

  it("之前就不在专注 / 浏览态：没有根可丢", () => {
    strictEqual(focusRootToDrop(null, "focus", false, false), null);
    strictEqual(focusRootToDrop(null, null, false, true), null);
  });

  it("run → done 这一拍只收一次：再喂同一个状态，dropTabsAtRoot 不会被再触发", () => {
    const tabs = [tab("/ws/a.ts"), tab("/focus/a.ts", "/focus")];
    const first = focusRootToDrop("focus", "focus", false, true);
    strictEqual(first, "focus");
    deepStrictEqual(dropTabsAtRoot(tabs, "/focus/a.ts", "/focus"), {
      tabs: [tab("/ws/a.ts")],
      activePath: "/ws/a.ts",
    });
    // 下一拍 effect 再跑（tabs 变了也重跑）：没有相位变化 → 不收
    strictEqual(focusRootToDrop("focus", "focus", true, true), null);
  });
});

describe("shouldCollapseOnNarrow", () => {
  it("断点常量与 styles.css 的 @container (min-width: 640px) 成对——改这边必须同步改 CSS", () => {
    strictEqual(TREE_BREAKPOINT, 640);
  });

  it("拉窄（任何幅度）就折叠——不依赖跨断点：面板下界能高于 640，断点无法作为判据", () => {
    strictEqual(shouldCollapseOnNarrow(693, 691), true);   // 两侧都在「宽侧」，只拉窄 2px
    strictEqual(shouldCollapseOnNarrow(700, 690), true);
    strictEqual(shouldCollapseOnNarrow(650, 630), true);   // 跨断点
    strictEqual(shouldCollapseOnNarrow(500, 480), true);   // 两侧都在窄侧
  });

  it("1px 之差当作抖动：不折叠（拖动中的亚像素噪声不该把树折了）", () => {
    strictEqual(shouldCollapseOnNarrow(693, 692), false);
  });

  it("拉宽：不反向自动折叠（树只能由标题开关打开）", () => {
    strictEqual(shouldCollapseOnNarrow(690, 700), false);
    strictEqual(shouldCollapseOnNarrow(630, 650), false);
  });

  it("等宽 / 亚像素抖动：不折叠", () => {
    strictEqual(shouldCollapseOnNarrow(693, 693), false);
    strictEqual(shouldCollapseOnNarrow(693, 692.4), false);
  });

  it("首帧（还没量过宽）：不动作", () => {
    strictEqual(shouldCollapseOnNarrow(null, 693), false);
    strictEqual(shouldCollapseOnNarrow(null, 300), false);
  });
});

describe("panelLayoutAttrs", () => {
  it("有文件 + 树开：并排 / 浮层形态由 CSS 按 640px 裁决，这里只报 on", () => {
    deepStrictEqual(panelLayoutAttrs(true, true), { "data-file": "open", "data-tree": "on" });
  });

  it("有文件 + 树关：只显示文件", () => {
    deepStrictEqual(panelLayoutAttrs(true, false), { "data-file": "open", "data-tree": "off" });
  });

  it("没文件：树就是整个面板——treeOn 残留 true 也不许点亮（无文件时开关禁用的不变式）", () => {
    deepStrictEqual(panelLayoutAttrs(false, true), { "data-file": "none", "data-tree": "off" });
    deepStrictEqual(panelLayoutAttrs(false, false), { "data-file": "none", "data-tree": "off" });
  });
});

describe("fileTabName", () => {
  it("取路径末段", () => {
    strictEqual(fileTabName("/ws/src/FilesPanel.tsx"), "FilesPanel.tsx");
    strictEqual(fileTabName("C:\\ws\\a b\\x.ts"), "x.ts");
  });

  it("整条都是分隔符：回退还整条，不出空标签", () => {
    strictEqual(fileTabName("/"), "/");
  });
});

describe("crumbSegments", () => {
  it("Windows 原生反斜杠与渲染端拼的正斜杠混着来都能切", () => {
    deepStrictEqual(crumbSegments("C:\\ws\\src\\a.ts"), ["C:", "ws", "src", "a.ts"]);
    deepStrictEqual(crumbSegments("C:/ws/src/a.ts"), ["C:", "ws", "src", "a.ts"]);
  });

  it("POSIX 路径按 / 切（名字里的 \\ 是合法字符，不切错）", () => {
    deepStrictEqual(crumbSegments("/home/u/my\\folder/x.ts"), ["home", "u", "my\\folder", "x.ts"]);
  });

  it("滤掉空段（双分隔符 / 尾分隔符）", () => {
    deepStrictEqual(crumbSegments("/ws//a.ts/"), ["ws", "a.ts"]);
  });
});

describe("crumbSegmentsFromRoot", () => {
  it("从根的显示名起头，其后是根之内的相对段", () => {
    deepStrictEqual(crumbSegmentsFromRoot("/Users/guanhongli/demo", "demo", "/Users/guanhongli/demo/docs/index.html"), [
      "demo",
      "docs",
      "index.html",
    ]);
  });

  it("根下一层的文件：根名 + 文件名两段", () => {
    deepStrictEqual(crumbSegmentsFromRoot("/Users/x/ws", "orbita", "/Users/x/ws/AGENTS.md"), [
      "orbita",
      "AGENTS.md",
    ]);
  });

  it("Windows 反斜杠根与渲染端拼的正斜杠子路径都接得住（分隔前缀两种都试）", () => {
    deepStrictEqual(crumbSegmentsFromRoot("C:\\work\\demo", "demo", "C:\\work\\demo\\src\\main.ts"), [
      "demo",
      "src",
      "main.ts",
    ]);
    deepStrictEqual(crumbSegmentsFromRoot("C:\\work\\demo", "demo", "C:\\work\\demo/src/a.ts"), [
      "demo",
      "src",
      "a.ts",
    ]);
  });

  it("路径不在根之内（不该发生）：退全路径分段，不拼假段", () => {
    deepStrictEqual(crumbSegmentsFromRoot("/ws", "ws", "/other/a.ts"), ["other", "a.ts"]);
  });

  it("路径就是根本身：退全路径分段", () => {
    deepStrictEqual(crumbSegmentsFromRoot("/ws", "ws", "/ws"), ["ws"]);
  });
});

describe("toggleGroupCollapsed", () => {
  it("折起再展开回到原样，不改传入 Set", () => {
    const collapsed = new Set<string>();
    const folded = toggleGroupCollapsed(collapsed, "/ws");
    deepStrictEqual([...folded], ["/ws"]);
    deepStrictEqual([...toggleGroupCollapsed(folded, "/ws")], []);
    deepStrictEqual([...collapsed], []);
  });
});

describe("tabScrollTarget", () => {
  it("已完整可见：不动", () => {
    strictEqual(tabScrollTarget({ scrollLeft: 0, clientWidth: 300 }, { offsetLeft: 10, offsetWidth: 100 }), null);
    strictEqual(tabScrollTarget({ scrollLeft: 50, clientWidth: 300 }, { offsetLeft: 60, offsetWidth: 100 }), null);
  });

  it("右出界：贴右（末段与 ✕ 完整落进可视区）", () => {
    // 栏 [0,300)，标签 [280,420)：目标让右缘 420 落在 300 → scrollLeft=120
    strictEqual(tabScrollTarget({ scrollLeft: 0, clientWidth: 300 }, { offsetLeft: 280, offsetWidth: 140 }), 120);
  });

  it("左出界：贴左", () => {
    // 栏滚到 [100,400)，标签 [20,120)：目标回到 20
    strictEqual(tabScrollTarget({ scrollLeft: 100, clientWidth: 300 }, { offsetLeft: 20, offsetWidth: 100 }), 20);
  });

  it("标签比栏还宽：贴右（保 ✕ 可见，名字有省略号兑底）", () => {
    strictEqual(tabScrollTarget({ scrollLeft: 0, clientWidth: 200 }, { offsetLeft: 50, offsetWidth: 300 }), 150);
  });
});
