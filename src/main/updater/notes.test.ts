/**
 * 更新说明解析的测试（updater/notes.ts）。
 *
 * 输入是 GitHub 给的真实形状：Release 正文渲染出来的 HTML（段落、列表、行内加粗），
 * 实体会被 atom feed 转义；发布约定是每行一条 + 行首可选 `[icon:名字]`。
 * 钉正常路径与四个边界：无前缀、未知图标名、只有前缀的空条目、超长截断。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import packageJson from "../../../package.json" with { type: "json" };
import { appNotesOf, parseReleaseNotes } from "./notes.ts";

/** 本版发布正文的三条（发布约定写法的样子） */
const BODY = [
  "[icon:download] Windows auto-update: checks in the background, downloads only after you confirm.",
  "[icon:square-terminal] Terminal panel: faster redraw on large output.",
  "[icon:message-square] Fixed: composer chip alignment in narrow windows.",
].join("\n");

describe("parseReleaseNotes —— 结构与图标前缀", () => {
  test("三条带前缀的说明：图标名与正文各自归位", () => {
    assert.deepEqual(parseReleaseNotes(BODY), [
      {
        icon: "download",
        text: "Windows auto-update: checks in the background, downloads only after you confirm.",
      },
      { icon: "square-terminal", text: "Terminal panel: faster redraw on large output." },
      { icon: "message-square", text: "Fixed: composer chip alignment in narrow windows." },
    ]);
  });

  test("无前缀的行就是没有图标（icon 为 null），不是解析失败", () => {
    assert.deepEqual(parseReleaseNotes("修了几个 bug\n新增终端面板"), [
      { icon: null, text: "修了几个 bug" },
      { icon: null, text: "新增终端面板" },
    ]);
  });

  test("混合行：有前缀与无前缀各归各的", () => {
    assert.deepEqual(parseReleaseNotes("[icon:download] 一条\n普通一条\n[icon:zap] 又一条"), [
      { icon: "download", text: "一条" },
      { icon: null, text: "普通一条" },
      { icon: "zap", text: "又一条" },
    ]);
  });

  test("未知图标名原样带给 renderer（白名单在 Icon.tsx，取值时兜底成没图标）", () => {
    assert.deepEqual(parseReleaseNotes("[icon:not-a-real-icon] 一条"), [
      { icon: "not-a-real-icon", text: "一条" },
    ]);
  });

  test("前缀写得不合法（大写 / 空格 / 冒号写成全角）就是普通正文", () => {
    assert.deepEqual(
      parseReleaseNotes(["[icon:Download] 一条", "[icon:下载] 一条", "[icon：zap] 一条", "[icon:] 一条"].map((line) => line).join("\n")),
      [
        { icon: null, text: "[icon:Download] 一条" },
        { icon: null, text: "[icon:下载] 一条" },
        { icon: null, text: "[icon：zap] 一条" },
        { icon: null, text: "[icon:] 一条" },
      ],
    );
  });

  test("markdown 列表写的条目也认：行首记号先剥掉再看前缀", () => {
    assert.deepEqual(parseReleaseNotes("<ul><li>[icon:download] 一条</li><li>- [icon:zap] 两条</li></ul>"), [
      { icon: "download", text: "一条" },
      { icon: "zap", text: "两条" },
    ]);
  });
});

