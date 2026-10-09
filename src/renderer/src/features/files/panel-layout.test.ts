import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  closeTab,
  crumbSegments,
  fileTabName,
  openTab,
  panelLayoutAttrs,
  shouldCollapseOnNarrow,
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

describe("toggleGroupCollapsed", () => {
  it("折起再展开回到原样，不改传入 Set", () => {
    const collapsed = new Set<string>();
    const folded = toggleGroupCollapsed(collapsed, "/ws");
    deepStrictEqual([...folded], ["/ws"]);
    deepStrictEqual([...toggleGroupCollapsed(folded, "/ws")], []);
    deepStrictEqual([...collapsed], []);
  });
});
