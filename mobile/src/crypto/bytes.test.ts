import { test } from "node:test";
import assert from "node:assert/strict";
import { fromBase64, fromUtf8, secretEqual, toBase64, utf8 } from "./bytes.ts";

test("base64：与 Node 的编码逐字一致；只认规范形", () => {
  for (let length = 0; length < 70; length += 1) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 0xff);
    const expected = Buffer.from(bytes).toString("base64");
    assert.equal(toBase64(bytes), expected);
    assert.deepEqual(fromBase64(expected), bytes);
  }
  // 末位冗余位不为 0（"QR==" 与 "QQ==" 解出同一个字节）：非规范形，拒
  assert.equal(fromBase64("QR=="), null);
  assert.deepEqual(fromBase64("QQ=="), Uint8Array.from([0x41]));
  for (const bad of ["QQ", "Q===", "QQ==QQ==", "QQ =", "QQ-_", "=QQQ"]) assert.equal(fromBase64(bad), null, bad);
});

test("UTF-8 严格解码；常数时间比对长度不同算不等", () => {
  assert.equal(fromUtf8(utf8("璇玑 orbita")), "璇玑 orbita");
  assert.equal(fromUtf8(Uint8Array.from([0xff, 0xfe])), null);
  assert.equal(secretEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 2])), true);
  assert.equal(secretEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 3])), false);
  assert.equal(secretEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 2, 3])), false);
});
