/**
 * TeX 文本的**纯**小工具（renderer 侧）：注释判定与剔除。
 *
 * 为什么单列一个文件：补全（latex-suggest）、折叠（latex-fold）、大纲
 * （latex-outline）三处都要回答「这行这个位置是不是在注释里」。三份各写一遍迟早
 * 分家——`\%` 是字面量、`\\%` 里的 `%` 仍是注释，这两条规则只该有一份实现。
 *
 * 与主进程 `src/main/latex/index.ts` 的 `stripTexComments` 是**同一套规则的两份实现**
 * （两个进程，不能互相 import）：主进程那份给索引，这份给编辑器；改动时两处一起改。
 */

/** `line` 里 `position` 之前有没有未转义的 `%`（即此处是否在注释里） */
export function inTexComment(line: string, position: number): boolean {
  const end = Math.min(position, line.length);
  for (let i = 0; i < end; i += 1) {
    if (line[i] !== "%") continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && line[j] === "\\"; j -= 1) backslashes += 1;
    if (backslashes % 2 === 0) return true;
  }
  return false;
}

/** 去掉 TeX 注释（保留换行，行号不变）；`\verb|%|` 里的 % 认不出来，已知取舍 */
export function stripTexComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] !== "%") continue;
        let backslashes = 0;
        for (let j = i - 1; j >= 0 && line[j] === "\\"; j -= 1) backslashes += 1;
        if (backslashes % 2 === 0) return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}
