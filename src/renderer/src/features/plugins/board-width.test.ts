import { doesNotMatch, match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * 「看板宽度只听外面、不被里面撑开」的合同。
 *
 * 格宽是像素（BoardGrid 量到 host 宽后算出来的）。host 的内在宽度若按里面的固定像素列算，
 * 拉宽右栏后再缩窄，祖先（flex 的 min-width:auto、grid 的隐式 auto 列）会被这一块撑住，
 * ResizeObserver 又量到被撑住的宽——互相卡死，出横向滚动条，关掉面板再开才恢复（实测 481 → 260px，host 仍 406px）。
 * 没有 JS 可测的几何，所以这里读 CSS 文本对账；真实几何由实例里的 CDP 断言把关。
 */

function rule(file: string, selector: string): string {
  const css = readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const escaped = selector.replace(/[.[\]"=()]/g, "\\$&");
  const found = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  ok(found !== null, `${file} 里没有 ${selector} 规则`);
  return found[1] ?? "";
}

describe("看板宽度不被内容撑开", () => {
  it("容器模式的宿主 contain: inline-size（内在宽度为 0，宽度只由外面给）", () => {
    match(rule("./plugin-panel.css", '.bd-host[data-mode="container"]'), /contain:\s*inline-size/);
  });

  it("放看板的 grid 祖先都是 minmax(0, 1fr) 单列，不留会按内容撑宽的隐式 auto 列", () => {
    for (const [file, selector] of [
      ["./plugins.css", ".pl-card"],
      ["./plugins.css", ".pl-col"],
      ["./plugins.css", ".pl-boardview"],
      ["../board/board.css", ".board-result"],
    ] as const) {
      match(rule(file, selector), /grid-template-columns:\s*minmax\(0,\s*1fr\)/, `${selector}`);
    }
  });

  it("「看板样式」一节：.pd-board 是 minmax(0, 1fr) 单列上下叠，看板没有宽度上限、不再与说明列表并排", () => {
    const board = rule("./plugins.css", ".pd-board");
    match(board, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    match(board, /min-width:\s*0/);
    doesNotMatch(board, /flex/);
    const grid = rule("./plugins.css", ".pd-board-grid");
    match(grid, /min-width:\s*0/);
    doesNotMatch(grid, /max-width|flex/);
    doesNotMatch(rule("./plugins.css", ".pd-blist"), /flex/);
  });
});
