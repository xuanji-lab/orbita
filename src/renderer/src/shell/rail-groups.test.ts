/**
 * 右栏入口分组（2026-10-31）：排布纯函数 + 几处结构守卫。
 *
 * 守卫的是用户的两条原话（2026-10-31）：
 * 「文件面板不应该被收纳」——精简态文件必须常驻；
 * 「类和类之间有一个小横线做分隔」「它们全部都在右上，右下就简单一点」——组间一条线、右下只剩应用组。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RAIL_GROUP_IDS, layoutRail, withGroupRules, type RailGroupId, type RailPlacement } from "./rail-groups.ts";

interface Item extends RailPlacement {
  id: string;
}

const item = (id: string, group: RailGroupId, pinned: boolean, moreOnly?: boolean): Item =>
  moreOnly === undefined ? { id, group, pinned } : { id, group, pinned, moreOnly };

/** 与 RightRail 里实际登记的入口同序同组（守卫文本见下面的源码断言） */
const FULL: Item[] = [
  item("context", "session", true),
  item("review", "session", false),
  item("context-tab", "session", false, true),
  item("subsessions", "session", true),
  item("files", "session", true),
  item("terminal", "agent", true),
  item("browser", "agent", true),
  item("abilities", "agent", false),
  item("memory", "agent", false),
  item("intent", "agent", false),
  item("carryovers", "shelf", false),
  item("archived", "shelf", false),
  item("settings", "app", true),
  item("bell", "app", false),
];

const ids = (list: readonly { id: string }[]): string[] => list.map((each) => each.id);

describe("layoutRail", () => {
  it("常规态：右上四组按组序、组内按数组序，右下只有应用组；moreOnly 不上条；「更多」为空", () => {
    const layout = layoutRail(FULL, false);
    assert.deepEqual(
      layout.stack.map((part) => [part.group, ids(part.items)]),
      [
        ["session", ["context", "review", "subsessions", "files"]],
        ["agent", ["terminal", "browser", "abilities", "memory", "intent"]],
        ["shelf", ["carryovers", "archived"]],
      ],
    );
    assert.deepEqual(ids(layout.dock), ["settings", "bell"]);
    assert.deepEqual(layout.more, []);
  });

  it("精简态：条上只留 pinned（文件常驻），其余按同一套组序进「更多」，moreOnly 也在里面", () => {
    const layout = layoutRail(FULL, true);
    assert.deepEqual(
      layout.stack.map((part) => [part.group, ids(part.items)]),
      [
        ["session", ["context", "subsessions", "files"]],
        ["agent", ["terminal", "browser"]],
      ],
    );
    assert.deepEqual(ids(layout.dock), ["settings"]);
    assert.deepEqual(
      layout.more.map((part) => [part.group, ids(part.items)]),
      [
        ["session", ["review", "context-tab"]],
        ["agent", ["abilities", "memory", "intent"]],
        ["shelf", ["carryovers", "archived"]],
        ["app", ["bell"]],
      ],
    );
  });

  it("空组不出现：没有子会话 / 记忆 / 意图时，对应的入口与线都不画", () => {
    const sparse = FULL.filter((each) => !["subsessions", "memory", "intent", "carryovers", "archived"].includes(each.id));
    const regular = layoutRail(sparse, false);
    assert.deepEqual(regular.stack.map((part) => part.group), ["session", "agent"]);
    assert.deepEqual(ids(regular.stack[1]?.items ?? []), ["terminal", "browser", "abilities"]);
    const lean = layoutRail(sparse, true);
    assert.deepEqual(lean.more.map((part) => part.group), ["session", "agent", "app"]);
  });

  it("上段永远不含应用组，应用组永远在 dock（右下只剩它）", () => {
    for (const lean of [false, true]) {
      const layout = layoutRail(FULL, lean);
      assert.ok(layout.stack.every((part) => part.group !== "app"));
      assert.ok(layout.dock.every((each) => each.group === "app"));
    }
  });

  it("每个入口在两种态下恰好出现一次（条上 / 菜单里二选一，常规态的 moreOnly 例外地不出现）", () => {
    for (const lean of [false, true]) {
      const layout = layoutRail(FULL, lean);
      const shown = [...layout.stack.flatMap((part) => part.items), ...layout.dock, ...layout.more.flatMap((part) => part.items)];
      assert.equal(new Set(ids(shown)).size, shown.length, `lean=${lean} 有入口重复出现`);
      const expected = FULL.filter((each) => lean || each.moreOnly !== true).length;
      assert.equal(shown.length, expected, `lean=${lean} 有入口丢了`);
    }
  });
});

describe("withGroupRules", () => {
  it("组与组之间插一条分隔，首尾不插；单组与空清单没有分隔", () => {
    const groups = layoutRail(FULL, true).more;
    const flat = withGroupRules<Item | string, string>(groups, (before) => `rule:${before}`);
    assert.deepEqual(
      flat.map((each) => (typeof each === "string" ? each : each.id)),
      ["review", "context-tab", "rule:agent", "abilities", "memory", "intent", "rule:shelf", "carryovers", "archived", "rule:app", "bell"],
    );
    assert.deepEqual(withGroupRules(groups.slice(0, 1), () => "rule"), groups[0]?.items);
    assert.deepEqual(withGroupRules([], () => "rule"), []);
  });
});

describe("结构守卫", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (path: string): string => readFileSync(join(here, path), "utf8");
  const rail = read("RightRail.tsx");
  const css = read("../styles.css");
  const menu = read("Menu.tsx");

  it("文件入口在精简态常驻（用户：文件面板不应该被收纳）", () => {
    assert.match(rail, /id: "files", group: "session", pinned: true/);
  });

  it("plugins 开着时没有「技能与 MCP」入口，关着时保留", () => {
    assert.match(rail, /props\.pluginsAvailable\s*\?\s*\[\]\s*:\s*\[\{ id: "abilities"/);
  });

  it("组名登记齐：RAIL_GROUP_IDS 每一组在中英文案里都有名字（读屏的 group 标签）", () => {
    const zh = read("../messages-zh.ts");
    const en = read("../messages-en.ts");
    for (const group of RAIL_GROUP_IDS) {
      assert.match(zh, new RegExp(`groups: \\{[^}]*\\b${group}: "`), `中文缺 ${group}`);
      assert.match(en, new RegExp(`groups: \\{[^}]*\\b${group}: "`), `英文缺 ${group}`);
    }
  });

  it("组间一条线：1px、比按钮窄、走分隔线 token 与 --space-*；组内没有分隔", () => {
    assert.match(css, /\.rail-sep\s*\{[^}]*width:\s*var\(--space-4\)[^}]*height:\s*1px[^}]*margin:\s*var\(--space-2\) 0[^}]*background:\s*var\(--color-border-default\)/s);
    assert.match(css, /\.rail-group\s*\{[^}]*gap:\s*var\(--space-1\)/s);
    // 分隔线只在组与组之间：JSX 里 index > 0 才画
    assert.match(rail, /index > 0 && <span className="rail-sep"/);
  });

  it("Menu 的分隔项不进键盘光标、搜索时被丢弃", () => {
    assert.match(menu, /item\.header !== true && item\.rule !== true/);
    assert.match(menu, /if \(item\.rule === true\) continue;/);
  });
});
