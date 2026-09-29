import { test } from "node:test";
import assert from "node:assert/strict";
import type { BrowserTabSummary } from "../../shared/browser.ts";
import { describeTabs, placeInUserTab, type UserTabView } from "./user-tabs.ts";

const tab = (id: string, url: string, loading = false): UserTabView => ({ id, url, loading });

test("placeInUserTab：已有 tab 开着同一地址就切过去，哪怕它不是最近用的那个", () => {
  const tabs = [tab("a", "https://github.com/"), tab("b", "https://example.com/")];
  assert.deepEqual(placeInUserTab("https://github.com/", tabs, "b"), { kind: "switch", id: "a" });
});

test("placeInUserTab：最近用的 tab 是空白页就在它里面开；加载中的空白页不算（它马上就有东西了）", () => {
  assert.deepEqual(placeInUserTab("https://github.com/", [tab("a", "")], "a"), { kind: "reuse", id: "a" });
  assert.deepEqual(placeInUserTab("https://github.com/", [tab("a", "", true)], "a"), { kind: "new" });
});

test("placeInUserTab：别处有空白 tab 但最近用的不是空白页 → 新开（只复用眼前那个空页）", () => {
  const tabs = [tab("a", ""), tab("b", "https://example.com/")];
  assert.deepEqual(placeInUserTab("https://github.com/", tabs, "b"), { kind: "new" });
});

test("placeInUserTab：本地网页按 file:// 地址比较；没有用户 tab 时新开", () => {
  const file = "file:///Users/me/Orbita/Home/chart.html";
  assert.deepEqual(placeInUserTab(file, [tab("a", file)], "b"), { kind: "switch", id: "a" });
  assert.deepEqual(placeInUserTab(file, [], ""), { kind: "new" });
});

const summary = (id: string, owner: BrowserTabSummary["owner"], url: string, title: string): BrowserTabSummary => ({
  id,
  owner,
  url,
  title,
  loading: false,
});

test("describeTabs：用户的每个 tab 带 id、标出在屏幕上的那个；自己的 tab 不带 id；交接中如实标出", () => {
  const text = describeTabs(
    [
      summary("u1", { kind: "user" }, "https://scopus.com/", "Scopus"),
      summary("u2", { kind: "user" }, "", ""),
      { ...summary("a1", { kind: "agent", sessionId: "s", sessionTitle: "T" }, "https://x.org/", ""), handoff: { toolCallId: "c", reason: "r" } },
    ],
    "u1",
  );
  const lines = text.split("\n");
  assert.equal(lines[1], "- User tab u1: Scopus — https://scopus.com/ (on screen now)");
  assert.equal(lines[2], "- User tab u2: empty");
  assert.equal(lines[3], "- Your tab: (untitled) — https://x.org/ (handed to the user)");
  assert.match(text, /pass its id as tab/);
});

test("describeTabs：窗口不在屏幕上时不标任何一个", () => {
  const text = describeTabs([summary("u1", { kind: "user" }, "https://scopus.com/", "Scopus")], null);
  assert.doesNotMatch(text, /on screen/);
});
