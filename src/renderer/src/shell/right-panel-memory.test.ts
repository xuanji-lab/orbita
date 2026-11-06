import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { RIGHT_PANEL_MEMORY_MAX_ENTRIES } from "../../../shared/right-panel-memory.ts";
import {
  automationSubOf,
  composeEntry,
  contextSubOf,
  forgetMissing,
  hasEntry,
  hasSubLayer,
  intentSubOf,
  mergeLoaded,
  parseAutomationSub,
  parseContextSub,
  parseEntry,
  parseIntentSub,
  parseMemoryFile,
  parsePluginsSub,
  parseReviewSub,
  parseSubSessionsSub,
  recallEntry,
  rememberEntry,
  resolveAutomationSub,
  resolvePluginsSub,
  resolveSubSessionsSub,
  reviewSubOf,
  taskTabOf,
  toMemoryFile,
  type PanelEntry,
  type PanelMemory,
} from "./right-panel-memory.ts";

/**
 * 右栏按会话记忆（right-panel-memory.ts）。覆盖：记 / 取、各面板第二层的解析与坏数据回退、
 * 上限淘汰、会话删除清理、落盘往返、旧格式（只有面板种类）兼容、拿活数据再核一次。
 */

const files: PanelEntry = { panel: "files" };
const pluginDetail: PanelEntry = { panel: "plugins", sub: { selected: "plugin:demo@ws1" } };

describe("rememberEntry / recallEntry：记、取、互不串", () => {
  it("A 的路径记下，回到 A 原样取回（含第二层）", () => {
    const memory = rememberEntry(new Map(), "a", pluginDetail);
    deepStrictEqual(recallEntry(memory, "a"), pluginDetail);
  });

  it("A、B 各记各的：B 停在列表，不拿 A 的详情", () => {
    let memory: PanelMemory = rememberEntry(new Map(), "a", pluginDetail);
    memory = rememberEntry(memory, "b", { panel: "plugins" });
    deepStrictEqual(recallEntry(memory, "a"), pluginDetail);
    deepStrictEqual(recallEntry(memory, "b"), { panel: "plugins" });
  });

  it("同一条会话再次记：覆盖；关着也记（不回退到更早的）", () => {
    let memory: PanelMemory = rememberEntry(new Map(), "a", pluginDetail);
    memory = rememberEntry(memory, "a", { panel: null });
    deepStrictEqual(recallEntry(memory, "a"), { panel: null });
  });

  it("没记过的会话 / 首页（null）：恢复成关着，且 hasEntry 为假", () => {
    deepStrictEqual(recallEntry(new Map(), "fresh"), { panel: null });
    deepStrictEqual(recallEntry(rememberEntry(new Map(), "a", files), null), { panel: null });
    strictEqual(hasEntry(new Map(), "fresh"), false);
    strictEqual(hasEntry(new Map(), null), false);
  });

  it("首页不记：原 Map 原样返回", () => {
    const memory = rememberEntry(new Map(), "a", files);
    strictEqual(rememberEntry(memory, null, files), memory);
  });

  it("内容没变且已是最近的一条：原样返回（引用不变，调用方据此不重复落盘）", () => {
    const memory = rememberEntry(new Map(), "a", pluginDetail);
    strictEqual(rememberEntry(memory, "a", { panel: "plugins", sub: { selected: "plugin:demo@ws1" } }), memory);
  });

  it("记 / 取之间不改入参 Map", () => {
    const base: PanelMemory = new Map();
    rememberEntry(base, "a", files);
    strictEqual(base.size, 0);
  });
});

