/**
 * 更新说明转纯文本的测试（updater/notes.ts）。
 *
 * 输入是 GitHub 给的真实形状：Release 正文渲染出来的 HTML（段落、二级标题、列表、
 * 行内加粗），实体会被 atom feed 转义。钉正常路径与四个边界：没有内容、纯文本原样、
 * 正文里的 `<` 不被吃掉、超长截断。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { releaseNotesText } from "./notes.ts";

describe("releaseNotesText —— 更新说明转纯文本", () => {
  test("HTML 段落与列表变成逐行文本，行内标签剥掉", () => {
    const html =
      '<p>本地优先的桌面 AI Agent。</p><h2>一、Agent 与对话</h2>' +
      "<ul><li><strong>独立进程的 agent</strong>：工具输出再大也不和界面抢事件循环。</li>" +
      "<li>两件事<br>第二行</li></ul>";
    assert.equal(
      releaseNotesText(html),
      [
        "本地优先的桌面 AI Agent。",
        "一、Agent 与对话",
        "· 独立进程的 agent：工具输出再大也不和界面抢事件循环。",
        "· 两件事",
        "第二行",
      ].join("\n"),
    );
  });

  test("实体解回可读字符（含 &amp; 不在别的实体之前解）", () => {
    assert.equal(releaseNotesText("<p>a &amp; b &quot;c&quot; &lt;tag&gt;</p>"), 'a & b "c" <tag>');
    assert.equal(releaseNotesText("<p>&amp;lt;p&amp;gt;</p>"), "&lt;p&gt;");
    assert.equal(releaseNotesText("<p>换行&nbsp;不换行</p>"), "换行 不换行");
    assert.equal(releaseNotesText("<p>&#20013;&#x6587;</p>"), "中&#x6587;");
  });

  test("空行整个丢掉（块级标签之间的换行不留白）", () => {
    assert.equal(releaseNotesText("<p>一</p><div></div><p>二</p>"), "一\n二");
    assert.equal(releaseNotesText("<ul><li>a</li></ul>\n\n<p>b</p>"), "· a\nb");
  });

  test("没有内容 / 空白 / undefined 都是 null（界面据此不画展开器）", () => {
    assert.equal(releaseNotesText(null), null);
    assert.equal(releaseNotesText(undefined), null);
    assert.equal(releaseNotesText(""), null);
    assert.equal(releaseNotesText("<p>  </p><ul></ul>"), null);
  });

  test("纯文本原样（非 HTML 的说明也不该被加工）", () => {
    assert.equal(releaseNotesText("修了几个 bug\n新增终端面板"), "修了几个 bug\n新增终端面板");
  });

  test("超长截断在预算处，末尾带省略号", () => {
    const text = releaseNotesText(`<p>${"甲".repeat(5000)}</p>`);
    assert.equal(text?.length, 4001);
    assert.equal(text?.endsWith("…"), true);
  });
});
