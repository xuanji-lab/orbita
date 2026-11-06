import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { docPanelLayout, DOC_CHAT_MIN, DOC_PANEL_FLOOR } from "./doc-panel-width.ts";

describe("docPanelLayout —— 聊天列留底线、放不下转覆盖层", () => {
  it("宽窗口：默认 0.58 × pane，不超过 2/3", () => {
    assert.deepEqual(docPanelLayout(1200, null, 1500), { overlay: false, width: 696 });
    assert.equal(docPanelLayout(1200, 5000, 1500).width, 720);
  });

  it("聊天列永远 ≥ 480：pane 1000 时面板最多 520", () => {
    for (const pane of [900, 1000, 1100, 1200, 1400]) {
      const { overlay, width } = docPanelLayout(pane, null, pane + 330);
      if (!overlay) assert.ok(pane - width >= DOC_CHAT_MIN, `pane ${pane} 聊天列 ${pane - width}`);
    }
    assert.deepEqual(docPanelLayout(1000, null, 1330), { overlay: false, width: 520 });
  });

  it("面板先缩到下限 420，再放不下才走覆盖层", () => {
    assert.deepEqual(docPanelLayout(900, null, 1230), { overlay: false, width: DOC_PANEL_FLOOR });
    assert.equal(docPanelLayout(899, null, 1229).overlay, true);
  });

  it("覆盖层宽 = min(640, 窗口 − 48)", () => {
    assert.equal(docPanelLayout(700, null, 800).width, 640);
    assert.equal(docPanelLayout(500, null, 600).width, 552);
  });

  it("还没量到 pane：按想要的宽并排，不当覆盖层", () => {
    assert.deepEqual(docPanelLayout(0, 600, 1500), { overlay: false, width: 600 });
  });
});
