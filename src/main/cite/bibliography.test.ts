/**
 * `\bibliography` / `\addbibresource` 的解析 —— 「用户写论文时到底引用哪一份 .bib」。
 *
 * 这条规则错了不会报错：只是把文献写进一份没人 `\bibliography` 的文件，编译时
 * `\cite` 仍未定义，而界面说「已写入」（评审 F5）。样本都是真实写法。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { declaredBibFiles } from "./bibliography.ts";

describe("declaredBibFiles", () => {
  test("经典写法：不带后缀也要补成 .bib", () => {
    assert.deepEqual(declaredBibFiles("\\bibliography{refs}"), [{ path: "refs.bib" }]);
  });

  test("带目录", () => {
    assert.deepEqual(declaredBibFiles("\\bibliography{refs/lit}"), [{ path: "refs/lit.bib" }]);
  });

  test("逗号多份：按顺序都要（取第一份由写盘那层决定）", () => {
    assert.deepEqual(declaredBibFiles("\\bibliography{refs/lit,extra}"), [
      { path: "refs/lit.bib" },
      { path: "extra.bib" },
    ]);
  });

  test("biblatex：\\addbibresource，带选项、带后缀", () => {
    assert.deepEqual(
      declaredBibFiles("\\addbibresource[location=local, labelnumber]{refs/library.bib}"),
      [{ path: "refs/library.bib" }],
    );
  });

  test("命令与花括号之间有空格 / 换行也认", () => {
    assert.deepEqual(declaredBibFiles("\\bibliography\n  { refs }"), [{ path: "refs.bib" }]);
  });

  test("注释里的不算：注释掉的 \\bibliography 不该被当成目标", () => {
    const source = ["% \\bibliography{old}", "\\bibliography{refs} % 当前用的"].join("\n");
    assert.deepEqual(declaredBibFiles(source), [{ path: "refs.bib" }]);
  });

  test("`\\%` 是字面量，不当注释起点", () => {
    assert.deepEqual(declaredBibFiles("50\\% done\n\\bibliography{refs}"), [{ path: "refs.bib" }]);
  });

  test("去重（同一份被声明两次）", () => {
    assert.deepEqual(declaredBibFiles("\\bibliography{refs}\\bibliography{REFS.bib}"), [{ path: "refs.bib" }]);
  });

  test("没有声明：空数组（写盘那层退回约定）", () => {
    assert.deepEqual(declaredBibFiles("\\documentclass{article}\n\\begin{document}\\end{document}"), []);
  });
});
