import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { preparePromptImages, type ResizeImage } from "./prompt-images.ts";

const png = { type: "image" as const, data: Buffer.from("raw").toString("base64"), mimeType: "image/png" };

/** 假缩放：记下收到的字节，吐一张固定的 jpeg */
function fakeResize(seen: string[]): ResizeImage {
  return async (bytes, mimeType) => {
    seen.push(`${mimeType}:${Buffer.from(bytes).toString()}`);
    return {
      data: "c21hbGw=",
      mimeType: "image/jpeg",
      originalWidth: 4000,
      originalHeight: 3000,
      width: 2000,
      height: 1500,
      wasResized: true,
    };
  };
}

describe("preparePromptImages", () => {
  it("缺席与空数组都是纯文本，不调缩放", async () => {
    const seen: string[] = [];
    assert.deepEqual(await preparePromptImages(undefined, fakeResize(seen)), []);
    assert.deepEqual(await preparePromptImages([], fakeResize(seen)), []);
    assert.deepEqual(seen, []);
  });

  it("逐张解 base64 交给缩放，产出取缩放后的数据与格式", async () => {
    const seen: string[] = [];
    const out = await preparePromptImages([png, { ...png, mimeType: "image/webp" }], fakeResize(seen));
    assert.deepEqual(seen, ["image/png:raw", "image/webp:raw"]);
    assert.deepEqual(out, [
      { type: "image", data: "c21hbGw=", mimeType: "image/jpeg" },
      { type: "image", data: "c21hbGw=", mimeType: "image/jpeg" },
    ]);
  });

  it("不支持的格式整条拒掉，并说出是第几张", async () => {
    await assert.rejects(
      preparePromptImages([png, { ...png, mimeType: "image/heic" }], fakeResize([])),
      /第 2 张图片.*image\/heic/,
    );
  });

  it("缩不下来（解码失败）整条拒掉，不静默丢图", async () => {
    await assert.rejects(preparePromptImages([png], async () => null), /第 1 张图片/);
  });
});
