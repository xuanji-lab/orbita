import { deepStrictEqual, match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * 「一套组件两种排法」的合同：排法只看容器宽度，所以 CSS 里
 * - 根 .pl-page 是命名容器（pl）、inline-size；
 * - 整个文件只有**一个**宽度断点：`@container pl (max-width: 639px)`（窄于 640 = 单列），
 *   别处再冒出断点就说明有人在给某个外壳单独打补丁；
 * - 详情两列在宽档是显式两列、窄档叠成一列（不再靠 auto-fit minmax(320px)——320 宽的右栏装不下）。
 * 没有 JS 对宽度的感知，所以这里读 CSS 文本对账。
 */

// 注释里会提到 @container / @media 字样：先剥掉再对账
const css = readFileSync(new URL("./plugins.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 取 `@container pl (…) {…}` 的块体（花括号配平） */
function containerBlocks(source: string): { query: string; body: string }[] {
  const blocks: { query: string; body: string }[] = [];
  const opener = /@container\s+([^{]+)\{/g;
  for (let found = opener.exec(source); found !== null; found = opener.exec(source)) {
    let depth = 1;
    let index = opener.lastIndex;
    while (depth > 0 && index < source.length) {
      const char = source[index];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      index += 1;
    }
    blocks.push({ query: (found[1] ?? "").trim(), body: source.slice(opener.lastIndex, index - 1) });
  }
  return blocks;
}

describe("plugins.css：容器查询", () => {
  it("根 .pl-page 是命名的 inline-size 容器", () => {
    const rule = /\.pl-page\s*\{([^}]*)\}/.exec(css);
    ok(rule !== null);
    match(rule[1] ?? "", /container:\s*pl\s*\/\s*inline-size/);
  });

  it("全文件只有一个宽度断点：@container pl (max-width: 639px)", () => {
    deepStrictEqual(
      containerBlocks(css).map((block) => block.query),
      ["pl (max-width: 639px)"],
    );
    ok(!/@media/.test(css), "插件页不按视口宽度排版");
  });

  it("窄档里：详情叠成单列、列表行的次要列收起", () => {
    const narrow = containerBlocks(css)[0]?.body ?? "";
    match(narrow, /\.pl-cols\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/);
    match(narrow, /\.pl-kinds,\s*\.pl-from\s*\{[^}]*display:\s*none/);
  });

  it("宽档的详情是显式两列（不是 auto-fit minmax(320px)）", () => {
    const wide = /\.pl-cols\s*\{([^}]*)\}/.exec(css);
    ok(wide !== null);
    match(wide[1] ?? "", /repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  });
});
