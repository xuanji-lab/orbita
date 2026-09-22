import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { filterEntries, footerSummary, hasAgentsMd, orderEntries } from "./tree-view.ts";
import type { FileEntry } from "../../../../shared/files.ts";

const dir = (name: string): FileEntry => ({ name, kind: "directory", modifiedAt: 0 });
const file = (name: string): FileEntry => ({ name, kind: "file", size: 1, modifiedAt: 0 });

describe("orderEntries", () => {
  it("`.` 开头的照列，但排到同层最后（主进程的名次不动）", () => {
    deepStrictEqual(
      orderEntries([dir("src"), file(".DS_Store"), file("AGENTS.md"), dir(".orbita")]),
      [dir("src"), file("AGENTS.md"), file(".DS_Store"), dir(".orbita")],
    );
  });

  it("没有 dotfile 时保持主进程顺序（稳定，不重排）", () => {
    const entries = [dir("docs"), dir("src"), file("package.json")];
    deepStrictEqual(orderEntries(entries), entries);
  });

  it("dotfile 之间保持原有相对顺序", () => {
    deepStrictEqual(
      orderEntries([file(".zshrc"), file(".DS_Store"), file("readme")]),
      [file("readme"), file(".zshrc"), file(".DS_Store")],
    );
  });
});

describe("filterEntries", () => {
  const entries = [dir("src"), dir("docs"), file("package.json"), file(".DS_Store")];

  it("空白词 = 不过滤（面板里删词回到全量）", () => {
    deepStrictEqual(filterEntries(entries, "  "), entries);
    deepStrictEqual(filterEntries(entries, ""), entries);
  });

  it("按名字子串裁剪，大小写不敏感；只裁已加载的这层，不递归", () => {
    deepStrictEqual(filterEntries(entries, "SRC"), [dir("src")]);
    deepStrictEqual(filterEntries(entries, "json"), [file("package.json")]);
  });

  it("dotfile 也要能被过滤词找到（照列的另一半：能搜到）", () => {
    deepStrictEqual(filterEntries(entries, "ds"), [file(".DS_Store")]);
  });

  it("全都不匹配时是空数组（调用方安静地不渲染）", () => {
    deepStrictEqual(filterEntries(entries, "zzz"), []);
  });
});

describe("hasAgentsMd", () => {
  it("第一层有 AGENTS.md：有 rules，不出提示行", () => {
    deepStrictEqual(hasAgentsMd([dir("src"), file("AGENTS.md")]), true);
  });

  it("没有就是没有——提示行是「找不到规则文件」的痛点落点，不能错报", () => {
    deepStrictEqual(hasAgentsMd([dir("src"), file("package.json")]), false);
    deepStrictEqual(hasAgentsMd([]), false);
  });

  it("大小写不同的近似名不算（模板与 agent 写的都是 AGENTS.md，精确匹配）", () => {
    deepStrictEqual(hasAgentsMd([file("agents.md")]), false);
  });
});

describe("footerSummary", () => {
  it("单数 root", () => {
    deepStrictEqual(footerSummary(1, 0), "1 root");
  });

  it("复数 roots", () => {
    deepStrictEqual(footerSummary(3, 0), "3 roots");
  });

  it("attached 在盘上缺席：如实追加 missing，不静默", () => {
    deepStrictEqual(footerSummary(4, 1), "4 roots · 1 missing");
    deepStrictEqual(footerSummary(5, 2), "5 roots · 2 missing");
  });
});
