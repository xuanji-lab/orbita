import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_ICON_PNG_MAX_BYTES } from "../../shared/app-icon.ts";
import { AppIconStore, validateAppIconPng } from "./store.ts";

/** 造一段只有签名 + IHDR 头部的假 PNG（校验只看这 24 字节） */
function fakePng(width: number, height: number, extra = 0): Uint8Array {
  const bytes = new Uint8Array(24 + extra);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe("validateAppIconPng", () => {
  test("512×512 的 PNG 通过", () => {
    assert.equal(validateAppIconPng(fakePng(512, 512, 100)), null);
  });

  test("非字节数组、空、过大、太短一律拒绝", () => {
    assert.ok(validateAppIconPng("png") !== null);
    assert.ok(validateAppIconPng(new Uint8Array(0)) !== null);
    assert.ok(validateAppIconPng(new Uint8Array(10)) !== null);
    assert.ok(validateAppIconPng(fakePng(512, 512, APP_ICON_PNG_MAX_BYTES)) !== null);
  });

  test("签名不对、缺 IHDR、尺寸不是 512 都拒绝", () => {
    const badSignature = fakePng(512, 512);
    badSignature[1] = 0;
    assert.ok(validateAppIconPng(badSignature)?.includes("签名") === true);
    const noHeader = fakePng(512, 512);
    noHeader[12] = 0;
    assert.ok(validateAppIconPng(noHeader)?.includes("IHDR") === true);
    assert.ok(validateAppIconPng(fakePng(256, 256))?.includes("256×256") === true);
    assert.ok(validateAppIconPng(fakePng(512, 511)) !== null);
  });

  test("Node 的 Buffer（Uint8Array 子类）也认", () => {
    assert.equal(validateAppIconPng(Buffer.from(fakePng(512, 512))), null);
  });
});

describe("AppIconStore", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "orbita-app-icon-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("写进去能原样读回，不留临时文件；后写覆盖先写", async () => {
    const store = new AppIconStore(dir);
    const first = fakePng(512, 512, 8);
    const second = fakePng(512, 512, 16);
    await store.write(first);
    assert.deepEqual(await store.read(), first);
    await store.write(second);
    assert.deepEqual(await store.read(), second);
    assert.deepEqual(await readdir(dir), ["app-icon.png"]);
  });

  test("没有缓存 / 缓存损坏都回 null（停在打包默认图标上，不报错）", async () => {
    const store = new AppIconStore(dir);
    assert.equal(await store.read(), null);
    await writeFile(join(dir, "app-icon.png"), "not a png at all, definitely");
    assert.equal(await store.read(), null);
  });
});
