import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CLOSING_SCAN_HEAD, isClosingScanText, LEGACY_CLOSING_SCAN_PROMPT } from "./wrapup-scan.ts";

describe("isClosingScanText（认旧会话里的收尾扫描机器提问）", () => {
  test("v2 看首行标记、v1 认全文；用户自己提到标记或半句不算", () => {
    assert.equal(isClosingScanText(`${CLOSING_SCAN_HEAD}\n这个会话已经完成了。本次从第 3 轮看到第 9 轮。`), true);
    assert.equal(isClosingScanText(`  ${LEGACY_CLOSING_SCAN_PROMPT}\n`), true);
    assert.equal(isClosingScanText(`帮我看看 ${CLOSING_SCAN_HEAD}`), false);
    assert.equal(isClosingScanText("这个会话已经完成了。"), false);
  });
});