describe("parseReleaseNotes —— HTML 正文与边界", () => {
  test("HTML 段落与列表变成逐条，行内标签剥掉", () => {
    const html =
      '<p>本地优先的桌面 AI Agent。</p><h2>一、Agent 与对话</h2>' +
      "<ul><li><strong>独立进程的 agent</strong>：工具输出再大也不和界面抢事件循环。</li>" +
      "<li>两件事<br>第二行</li></ul>";
    assert.deepEqual(parseReleaseNotes(html), [
      { icon: null, text: "本地优先的桌面 AI Agent。" },
      { icon: null, text: "一、Agent 与对话" },
      { icon: null, text: "独立进程的 agent：工具输出再大也不和界面抢事件循环。" },
      { icon: null, text: "两件事" },
      { icon: null, text: "第二行" },
    ]);
  });

  test("实体解回可读字符（含 &amp; 不在别的实体之前解）", () => {
    assert.deepEqual(parseReleaseNotes("<p>a &amp; b &quot;c&quot; &lt;tag&gt;</p>"), [
      { icon: null, text: 'a & b "c" <tag>' },
    ]);
    assert.deepEqual(parseReleaseNotes("<p>&amp;lt;p&amp;gt;</p>"), [{ icon: null, text: "&lt;p&gt;" }]);
    assert.deepEqual(parseReleaseNotes("<p>换行&nbsp;不换行</p>"), [{ icon: null, text: "换行 不换行" }]);
  });

  test("空行与空内容：跳过空行，整份空就是 null（界面据此不画展开器）", () => {
    assert.deepEqual(parseReleaseNotes("第一条\n\n\n第二条"), [
      { icon: null, text: "第一条" },
      { icon: null, text: "第二条" },
    ]);
    assert.equal(parseReleaseNotes(null), null);
    assert.equal(parseReleaseNotes(undefined), null);
    assert.equal(parseReleaseNotes(""), null);
    assert.equal(parseReleaseNotes("<p>  </p><ul></ul>"), null);
  });

  test("只有前缀没有正文的条目被丢掉（不渲染一个空条目）", () => {
    assert.deepEqual(parseReleaseNotes("[icon:download] \n[icon:zap]\n有正文"), [{ icon: null, text: "有正文" }]);
  });

  test("超长截断在总量预算处，末尾带省略号；预算用完就不再收后面的条目", () => {
    const notes = parseReleaseNotes(`第一条${"甲".repeat(5000)}\n第二条`);
    assert.equal(notes?.length, 1);
    assert.equal(notes?.[0]?.text.length, 4001);
    assert.equal(notes?.[0]?.text.endsWith("…"), true);
    // 剩下的预算贴在超长的那一条上，预算用完之后的条目整条不出现（不半条半条地画）
    const rest = parseReleaseNotes(`甲\n${"乙".repeat(5000)}\n丙`);
    assert.equal(rest?.length, 2);
    assert.equal(rest?.[1]?.text.length, 4000);
    assert.equal(rest?.[1]?.text.endsWith("…"), true);
  });
});

describe("appNotesOf —— 软件里只认 latest.yml 的纯文本", () => {
  test("纯文本：按发布约定逐条解析", () => {
    assert.deepEqual(appNotesOf("[icon:download] Windows 自动更新。\n修了对齐问题。"), [
      { icon: "download", text: "Windows 自动更新。" },
      { icon: null, text: "修了对齐问题。" },
    ]);
  });
  test("带 HTML 标签 = electron-updater 退回去拿了 Release 页正文：不进软件", () => {
    assert.equal(appNotesOf("<h1>ORBITA v0.1.15 · 功能总览</h1><p>本地优先的桌面 AI Agent</p>"), null);
  });
  test("纯文本里的比较号不是标签，照常显示", () => {
    assert.deepEqual(appNotesOf("启动 < 1 秒"), [{ icon: null, text: "启动 < 1 秒" }]);
  });
  test("不是字符串（没写 / fullChangelog 数组）：null", () => {
    assert.equal(appNotesOf(undefined), null);
    assert.equal(appNotesOf(null), null);
    assert.equal(appNotesOf([{ version: "0.1.15", note: "<p>x</p>" }]), null);
  });
});

/**
 * 发版兜底：这一版给普通用户看的说明（package.json 的 build.releaseInfo.releaseNotes，打包时写进
 * latest.yml）必须写了、每行都带图标、图标真的登记在 Icon.tsx 里。写错图标名不会崩，但那一条
 * 会没有图标——发版前在这里报红，比装到用户机器上才发现好。
 */
describe("发版：package.json 里的应用内更新说明", () => {
  const notes = appNotesOf(packageJson.build.releaseInfo.releaseNotes) ?? [];
  const iconSource = readFileSync(new URL("../../renderer/src/shell/Icon.tsx", import.meta.url), "utf8");

  test("写了，且是纯文本（不是从 Release 页抄来的 markdown / HTML）", () => {
    assert.ok(notes.length > 0, "build.releaseInfo.releaseNotes 为空：软件里这一版会没有说明");
    for (const note of notes) assert.doesNotMatch(note.text, /^#|\*\*|^\|/, `像是 markdown：${note.text}`);
  });

  test("每一条都带 [icon:名字]，且图标已在 Icon.tsx 登记（有 svg、有 import）", () => {
    for (const note of notes) {
      assert.ok(note.icon !== null, `这一条没写图标：${note.text}`);
      const svg = new URL(`../../../design-system/assets/icons/lucide/${note.icon}.svg`, import.meta.url);
      assert.ok(existsSync(svg), `design-system 里没有 ${note.icon}.svg`);
      assert.ok(iconSource.includes(`lucide/${note.icon}.svg?raw`), `Icon.tsx 没有登记 ${note.icon}`);
    }
  });
});
