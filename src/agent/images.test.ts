import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";
import { createCanvas } from "@napi-rs/canvas";
import { imageProcessor, normalizeToolResultImages, resizePromptImage } from "./images.ts";

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

/** 合成图：kind = photo（渐变 + 噪声，照片类）/ flat（平涂色块 + 文字，截图类）/ alpha（渐变 + 半透明） */
async function synth(kind: "photo" | "flat" | "alpha", width = 2400, height = 1600): Promise<Buffer> {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (kind === "flat") {
    ctx.fillStyle = "#f4f4f2";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#2b6cb0";
    ctx.fillRect(100, 100, 900, 400);
    ctx.fillStyle = "#222";
    ctx.font = "48px sans-serif";
    ctx.fillText("flat screenshot text", 120, 700);
  } else {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#ff7a18");
    gradient.addColorStop(0.5, "#1b8ec2");
    gradient.addColorStop(1, "#2d1e5f");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    // 确定性噪点：伪随机，模拟照片的高频细节
    let seed = 12345;
    for (let i = 0; i < 40000; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      ctx.fillStyle = `rgba(${seed % 256},${(seed >> 8) % 256},${(seed >> 16) % 256},${kind === "alpha" ? 0.5 : 1})`;
      ctx.fillRect(seed % width, (seed >> 11) % height, 6, 6);
    }
    if (kind === "alpha") ctx.clearRect(0, 0, 300, 300);
  }
  return canvas.encode("png");
}

describe("images：缩完后 PNG 与 JPEG 取小的", () => {
  const run = async (kind: "photo" | "flat" | "alpha") => {
    const bytes = await synth(kind);
    const out = await resizePromptImage(bytes, "image/png");
    assert.ok(out !== null);
    const size = Buffer.from(out.data, "base64").byteLength;
    console.log(`[图片体积] ${kind}: 输入 PNG ${bytes.byteLength} B → ${out.mimeType} ${size} B`);
    return { out, size, inputSize: bytes.byteLength };
  };

  it("照片类：缩到上限后选 JPEG，体积回到几百 KB 量级", async () => {
    const { out, size } = await run("photo");
    assert.equal(out.mimeType, "image/jpeg");
    assert.ok(size < 600 * 1024, `JPEG 应在几百 KB，实得 ${size}`);
  });

  it("截图类平涂：保持 PNG，不比处理器原本给的大", async () => {
    const { out } = await run("flat");
    assert.equal(out.mimeType, "image/png");
  });

  it("带透明通道：只能 PNG", async () => {
    const { out } = await run("alpha");
    assert.equal(out.mimeType, "image/png");
  });

  it("在上限内、没被重编码的图原样放行", async () => {
    const bytes = await synth("photo", 800, 600);
    const prepared = await imageProcessor.prepare(bytes, "image/png", { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592 });
    assert.ok(prepared !== undefined);
    assert.equal(prepared.mimeType, "image/png");
    assert.equal(prepared.data, bytes.toString("base64"));
  });

  it("工具结果里的图（read 读图同一处理器）也走这条路，并带「从 PNG 转成 JPEG」的说明", async () => {
    const bytes = await synth("photo");
    const out = await normalizeToolResultImages([{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }], { autoResizeImages: true });
    assert.deepEqual(out[0]?.type, "image");
    assert.equal(out[0]?.type === "image" ? out[0].mimeType : "", "image/jpeg");
    const note = out[1]?.type === "text" ? out[1].text : "";
    assert.match(note, /Converted from image\/png to image\/jpeg/);
    assert.match(note, /Resized from 2400x1600 to 2000x1333/);
  });
});
