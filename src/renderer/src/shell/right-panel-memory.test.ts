import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { recallPanel, rememberPanel, type PanelMemory } from "./right-panel-memory.ts";

/**
 * 右栏面板的按会话记忆（right-panel-memory.ts）。覆盖：切走记、切回恢复、新会话
 * 关着、关掉面板也记成「关着」、覆盖更新、首页不记、引用打开文件面板被记住。
 */

describe("rememberPanel / recallPanel：切走记、切回恢复", () => {
  it("A 开着文件面板离开：记下 files；回到 A 恢复 files", () => {
    const memory = rememberPanel(new Map(), "a", "files");
    strictEqual(recallPanel(memory, "a"), "files");
  });

  it("B 的记忆与 A 互不干扰：各自恢复各自的面板", () => {
    let memory: PanelMemory = rememberPanel(new Map(), "a", "files");
    memory = rememberPanel(memory, "b", "terminal");
    strictEqual(recallPanel(memory, "a"), "files");
    strictEqual(recallPanel(memory, "b"), "terminal");
  });

  it("同一条会话再次离开时覆盖：最后一次的面板才算数", () => {
    let memory: PanelMemory = rememberPanel(new Map(), "a", "files");
    memory = rememberPanel(memory, "a", "skills");
    strictEqual(recallPanel(memory, "a"), "skills");
  });

  it("离开时面板是关着的：也记（恢复成关着，而不是漏记后回退到更早的记忆）", () => {
    let memory: PanelMemory = rememberPanel(new Map(), "a", "files");
    memory = rememberPanel(memory, "a", null);
    strictEqual(recallPanel(memory, "a"), null);
  });
});

describe("recallPanel：没记过的会话", () => {
  it("从没开过右栏的会话 / 新会话：恢复成关着", () => {
    strictEqual(recallPanel(new Map(), "fresh-session"), null);
  });

  it("别的会话的记忆不串到没记过的会话上", () => {
    const memory = rememberPanel(new Map(), "a", "files");
    strictEqual(recallPanel(memory, "b"), null);
  });
});

describe("首页 / 还没有会话（session 为 null）不参与记忆", () => {
  it("离开到首页时不记（原 Map 原样返回，不新建）", () => {
    const memory = rememberPanel(new Map(), "a", "files");
    strictEqual(rememberPanel(memory, null, "terminal"), memory);
  });

  it("首页恢复成关着（App 换取「沿用当前面板」时不由记忆说话）", () => {
    const memory = rememberPanel(new Map(), "a", "files");
    strictEqual(recallPanel(memory, null), null);
  });
});

describe("场景：会话里点 PDF 引用把右栏切到文件面板", () => {
  it("引用打开的 files 同样被记为该会话的面板，回到该会话恢复 files", () => {
    // App 的 openCitation 会 setRightPanel("files")——与手动点开文件图标同一条
    // 状态，离开时照记；恢复 files 面板本身不会重放旧引用请求（那由 cite-focus
    // 的会话戳 + App 随面板关闭清 citeFocus 保证，见 cite-focus.test.ts）
    const memory = rememberPanel(new Map(), "a", "files");
    deepStrictEqual(recallPanel(memory, "a"), "files");
  });

  it("记忆只存面板种类：不带文件面板里打开的标签（Map 的值就是种类，无标签可带）", () => {
    const memory = rememberPanel(new Map(), "a", "files");
    deepStrictEqual(
      [...memory.entries()],
      [["a", "files"]],
    );
  });
});
