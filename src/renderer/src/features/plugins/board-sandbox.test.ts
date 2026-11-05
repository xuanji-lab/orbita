import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { CARD_IFRAME_SANDBOX } from "./board-card.ts";

/**
 * 每张卡一只沙箱 iframe：沙箱属性与消息来源校验在这里钉；响应头 CSP 在 main/plugin/panel-frame.test.ts 钉（所有卡走同一个协议与同一份 CSP）。
 * 真实的五种攻击（模板联网、外链图片、跳顶层、弹窗、读宿主）在真实例里用恶意模板验过（见 PR 描述）；
 * 这里把静态能验的钉住：属性、CSP、以及 BoardGrid 里的 iframe 只有这一处、没有别的放行。
 */
const source = readFileSync(new URL("./BoardGrid.tsx", import.meta.url), "utf8");

describe("卡片 iframe 的沙箱", () => {
  test("sandbox 只有 allow-scripts：不给同源 / 顶层导航 / 弹窗 / 表单 / 模态 / 下载", () => {
    assert.equal(CARD_IFRAME_SANDBOX, "allow-scripts");
    for (const forbidden of ["allow-same-origin", "allow-top-navigation", "allow-popups", "allow-forms", "allow-modals", "allow-downloads"]) {
      assert.ok(!CARD_IFRAME_SANDBOX.includes(forbidden), forbidden);
    }
  });

  test("BoardGrid 里只有一处 <iframe>，sandbox 取自那个常量，没有别的 allow-* 字面量，allow 属性为空", () => {
    assert.equal((source.match(/<iframe/g) ?? []).length, 1);
    assert.match(source, /sandbox=\{CARD_IFRAME_SANDBOX\}/);
    assert.match(source, /allow=""/);
    assert.match(source, /referrerPolicy="no-referrer"/);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.equal(/allow-[a-z-]+/.test(code), false, "代码里不应出现 allow-* 字面量（注释除外）");
  });

  test("收消息只认这只 iframe 的 contentWindow 且来源是 \"null\"；往里发只用 targetOrigin \"*\"", () => {
    assert.match(source, /event\.source !== target \|\| event\.origin !== "null"/);
    assert.match(source, /target\.postMessage\(message, "\*"\)/);
  });
});
