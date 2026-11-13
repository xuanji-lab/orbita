/**
 * 「在文件树里点一个文件」这组动作的守卫：**建/复用标签 + 切到它，两件都得在**。
 *
 * 为什么是读源码而不是渲染组件：这条链在组件里是两次状态写入（`setTabs(openTab(...))`
 * 与 `switchTo(...)`），少一半时 **typecheck 没有任何报错**，表现只是「行变选中、面板
 * 里不出现标签」——2026-11 的集成分支就是这样把 `setTabs(openTab(...))` 丢在合并冲突
 * 里的（`openFile` 只剩 `switchTo`，`.cap-tab` 恒为 0，LaTeX 工作台进不去）。仓库没有
 * DOM 测试环境，而这类「成对调用被吃掉一行」的回归只能靠调用点守卫来拦。
 *
 * 守的是两条入口（面板里只有这两处会从「一条路径」开出新标签）：
 * - `openFile`：文件树 / 附件行 / 左栏双击（focusFileOpen 也走它）
 * - `openSentImage`：会话里的附图行
 *
 * 判定用一个宽松的正则集合，不绑定缩进与换行：要求同一函数体里同时出现
 * 「往 tabs 里加」与「切过去」，至于 `setActivePath` 还是 `switchTo` 允许并存。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PANEL = join(dirname(fileURLToPath(import.meta.url)), "FilesPanel.tsx");

/** 取出 `const <name> = (` 起、花括号配平的那个函数体（跳过字符串里的括号足够用了：这里只找调用） */
function functionBody(source: string, name: string): string | null {
  const start = source.indexOf(`const ${name} = (`);
  if (start < 0) return null;
  const open = source.indexOf("{", source.indexOf("=>", start));
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return null;
}

describe("文件树点击：建标签与切标签必须成对", () => {
  it("openFile：既往 tabs 里 openTab，也切到那条路径", () => {
    const body = functionBody(readFileSync(PANEL, "utf8"), "openFile");
    assert.ok(body !== null, "FilesPanel.tsx 里找不到 openFile（函数被改名时这条守卫要跟着改）");
    assert.match(body, /openTab\(/, "openFile 丢了 setTabs(openTab(...))：点文件只会变选中，不会开出标签");
    assert.match(body, /switchTo\(path\)/, "openFile 丢了 switchTo(path)：标签开了但不会切过去");
  });

  it("openSentImage：同样两件都在（附图行的第二条入口）", () => {
    const body = functionBody(readFileSync(PANEL, "utf8"), "openSentImage");
    assert.ok(body !== null, "FilesPanel.tsx 里找不到 openSentImage");
    assert.match(body, /openTab\(/, "openSentImage 丢了 setTabs(openTab(...))");
    assert.match(body, /switchTo\(ref\)/, "openSentImage 丢了 switchTo(ref)");
  });

  it("切走闸门还在：两条入口都先过 leaveActive（docx 落盘 / .tex 脏改动）", () => {
    const source = readFileSync(PANEL, "utf8");
    for (const name of ["openFile", "openSentImage"]) {
      const body = functionBody(source, name) ?? "";
      assert.match(body, /leaveActive\(/, `${name} 丢了 leaveActive 闸门：未落盘的改动会被直接丢掉`);
    }
  });
});
