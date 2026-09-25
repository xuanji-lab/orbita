import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PROMPT_IMAGE_MAX_BYTES, checkPromptImage } from "./prompt-images.ts";

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
