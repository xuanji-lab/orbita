/**
 * 主文件里**用户自己声明的**文献库 —— `\bibliography{refs/lit}`（经典 BibTeX）与
 * `\addbibresource{refs/lit.bib}`（biblatex）。
 *
 * 为什么必须先读它（评审 F5）：只按「项目根 refs.bib → 第一份 .bib」猜会写进一份
 * **没人 `\bibliography` 的**文件——用户在 `refs/lit.bib` 里维护文献，我们却往
 * `notes.bib` 追加，编译时 `\cite` 依旧是未定义，而且看起来「写成功了」。
 *
 * 解析口径尽量小：读源码全文、去注释、按命令名抓花括号里的参数。不解释宏展开、
 * 不处理 `\input` 引入的主文件——那要把 TeX 解释器搬进来，而这一层的判断标准只有
 * 「用户写了哪个文件名」。抓不到就回空数组，退回猜的那套。
 */

/** 一份候选 `.bib` 的路径写法：相对项目目录、`/` 分隔、带 `.bib` 后缀 */
export interface BibDeclaration {
  /** 用户写下的原样参数（去空白，已补 `.bib`） */
  path: string;
}

/**
 * 从一份 `.tex` 源码里取出声明过的 `.bib`，**按出现顺序、去重**。
 * `\bibliography{a,b}` 的逗号列表逐项展开；`\addbibresource[opts]{x}` 的选项忽略。
 */
export function declaredBibFiles(source: string): BibDeclaration[] {
  const text = stripComments(source);
  const found: BibDeclaration[] = [];

  for (const match of text.matchAll(/\\bibliography\s*\{([^}]*)\}/g)) {
    for (const part of (match[1] ?? "").split(",")) {
      pushDeclaration(found, part);
    }
  }
  for (const match of text.matchAll(/\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
    pushDeclaration(found, match[1] ?? "");
  }
  return found;
}

function pushDeclaration(found: BibDeclaration[], raw: string): void {
  const cleaned = raw.trim().replace(/^["']|["']$/g, "");
  if (cleaned === "") return;
  // 经典写法不带后缀，biblatex 常带：统一补上，比较时才不会出现 refs 与 refs.bib 两份
  const path = /\.bib$/i.test(cleaned) ? cleaned : `${cleaned}.bib`;
  if (found.some((item) => item.path.toLowerCase() === path.toLowerCase())) return;
  found.push({ path });
}

/**
 * 去掉 `%` 注释：`%` 到行尾都算注释，但 `\%` 是字面量。**换行保留**——行号与
 * 命令的相邻关系不参与判断，但保留它让「一行的后半段被注释」这种情况处理正确。
 */
function stripComments(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => {
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] !== "%") continue;
        // 数一数前面连着几个反斜杠：偶数个说明 % 没被转义
        let slashes = 0;
        for (let j = i - 1; j >= 0 && line[j] === "\\"; j -= 1) slashes += 1;
        if (slashes % 2 === 0) return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}
