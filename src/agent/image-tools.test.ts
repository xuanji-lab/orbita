/**
 * show_image 的账：多路径准入（1-6）、魔数拒非图、双通道——content 的 image 块
 * 只给视觉模型（provider 约束，read 读图同款省略口径），details.showImage 永远
 * 全量给 UI（用户的画廊不随模型视力消失）。PNG 夹具用 1×1 最小合法图。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImageTools, SHOW_IMAGE_MAX_COUNT } from "./image-tools.ts";

/** 1×1 红色 PNG（最小合法图，魔数 PNG） */
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000105ab5e30760000000049454e44ae426082",
  "hex",
);

const VISION_CTX = { model: { input: ["text", "image"] } } as never;

let dir: string;
let tool: ReturnType<typeof createImageTools>[number];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-showimg-"));
  tool = createImageTools(dir)[0]!;
  await writeFile(join(dir, "a.png"), TINY_PNG);
  await writeFile(join(dir, "b.png"), TINY_PNG);
  await writeFile(join(dir, "not-image.txt"), "just text");
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = async (paths: unknown, ctx: unknown = undefined) =>
  tool.execute("call-1", { paths }, undefined, undefined, ctx as never);

describe("show_image", () => {
  test("视觉模型：content = 说明 + 每图一 image 块（一跳两得）；details 恒带画廊", async () => {
    const result = await run(["a.png", "b.png"], VISION_CTX);
    assert.equal(result.content.length, 3);
    assert.equal(result.content[0]!.type, "text");
    assert.equal(result.content[1]!.type, "image");
    const details = (result.details as Record<string, unknown>)["showImage"] as {
      images: { name: string }[];
    };
    assert.deepEqual(
      details.images.map((img) => img.name),
      ["a.png", "b.png"],
    );
  });

  test("非视觉模型：content 只有 text（provider 不吃 image 块），details 画廊照常", async () => {
    const result = await run(["a.png"]);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0]!.type, "text");
    assert.ok(
      typeof result.content[0]!.text === "string" && result.content[0]!.text.includes("does not support images"),
    );
    const details = (result.details as Record<string, unknown>)["showImage"] as { images: unknown[] };
    assert.equal(details.images.length, 1);
  });

  test("上限：0 张与超过 6 张都报错带数量", async () => {
    await assert.rejects(run([]), /requires "paths"/);
    const many = Array.from({ length: SHOW_IMAGE_MAX_COUNT + 1 }, (_, i) => `${i}.png`);
    await assert.rejects(run(many), new RegExp(`At most ${SHOW_IMAGE_MAX_COUNT}`));
  });

  test("魔数拒非图（扩展名会说谎，文件头不会）", async () => {
    await assert.rejects(run(["not-image.txt"]), /not a supported image/);
  });

  test("文件不存在：ENOENT 原始错误穿透", async () => {
    await assert.rejects(run(["missing.png"]), /ENOENT/);
  });
});
