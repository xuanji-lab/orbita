import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";
import { normalizeToolResultImages, resizePromptImage } from "./images.ts";

const png = { type: "image" as const, data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" };

describe("images：工具结果里的图", () => {
  it("缩过的图换成新的那份，后面接一行坐标换算说明；文字块原样", async () => {
    const seen: number[] = [];
    const processor: ImageProcessor = {
      async prepare(_bytes, _mime, limits) {
        seen.push(limits.maxWidth);
        return { data: "c21hbGw=", mimeType: "image/jpeg", resized: { from: { width: 3000, height: 2000 }, to: { width: 1500, height: 1000 } } };
      },
    };
    const out = await normalizeToolResultImages([{ type: "text", text: "前" }, png], { autoResizeImages: true, limits: { maxWidth: 1568 }, processor });
    assert.deepEqual(out[0], { type: "text", text: "前" });
    assert.deepEqual(out[1], { type: "image", data: "c21hbGw=", mimeType: "image/jpeg" });
    assert.deepEqual(out[2], { type: "text", text: "[Image: Resized from 3000x2000 to 1500x1000. Multiply coordinates by 2.00 to map them to the original.]" });
    assert.deepEqual(seen, [1568], "模型的上限盖在默认上限上");
  });

  it("关了自动缩放只转格式；处理失败或抛错保留原图；没有图原样返回", async () => {
    const limitsSeen: number[] = [];
    const failing: ImageProcessor = {
      async prepare(_bytes, _mime, limits) {
        limitsSeen.push(limits.maxBytes);
        return undefined;
      },
    };
    assert.deepEqual(await normalizeToolResultImages([png], { autoResizeImages: false, processor: failing }), [png]);
    assert.equal(limitsSeen[0], Number.MAX_SAFE_INTEGER, "不缩：上限放到最大");
    const throwing: ImageProcessor = {
      async prepare() {
        throw new Error("wasm 坏了");
      },
    };
    assert.deepEqual(await normalizeToolResultImages([png], { autoResizeImages: true, processor: throwing }), [png]);
    const text = [{ type: "text" as const, text: "只有字" }];
    assert.deepEqual(await normalizeToolResultImages(text, { autoResizeImages: true, processor: throwing }), text);
  });

  it("用户发的图：解不开给 null", async () => {
    const none: ImageProcessor = { prepare: async () => undefined };
    assert.equal(await resizePromptImage(new Uint8Array([1]), "image/png", none), null);
  });
});