describe("上限淘汰与会话删除清理", () => {
  it("超过上限：淘汰最久没用的；再次用到的会话挪到最近", () => {
    let memory: PanelMemory = new Map();
    for (let i = 0; i < RIGHT_PANEL_MEMORY_MAX_ENTRIES; i += 1) memory = rememberEntry(memory, `s${i}`, files);
    memory = rememberEntry(memory, "s0", { panel: "terminal" }); // s0 挪到最近
    memory = rememberEntry(memory, "new", files);
    strictEqual(memory.size, RIGHT_PANEL_MEMORY_MAX_ENTRIES);
    strictEqual(memory.has("s0"), true);
    strictEqual(memory.has("s1"), false);
    strictEqual(memory.has("new"), true);
  });

  it("forgetMissing：删掉不在 alive 里的；全在则原样返回", () => {
    let memory: PanelMemory = rememberEntry(new Map(), "a", files);
    memory = rememberEntry(memory, "b", files);
    strictEqual(forgetMissing(memory, new Set(["a", "b", "c"])), memory);
    const pruned = forgetMissing(memory, new Set(["a"]));
    deepStrictEqual([...pruned.keys()], ["a"]);
  });
});

describe("各面板第二层的解析：坏数据丢字段、默认值不落盘", () => {
  it("plugins：保留 selected / board / ws / draft；board 没有 selected 时无意义；坏字段丢", () => {
    deepStrictEqual(parsePluginsSub({ selected: "p", board: true, ws: { kind: "workspace", id: "w" } }), {
      selected: "p",
      board: true,
      ws: { kind: "workspace", id: "w" },
    });
    deepStrictEqual(parsePluginsSub({ board: true }), undefined);
    deepStrictEqual(parsePluginsSub({ selected: 3, ws: { kind: "nope" }, draft: { path: "" } }), undefined);
    deepStrictEqual(parsePluginsSub({ draft: { path: "/x/y", workspaceId: null } }), { draft: { path: "/x/y", workspaceId: null } });
    deepStrictEqual(parsePluginsSub({ selected: "x".repeat(601) }), undefined);
    strictEqual(parsePluginsSub("junk"), undefined);
  });

  it("automation：detail + 范围 all；默认范围不记", () => {
    deepStrictEqual(parseAutomationSub({ detail: "a1", scope: "all" }), { detail: "a1", scope: "all" });
    deepStrictEqual(parseAutomationSub({ scope: "workspace" }), undefined);
    deepStrictEqual(automationSubOf(null, "workspace"), undefined);
    deepStrictEqual(automationSubOf("a1", "all"), { detail: "a1", scope: "all" });
  });

  it("review：页签与来源，默认值（改动 / 任务）不记，非法来源丢", () => {
    deepStrictEqual(parseReviewSub({ tab: "excerpts", source: "staged" }), { tab: "excerpts", source: "staged" });
    deepStrictEqual(parseReviewSub({ tab: "changes", source: "task" }), undefined);
    deepStrictEqual(parseReviewSub({ tab: "x", source: "x" }), undefined);
    deepStrictEqual(reviewSubOf("memory", "task"), { tab: "memory" });
    deepStrictEqual(reviewSubOf("changes", "task"), undefined);
  });

  it("context：视野与折叠组；折叠集等于默认（只 rules）时不记；未知组丢；按显示顺序排", () => {
    deepStrictEqual(parseContextSub({ scope: "task", collapsed: ["web", "bogus", "rules", "web"] }), { scope: "task", collapsed: ["rules", "web"] });
    deepStrictEqual(parseContextSub({ collapsed: ["rules"] }), undefined);
    deepStrictEqual(parseContextSub({ collapsed: [] }), { collapsed: [] });
    deepStrictEqual(contextSubOf("turn", new Set(["rules"])), undefined);
    deepStrictEqual(contextSubOf("task", new Set(["files", "rules"])), { scope: "task", collapsed: ["rules", "files"] });
  });

  it("subsessions：只认非空 sessionId", () => {
    deepStrictEqual(parseSubSessionsSub({ sessionId: "c1" }), { sessionId: "c1" });
    deepStrictEqual(parseSubSessionsSub({ sessionId: "" }), undefined);
    deepStrictEqual(parseSubSessionsSub(null), undefined);
  });

  it("intent：轮次必须是正整数；视图默认 slots 不记", () => {
    deepStrictEqual(parseIntentSub({ round: 3, view: "questions" }), { round: 3, view: "questions" });
    deepStrictEqual(parseIntentSub({ round: 0 }), undefined);
    deepStrictEqual(parseIntentSub({ round: 1.5, view: "slots" }), undefined);
    deepStrictEqual(intentSubOf(null, "slots"), undefined);
    deepStrictEqual(intentSubOf(2, "questions"), { round: 2, view: "questions" });
  });
});

