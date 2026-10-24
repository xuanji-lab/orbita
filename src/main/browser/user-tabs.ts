import type { BrowserTabSummary } from "../../shared/browser.ts";

/**
 * 用户的 tab：开在哪（sandbox.ts）、怎么讲给模型（agent-requests.ts 的 browser_tabs）。
 * 纯函数，不 import electron，node --test 直接加载。
 *
 * 开在哪——用户 2026-09-29 裁决「逻辑不要太复杂，点链接就每次新开，重复的已经开了的就不新开」，
 * 所以只有三条，按顺序：
 *   1. 已有用户 tab 正开着同一个地址 → 切过去，不重复开
 *   2. 最近用过的那个用户 tab 是空白页（刚建的窗口、刚点的「+」）→ 就在它里面开，
 *      不在旁边留一个空 tab——窗口第一次打开时自带一个空的，不复用就是每次多一个
 *   3. 否则新开一个
 * 地址比较用加载后的规范形式（调用方传 URL.href / pathToFileURL().href），跳转过的页面
 * 认不出是同一个就新开——不为它加规则。
 */
export interface UserTabView {
  id: string;
  /** 页面当前地址；没加载过为空串 */
  url: string;
  loading: boolean;
}

export type UserTabPlacement =
  | { kind: "switch"; id: string }
  | { kind: "reuse"; id: string }
  | { kind: "new" };

export function placeInUserTab(url: string, tabs: readonly UserTabView[], currentId: string): UserTabPlacement {
  const open = tabs.find((tab) => tab.url === url);
  if (open !== undefined) return { kind: "switch", id: open.id };
  const current = tabs.find((tab) => tab.id === currentId);
  if (current !== undefined && current.url === "" && !current.loading) return { kind: "reuse", id: current.id };
  return { kind: "new" };
}

/**
 * browser_tabs 的正文：用户的每个 tab 带 id（读取类工具的 tab 参数就传它）、自己的 tab 一行；
 * 标出哪个此刻在屏幕上、哪个在交接中。读哪个用户 tab 由模型按上下文挑，这里只给事实。
 */
export function describeTabs(tabs: readonly BrowserTabSummary[], onScreenTabId: string | null): string {
  const lines = tabs.map((tab) => {
    const who = tab.owner.kind === "user" ? `User tab ${tab.id}` : "Your tab";
    const page = tab.url === "" ? "empty" : `${tab.title === "" ? "(untitled)" : tab.title} — ${tab.url}`;
    return (
      `- ${who}: ${page}${tab.id === onScreenTabId ? " (on screen now)" : ""}` +
      `${tab.loading ? " (loading)" : ""}${tab.handoff !== undefined ? " (handed to the user)" : ""}`
    );
  });
  return [
    "Open browser tabs:",
    ...lines,
    "To read one of the user's tabs, pass its id as tab (read-only); pick the one that matches what the user is " +
      "talking about. If the user already has the page you need open (often signed in through a library or proxy " +
      "address), read it instead of starting over; to act on it, open the same address in your own tab — its " +
      "sign-in state is separate, so sign in there or hand that tab to the user.",
  ].join("\n");
}
