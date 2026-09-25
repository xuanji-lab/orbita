import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PROMPT_IMAGE_MAX_BYTES,
  checkPromptImage,
  isOriginalRef,
  mimeOfExtension,
  originalExtension,
  originalRefOf,
} from "./prompt-images.ts";

const SID = "01a0c4fd-9ee5-73fc-82a8-78c43b90d20d";
const FID = "5b0d1a52-8c7e-4c52-9d0b-3f6a2b1c9e10";

describe("checkPromptImage", () => {
  it("四种直发格式在上限内放行", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      assert.equal(checkPromptImage({ type, size: 1024 }), null);
    }
  });

  it("要转码的格式拒掉（HEIC / SVG / 空 type）", () => {
    assert.equal(checkPromptImage({ type: "image/heic", size: 1024 }), "unsupported");
    assert.equal(checkPromptImage({ type: "image/svg+xml", size: 1024 }), "unsupported");
    assert.equal(checkPromptImage({ type: "", size: 1024 }), "unsupported");
  });

  it("恰好等于上限放行，超一字节拒掉", () => {
    assert.equal(checkPromptImage({ type: "image/png", size: PROMPT_IMAGE_MAX_BYTES }), null);
    assert.equal(checkPromptImage({ type: "image/png", size: PROMPT_IMAGE_MAX_BYTES + 1 }), "too-large");
  });
});

describe("原图引用", () => {
  it("合法形状：<会话 id>/<uuid>.<四种扩展名之一>", () => {
    for (const ext of ["png", "jpg", "gif", "webp"]) assert.equal(isOriginalRef(`${SID}/${FID}.${ext}`), true);
  });

  it("拼进路径前的安全边界：穿越、绝对路径、多层、别的扩展名一律不认", () => {
    for (const bad of [
      `../${FID}.png`,
      `${SID}/../${FID}.png`,
      `/${SID}/${FID}.png`,
      `${SID}/${FID}.svg`,
      `${SID}/sub/${FID}.png`,
      `${SID}\\${FID}.png`,
      "",
      42,
    ]) {
      assert.equal(isOriginalRef(bad), false, String(bad));
    }
  });

  it("originalRefOf 从图块上读自挂字段，没有或不合法就是 null", () => {
    const block = { type: "image", data: "x", mimeType: "image/png" };
    assert.equal(originalRefOf(block), null);
    assert.equal(originalRefOf({ ...block, original: `${SID}/${FID}.png` }), `${SID}/${FID}.png`);
    assert.equal(originalRefOf({ ...block, original: "../etc/passwd" }), null);
  });

  it("扩展名与 MIME 互为逆映射，只认准入的四种", () => {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      const ext = originalExtension(mime);
      assert.notEqual(ext, null);
      assert.equal(mimeOfExtension(ext as string), mime);
    }
    assert.equal(originalExtension("image/heic"), null);
    assert.equal(mimeOfExtension("svg"), null);
  });
});
