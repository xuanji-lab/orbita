/**
 * 设计系统总述与通用行配方的对缝：运行色、选中字重和 compact 的语义不能再各说一套。
 * 分段控件 / 文件行等特例不在这份通用规则里，不能借机全局改字重。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (path: string): string => readFileSync(join(HERE, path), "utf8").replace(/\r\n/g, "\n");
const styles = read("../styles.css");
const readme = read("../../../../design-system/readme.md");

describe("option-row 与 design-system 的契约", () => {
  it("通用列表行选中不改字重：选中底与主墨色承担状态，文字宽度不变", () => {
    const block = /\.option-row\[aria-pressed="true"\],\s*\.option-row\[aria-selected="true"\],\s*\.option-row\[data-active="true"\]\s*\{([^}]*)\}/.exec(styles);
    assert.ok(block !== null, "找不到 option-row 的选中规则");
    const body = block?.[1] ?? "";
    assert.notEqual(body, "", "选中规则体为空");
    assert.match(body, /font-weight: var\(--weight-regular\)/);
    assert.doesNotMatch(body, /semibold/);
    assert.match(readme, /selected row takes `--option-active-bg` and \*\*does not change weight\*\*/);
    assert.doesNotMatch(readme, /selected `--option-active-bg` \+ semibold/);
    // 分段控件是另一种组件，不跟着列表行改：它仍可半粗
    assert.match(styles, /\.seg-control > button\[aria-pressed="true"\] \{\s*background: var\(--option-active-bg\);\s*color: var\(--color-text-primary\);\s*font-weight: var\(--weight-semibold\)/);
  });

  it("运行 = info 蓝、等你 = warning 橙，总述与状态饼一致", () => {
    assert.match(readme, /info blue .* means running/);
    assert.match(readme, /amber\s+.* means waiting for your reply/);
    assert.doesNotMatch(readme, /amber[^;\n]*means running/);
  });

  it("compact 只指上下文压缩；密度叫 dense", () => {
    assert.match(readme, /`compact` is reserved for context compaction; a density variant is called `dense`, never `compact`/);
  });
});
