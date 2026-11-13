/**
 * 辅助对话的页头住顶部右栏胶囊（2026-11-07）的结构守卫：面板里不再有自己的标签行与
 * 卡内标题行，会话信息（名字 / 短 id / 改名 / 完成）仍然可达——只是搬到了胶囊里，
 * 且与主会话胶囊用的是同一批组件，不是另造一套。标签增删的纯逻辑在 drawer-state.test.ts，
 * 滚轮换算在 h-scroll.test.ts。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name: string): string => readFileSync(join(HERE, name), "utf8");

const drawer = read("Drawer.tsx");
const cap = read("DrawerCap.tsx");
const session = read("SessionCapsule.tsx");
const css = read("toolbar.css");

test("面板里不再画自己的标签行；ChatView 去掉卡内标题行", () => {
  assert.ok(!drawer.includes("drawer-tabs"), "Drawer 又画了 .drawer-tabs 一行");
  assert.ok(!read("../styles.css").includes(".drawer-tab"), "styles.css 里还留着 .drawer-tab* 的死样式");
  assert.match(drawer, /<ChatView[\s\S]*?\bbareHeader\b[\s\S]*?\/>/, "辅助对话的 ChatView 没传 bareHeader");
});

test("标题信息仍可达：胶囊用主会话胶囊同一批组件（改名 / 短 id 复制 / 完成键）", () => {
  assert.match(cap, /<CapTitle[\s\S]*?onRename=/, "DrawerCap 没接改名");
  assert.match(cap, /<CapSessionId /, "DrawerCap 没摆短 id");
  assert.match(cap, /<CapCompletion /, "DrawerCap 没摆完成键");
  // 主会话胶囊是同一批组件的另一个消费者——不是复制粘贴
  assert.match(session, /<CapTitle[\s\S]*?balance/, "SessionCapsule 没用 CapTitle");
  assert.match(session, /<CapSessionId /, "SessionCapsule 没用 CapSessionId");
  assert.match(session, /<CapCompletion /, "SessionCapsule 没用 CapCompletion");
  // Drawer 把改名 / 完成接到抽屉槽上
  assert.match(drawer, /renameSession\(realTab, title\)/, "Drawer 没把改名接到抽屉槽");
  assert.match(drawer, /setCompletionSession\(realTab, next\)/, "Drawer 没把完成接到抽屉槽");
});

test("完成键只在抽屉槽确实开着这条会话时才摆（切标签那一帧不点到上一条头上）", () => {
  assert.match(drawer, /realTab !== null && viewOpenId === realTab/);
});

test("胶囊里的标签区：横滚走共用 hook，「+」在滚动区外永远可见，激活的有自己的关闭出口", () => {
  assert.match(cap, /useHScroll\(/);
  assert.match(cap, /className="cap-dtabs h-scroll/);
  // 「+」在标签区（overflow）之外
  assert.match(cap, /<\/div>\s*\)\}\s*<PanelIconButton title=\{t\.drawer\.newTab\}/, "「+」被放进了滚动区里");
  assert.match(cap, /onClick=\{props\.onCloseActive\}/);
  // 悬停才显形的 × 必须在左段里（挤的是标题），不能在标签区左边挤标签区
  assert.match(cap, /<div className="cap-dseg no-drag">[\s\S]*?cap-dclose[\s\S]*?<\/div>\s*<span className="cap-grow"/, "关闭当前这条的 × 跑出了左段，悬停会把标签区挤歪");
  assert.match(css, /\.cap-dtabs\s*\{[^}]*flex:\s*0 0 auto/s, "标签区又会 shrink 了——悬停显形小键会让它的宽度变化");
  // 窄栏让位顺序：短 id 先让、左段保底 72、标签区封顶 38%
  assert.match(css, /\.cap-dtabs\s*\{[^}]*max-width:\s*38%/s);
  assert.match(css, /\.cap-dseg\s*\{[^}]*min-width:\s*72px/s);
  assert.match(css, /@container \(max-width: 440px\)\s*\{\s*\.cap-dcap \.cap-dseg \.cap-sid/);
});

test("工作区选择条与胶囊标签区共用一份滚动 hook", () => {
  assert.match(read("WorkspaceFilterBar.tsx"), /useHScroll\(/);
});

test("新任务：激活即回首页；拿到真 id 以「正激活新任务页」为判据（占位从不落盘，按占位判永远不触发）", () => {
  assert.match(drawer, /if \(tab === NEW_TASK_TAB\) \{[\s\S]*?props\.view\.newTask\(\)/, "激活新任务页没让抽屉槽回首页");
  assert.match(drawer, /activeTab !== NEW_TASK_TAB\) return;\s*props\.onDockedChange\(adoptNewTab\(props\.docked, id\)\)/);
  assert.ok(!/docked\.includes\(NEW_TASK_TAB\)\) return;/.test(drawer), "又按「docked 里有 new 占位」判了——占位被 onDockedChange 滤掉，这一步永远不触发");
});
