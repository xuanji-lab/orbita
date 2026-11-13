import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DOC_CHAT_ABS_MIN, docOverlayWidth, docPanelLayout, DOC_INPUT_MIN, DOC_PANEL_SQUEEZE, DOC_CHAT_HARD_MIN, DOC_CHAT_MIN, DOC_PANEL_FLOOR } from "./doc-panel-width.ts";

describe("docPanelLayout —— 聊天列留底线、放不下转覆盖层", () => {
  it("宽窗口：默认 0.58 × pane，不超过 2/3", () => {
    assert.deepEqual(docPanelLayout(1200, null, 1500), { overlay: false, width: 696 });
    assert.equal(docPanelLayout(1200, 5000, 1500).width, 720);
  });

  it("聊天列首选 ≥ 480；面板到下限后聊天列可让到硬底线 410，不再低", () => {
    assert.deepEqual(docPanelLayout(1000, null, 1330), { overlay: false, width: 520, squeezed: true });
    for (const pane of [830, 880, 900, 1000, 1100, 1200, 1400]) {
      const { overlay, width } = docPanelLayout(pane, null, pane + 330);
      assert.equal(overlay, false, `pane ${pane}`);
      assert.ok(pane - width >= DOC_CHAT_HARD_MIN, `pane ${pane} 聊天列 ${pane - width}`);
      if (pane >= DOC_CHAT_MIN + DOC_PANEL_FLOOR) assert.ok(pane - width >= DOC_CHAT_MIN);
    }
  });

  it("面板先缩到下限 420，再挤窄到 300（聊天列守硬底线 410），再放不下才走覆盖层", () => {
    assert.deepEqual(docPanelLayout(830, null, 1160), { overlay: false, width: DOC_PANEL_FLOOR, squeezed: true });
    assert.deepEqual(docPanelLayout(760, null, 1090), { overlay: false, width: 350, tight: true });
    assert.deepEqual(docPanelLayout(710, null, 800), { overlay: false, width: DOC_PANEL_SQUEEZE, tight: true });
    for (const pane of [710, 730, 760, 829]) {
      const l = docPanelLayout(pane, null, pane + 90);
      assert.ok(pane - l.width >= DOC_CHAT_HARD_MIN, `pane ${pane} 聊天列 ${pane - l.width}`);
    }
  });

  it("窗口 720–780（pane 约 640–700）：不再覆盖层，面板 300 + 聊天列 ≥ 330，发送键不被盖（S3）", () => {
    for (const pane of [630, 640, 670, 700, 709]) {
      const l = docPanelLayout(pane, null, pane + 80);
      assert.equal(l.overlay, false, `pane ${pane}`);
      assert.equal(l.width, DOC_PANEL_SQUEEZE);
      assert.ok(pane - l.width >= DOC_CHAT_ABS_MIN, `pane ${pane} 聊天列 ${pane - l.width}`);
    }
    assert.equal(docPanelLayout(629, null, 700).overlay, true, "再窄才覆盖层");
  });

  it("覆盖层宽 = min(640, 窗口 − 输入框最小可用宽 410 − 边距 56)，输入框必须露出来", () => {
    assert.equal(docOverlayWidth(1400), 640);
    assert.equal(docOverlayWidth(1000), 534);
    assert.equal(docOverlayWidth(900), 434);
    assert.equal(docOverlayWidth(800), 334);
    assert.equal(docOverlayWidth(600), 300, "再窄也不低于下限");
    assert.equal(docPanelLayout(650, null, 740).width, docOverlayWidth(740));
    for (const w of [800, 900, 1000]) assert.ok(w - docOverlayWidth(w) >= DOC_INPUT_MIN, `窗口 ${w} 左边露出 ${w - docOverlayWidth(w)}`);
  });

  it("同一窗口宽度忽大忽小（侧栏展开 420 / 收起 650）：被聊天列压低的会标 squeezed，让 App 先收侧栏", () => {
    // 1200 窗口：侧栏展开 pane≈832 → 想要 482、只给 420；侧栏收起 pane≈1132 → 652（想要 657，差 5 是舍入，不算被压）
    assert.equal(docPanelLayout(832, null, 1200).squeezed, true);
    assert.equal(docPanelLayout(832, null, 1200).width, 420);
    assert.equal(docPanelLayout(1132, null, 1200).squeezed, undefined);
    assert.equal(docPanelLayout(1132, null, 1200).width, 652);
    // 用户存过 650 的宽度：侧栏展开时也算被压
    assert.equal(docPanelLayout(832, 650, 1200).squeezed, true);
    // 宽窗口、想要的给得下：不标
    assert.equal(docPanelLayout(1400, null, 1700).squeezed, undefined);
  });

  it("还没量到 pane：按想要的宽并排，不当覆盖层", () => {
    assert.deepEqual(docPanelLayout(0, 600, 1500), { overlay: false, width: 600 });
  });
});