describe("parseEntry：整条校验与旧格式兼容", () => {
  it("认识的面板 + 第二层 + 页签", () => {
    deepStrictEqual(parseEntry({ panel: "context", sub: { scope: "task" }, taskTab: "context" }), {
      panel: "context",
      sub: { scope: "task" },
      taskTab: "context",
    });
    strictEqual(taskTabOf({ panel: null, taskTab: "context" }), "context");
    strictEqual(taskTabOf({ panel: null }), "progress");
  });

  it("旧格式：只有面板种类的字符串 / null 当作没有第二层", () => {
    deepStrictEqual(parseEntry("plugins"), { panel: "plugins" });
    deepStrictEqual(parseEntry(null), { panel: null });
  });

  it("不认识的面板 / 非对象：整条丢；无第二层的面板带了 sub：sub 被丢弃", () => {
    strictEqual(parseEntry({ panel: "bogus" }), null);
    strictEqual(parseEntry(42), null);
    deepStrictEqual(parseEntry({ panel: "files", sub: { x: 1 } }), { panel: "files" });
  });

  it("sub 全是坏字段：退成「面板根」而不是报错", () => {
    deepStrictEqual(parseEntry({ panel: "automation", sub: { detail: 5, scope: "mars" } }), { panel: "automation" });
  });
});

describe("落盘往返", () => {
  it("toMemoryFile → parseMemoryFile：顺序（旧→新）与内容不变；关着且无页签偏好的不落盘", () => {
    let memory: PanelMemory = rememberEntry(new Map(), "a", pluginDetail);
    memory = rememberEntry(memory, "closed", { panel: null });
    memory = rememberEntry(memory, "tab", { panel: null, taskTab: "context" });
    memory = rememberEntry(memory, "b", { panel: "review", sub: { tab: "excerpts" } });
    const file = toMemoryFile(memory);
    strictEqual(file.entries.length, 3);
    const back = parseMemoryFile(JSON.parse(JSON.stringify(file)));
    deepStrictEqual([...back.keys()], ["a", "tab", "b"]);
    deepStrictEqual(recallEntry(back, "a"), pluginDetail);
    deepStrictEqual(recallEntry(back, "b"), { panel: "review", sub: { tab: "excerpts" } });
  });

  it("读回的坏条目丢掉、好的保留；null（文件不在）= 空记忆；旧的 [id, 面板] 二元组也认", () => {
    strictEqual(parseMemoryFile(null).size, 0);
    const back = parseMemoryFile({
      version: 1,
      entries: [{ id: "a", panel: "bogus" }, { panel: "files" }, 7, ["old", "terminal"], { id: "ok", panel: "files" }],
    });
    deepStrictEqual([...back.keys()], ["old", "ok"]);
    deepStrictEqual(recallEntry(back, "old"), { panel: "terminal" });
  });

  it("mergeLoaded：启动读回的旧记忆在下，本次运行已记下的覆盖在上", () => {
    const loaded: PanelMemory = rememberEntry(rememberEntry(new Map(), "a", files), "b", files);
    const current: PanelMemory = rememberEntry(new Map(), "a", { panel: "terminal" });
    const merged = mergeLoaded(loaded, current);
    deepStrictEqual(recallEntry(merged, "a"), { panel: "terminal" });
    deepStrictEqual(recallEntry(merged, "b"), files);
    strictEqual([...merged.keys()].pop(), "a");
  });
});

