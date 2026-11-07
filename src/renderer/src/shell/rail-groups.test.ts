/**
 * 右栏入口分组（2026-11-06 起只有一种布局）：排布纯函数 + 几处结构守卫。
 *
 * 守卫的是用户的原话：
 * 「类和类之间有一个小横线做分隔」「它们全部都在右上，右下就简单一点」（2026-10-31）；
 * 「这条任务、审查改动、文件、子会话、终端、内置浏览器、插件、自动化、看板、设置，这些不能被折叠」（2026-11-06）。
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

const item = (id: string, group: RailGroupId, inMore?: boolean): Item => (inMore === true ? { id, group, inMore } : { id, group });

interface Switches {
  subsessions: boolean;
  plugins: boolean;
  intent: boolean;
  automation: boolean;
}

/** 与 RightRail 里实际登记的入口同序同组（守卫文本见下面的源码断言） */
function entries(on: Switches): Item[] {
  return [
    item("context", "session"),
    item("review", "session"),
    item("files", "session"),
    ...(on.subsessions ? [item("subsessions", "session")] : []),
    item("terminal", "agent"),
    item("browser", "agent"),
    ...(on.plugins ? [item("plugins", "agent")] : []),
    ...(on.intent ? [item("intent", "agent")] : []),
    ...(on.automation ? [item("automation", "agent")] : []),
    item("carryovers", "shelf", true),
    item("archived", "shelf", true),
    item("bell", "shelf", true),
    ...(on.plugins ? [item("board", "app")] : []),
    item("settings", "app"),
  ];
}

const ids = (list: readonly { id: string }[]): string[] => list.map((each) => each.id);
const shape = (parts: readonly { group: string; items: readonly { id: string }[] }[]): [string, string[]][] =>
  parts.map((part) => [part.group, ids(part.items)]);

describe("layoutRail", () => {
  it("全开：条上是会话组 + 智能体组，更多里只有以后再做 / 归档 / 通知，右下是看板与设置", () => {
    const layout = layoutRail(entries({ subsessions: true, plugins: true, intent: true, automation: true }));
    assert.deepEqual(shape(layout.stack), [
      ["session", ["context", "review", "files", "subsessions"]],
      ["agent", ["terminal", "browser", "plugins", "intent", "automation"]],
    ]);
    assert.deepEqual(shape(layout.more), [["shelf", ["carryovers", "archived", "bell"]]]);
    assert.deepEqual(ids(layout.dock), ["board", "settings"]);
  });

  it("无子会话：子会话入口不出现，其余不变", () => {
    const layout = layoutRail(entries({ subsessions: false, plugins: true, intent: true, automation: true }));
    assert.deepEqual(ids(layout.stack[0]?.items ?? []), ["context", "review", "files"]);
    assert.deepEqual(ids(layout.stack[1]?.items ?? []), ["terminal", "browser", "plugins", "intent", "automation"]);
  });

  it("plugins 关：没有插件入口（技能与 MCP 的面板已并入插件页，不再单列），看板不出现，右下只剩设置", () => {
    const layout = layoutRail(entries({ subsessions: false, plugins: false, intent: false, automation: false }));
    assert.deepEqual(ids(layout.stack[1]?.items ?? []), ["terminal", "browser"]);
    assert.deepEqual(ids(layout.dock), ["settings"]);
  });

  it("意图开 / 关、automation 开 / 关：各自只在开着时出现在条上，从不进「更多」", () => {
    for (const intent of [false, true]) {
      for (const automation of [false, true]) {
        const layout = layoutRail(entries({ subsessions: false, plugins: true, intent, automation }));
        const agent = ids(layout.stack[1]?.items ?? []);
        assert.equal(agent.includes("intent"), intent);
        assert.equal(agent.includes("automation"), automation);
        assert.deepEqual(ids(layout.more.flatMap((part) => part.items)), ["carryovers", "archived", "bell"]);
      }
    }
  });

  it("用户点名不能折叠的入口永远在条上 / 右下，不进「更多」", () => {
    const layout = layoutRail(entries({ subsessions: true, plugins: true, intent: true, automation: true }));
    const moreIds = ids(layout.more.flatMap((part) => part.items));
    for (const id of ["context", "review", "files", "subsessions", "terminal", "browser", "plugins", "automation", "board", "settings"]) {
      assert.ok(!moreIds.includes(id), `${id} 不该在更多里`);
    }
  });

  it("每个入口恰好出现一次；上段不含应用组，应用组只在 dock", () => {
    const all = entries({ subsessions: true, plugins: true, intent: true, automation: true });
    const layout = layoutRail(all);
    const shown = [...layout.stack.flatMap((part) => part.items), ...layout.dock, ...layout.more.flatMap((part) => part.items)];
    assert.equal(new Set(ids(shown)).size, all.length);
    assert.ok(layout.stack.every((part) => part.group !== "app"));
    assert.ok(layout.dock.every((each) => each.group === "app"));
  });

  it("空组不出现：没有 shelf 入口时「更多」为空", () => {
    const layout = layoutRail(entries({ subsessions: false, plugins: false, intent: false, automation: false }).filter((each) => each.inMore !== true));
    assert.deepEqual(layout.more, []);
  });
});

describe("withGroupRules", () => {
  it("组与组之间插一条分隔，首尾不插；单组与空清单没有分隔", () => {
    const groups = [
      { group: "session" as const, items: ["a", "b"] },
      { group: "shelf" as const, items: ["c"] },
    ];
    assert.deepEqual(withGroupRules(groups, (before) => `rule:${before}`), ["a", "b", "rule:shelf", "c"]);
    assert.deepEqual(withGroupRules(groups.slice(0, 1), () => "rule"), ["a", "b"]);
    assert.deepEqual(withGroupRules([], () => "rule"), []);
  });
});

describe("结构守卫", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (path: string): string => readFileSync(join(here, path), "utf8");
  const rail = read("RightRail.tsx");
  const css = read("../styles.css");
  const menu = read("Menu.tsx");

  it("右栏没有精简态：没有 lean 属性、没有 pinned、没有上下文直达项", () => {
    assert.doesNotMatch(rail, /\blean\b|pinned|context-tab|onOpenContext/);
    assert.doesNotMatch(read("../experimental-features.ts"), /lean-rail/);
  });

  it("「更多」里只有以后再做 / 归档 / 通知（记忆库已挪进设置的页签，不在右栏）", () => {
    const inMore = [...rail.matchAll(/id: "(\w+)", group: "shelf", inMore: true|fromApp\("(\w+)", \{ group: "shelf", inMore: true \}\)/g)].map((m) => m[1] ?? m[2]);
    assert.deepEqual(inMore, ["carryovers", "archived", "bell"]);
  });

  it("插件转正后条上没有「技能与 MCP」入口，插件与自动化常驻", () => {
    assert.doesNotMatch(rail, /id: "abilities"/);
    assert.match(rail, /\{ id: "plugins", group: "agent"/);
    assert.match(rail, /id: "automation",\s*group: "agent"/);
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
    assert.match(rail, /index > 0 && <span className="rail-sep"/);
  });

  it("Menu 的分隔项不进键盘光标、搜索时被丢弃", () => {
    assert.match(menu, /item\.header !== true && item\.rule !== true/);
    assert.match(menu, /if \(item\.rule === true\) continue;/);
  });
});
