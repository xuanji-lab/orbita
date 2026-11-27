import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CLOSING_SCAN_HEAD, LEGACY_CLOSING_SCAN_PROMPT, isClosingScanText } from "./legacy-closing-scan.ts";

describe("isClosingScanText", () => {
  test("v2 认首行标记，v1 认全文，普通消息不认", () => {
    assert.equal(isClosingScanText(`${CLOSING_SCAN_HEAD}\n回看这几轮……`), true);
    assert.equal(isClosingScanText(`  ${LEGACY_CLOSING_SCAN_PROMPT}\n`), true);
    assert.equal(isClosingScanText(`帮我看看 ${CLOSING_SCAN_HEAD}`), false);
    assert.equal(isClosingScanText("这个会话已经完成了。"), false);
  });
});