describe("拿活数据再核一次：指向已不存在的东西 → 回列表", () => {
  it("plugins：selected 不在列表里 → 去掉 selected / board，其余（选择条的档）保留；列表没读回来时不动", () => {
    const sub = { selected: "gone", board: true as const, ws: { kind: "global" } as const };
    deepStrictEqual(resolvePluginsSub(sub, new Set(["other"])), { ws: { kind: "global" } });
    strictEqual(resolvePluginsSub(sub, new Set(["gone"])), sub);
    strictEqual(resolvePluginsSub(sub, null), sub);
    strictEqual(resolvePluginsSub({ selected: "gone" }, new Set()), undefined);
    strictEqual(resolvePluginsSub(undefined, new Set()), undefined);
  });

  it("automation：detail 不在 → 回列表，范围保留", () => {
    deepStrictEqual(resolveAutomationSub({ detail: "x", scope: "all" }, new Set(["y"])), { scope: "all" });
    strictEqual(resolveAutomationSub({ detail: "x" }, new Set(["y"])), undefined);
  });

  it("subsessions：打开的不是这个母会话的子会话 → 列表", () => {
    strictEqual(resolveSubSessionsSub({ sessionId: "c1" }, new Set(["c2"])), undefined);
    const keep = { sessionId: "c1" };
    strictEqual(resolveSubSessionsSub(keep, new Set(["c1"])), keep);
    strictEqual(resolveSubSessionsSub(keep, null), keep);
  });
});

describe("hasSubLayer：哪些面板有第二层", () => {
  it("六个带第二层；文件 / 终端 / 辅助对话 / 关着没有", () => {
    for (const kind of ["plugins", "automation", "review", "context", "subsessions", "intent"] as const) strictEqual(hasSubLayer(kind), true);
    for (const kind of ["files", "terminal", "drawer", null] as const) strictEqual(hasSubLayer(kind), false);
  });
});

describe("composeEntry：App 写穿时拼出的完整条目", () => {
  const base = { openedDraft: null, subSessionId: null, taskTab: "progress" as const };

  it("插件面板：面板报的第二层 + App 持有的草稿；过期路径里带的旧草稿不算", () => {
    const entry = composeEntry({
      ...base,
      rightPanel: "plugins",
      path: { panel: "plugins", sub: { selected: "p1", draft: { path: "/old", workspaceId: null } } },
      openedDraft: { path: "/new", workspaceId: "w" },
    });
    deepStrictEqual(entry, { panel: "plugins", sub: { selected: "p1", draft: { path: "/new", workspaceId: "w" } } });
    // 草稿被放下后：旧草稿不会从路径里复活
    deepStrictEqual(
      composeEntry({ ...base, rightPanel: "plugins", path: { panel: "plugins", sub: { selected: "p1", draft: { path: "/old", workspaceId: null } } } }),
      { panel: "plugins", sub: { selected: "p1" } },
    );
  });

  it("路径属于别的面板（刚换面板、还没来得及报）：当作该面板的根", () => {
    deepStrictEqual(composeEntry({ ...base, rightPanel: "review", path: { panel: "plugins", sub: { selected: "p1" } } }), { panel: "review" });
  });

  it("子会话面板：第二层来自 App 的子会话层；这条任务页签随条目记（面板关着也记）", () => {
    deepStrictEqual(composeEntry({ ...base, rightPanel: "subsessions", path: { panel: null }, subSessionId: "c1" }), {
      panel: "subsessions",
      sub: { sessionId: "c1" },
    });
    deepStrictEqual(composeEntry({ ...base, rightPanel: null, path: { panel: null }, taskTab: "context" }), { panel: null, taskTab: "context" });
  });

  it("没有第二层的面板：只记种类，路径里的 sub 被丢", () => {
    deepStrictEqual(composeEntry({ ...base, rightPanel: "files", path: { panel: "files" } }), { panel: "files" });
  });

  it("同一条会话换面板再回来：A 面板的第二层不会跟到 B 面板上", () => {
    const a = composeEntry({ ...base, rightPanel: "automation", path: { panel: "automation", sub: { detail: "x" } } });
    deepStrictEqual(a, { panel: "automation", sub: { detail: "x" } });
    deepStrictEqual(composeEntry({ ...base, rightPanel: "intent", path: { panel: "automation", sub: { detail: "x" } } }), { panel: "intent" });
  });
});
