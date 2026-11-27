import assert from "node:assert/strict";
import test from "node:test";
import { boardFullPage, boardShotPixels, boardShotSizeMatches, boardShotViewport, luminanceDeviation, type BoardShotImage } from "./board-shot-image.ts";

function solid(red: number, green: number, blue: number): Uint8Array {
  const data = new Uint8Array(4 * 16 * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = blue;
    data[i + 1] = green;
    data[i + 2] = red;
    data[i + 3] = 255;
  }
  return data;
}

test("全黑 / 全白的空白候选标准差都是 0", () => {
  assert.equal(luminanceDeviation(solid(0, 0, 0)), 0);
  assert.equal(luminanceDeviation(solid(255, 255, 255)), 0);
  assert.equal(luminanceDeviation(new Uint8Array()), 0);
});

test("明暗两块的图有内容，不能被空白阈值误杀", () => {
  const data = solid(0, 0, 0);
  for (let i = 0; i < data.length / 2; i += 4) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
  }
  assert.ok(luminanceDeviation(data) > 100);
});

test("CDP 视口只接受有限的正宽高；形状不对、零值、负值都拒绝", () => {
  assert.deepEqual(boardShotViewport({ clientWidth: 1440, clientHeight: 900 }), { width: 1440, height: 900 });
  for (const raw of [null, undefined, "x", [], {}, { clientWidth: 0, clientHeight: 900 }, { clientWidth: 1440, clientHeight: -1 }, { clientWidth: Number.NaN, clientHeight: 900 }, { clientWidth: "1440", clientHeight: 900 }]) {
    assert.equal(boardShotViewport(raw), null);
  }
});

test("原生取帧与裁图尺寸必须完整；亚像素取整容差内通过，局部图拒绝", () => {
  assert.equal(boardShotSizeMatches({ width: 1250, height: 900 }, { width: 1250, height: 900 }), true);
  assert.equal(boardShotSizeMatches({ width: 1251, height: 899 }, { width: 1250, height: 900 }), true);
  assert.equal(boardShotSizeMatches({ width: 1112, height: 496 }, { width: 1250, height: 900 }), false);
  assert.equal(boardShotSizeMatches({ width: 2882, height: 1800 }, { width: 2880, height: 1800 }, 2), true);
  assert.equal(boardShotSizeMatches({ width: 2883, height: 1800 }, { width: 2880, height: 1800 }, 2), false);
});

/** 假的整窗帧：每个像素按坐标给不同亮度（有内容），可选成全黑（还没画好）；crop 照 nativeImage 截到边为止 */
function fakePage(width: number, height: number, blank = false): BoardShotImage & { crops: number } {
  const page = {
    crops: 0,
    isEmpty: () => width === 0 || height === 0,
    getSize: () => ({ width, height }),
    crop(rect: { x: number; y: number; width: number; height: number }): BoardShotImage {
      page.crops += 1;
      const w = Math.max(0, Math.min(rect.width, width - rect.x));
      const h = Math.max(0, Math.min(rect.height, height - rect.y));
      const data = new Uint8Array(w * h * 4);
      for (let i = 0; i < data.length; i += 4) {
        const value = blank ? 0 : ((i / 4) * 37) % 256;
        data[i] = value;
        data[i + 1] = value;
        data[i + 2] = value;
        data[i + 3] = 255;
      }
      return { isEmpty: () => w === 0 || h === 0, getSize: () => ({ width: w, height: h }), crop: () => { throw new Error("not used"); }, toBitmap: () => data };
    },
    toBitmap: () => new Uint8Array(width * height * 4),
  };
  return page;
}

test("原生整窗帧尺寸对得上就用它，不碰 CDP 兜底", async () => {
  let fallbacks = 0;
  const native = fakePage(2880, 1680);
  const full = await boardFullPage({ native: async () => native, fallback: async () => { fallbacks += 1; return null; } }, { width: 2880, height: 1680 });
  assert.equal(full?.via, "native");
  assert.equal(fallbacks, 0);
});

test("原生抛错 / 空图 / 半尺寸都丢掉走 CDP；两条都不行回 null", async () => {
  const cdpPage = fakePage(2880, 1680);
  const natives: Array<() => Promise<BoardShotImage>> = [
    async () => { throw new Error("capturePage failed"); },
    async () => fakePage(0, 0),
    async () => fakePage(1440, 840),
  ];
  for (const native of natives) {
    const full = await boardFullPage({ native, fallback: async () => cdpPage }, { width: 2880, height: 1680 });
    assert.equal(full?.via, "cdp");
    assert.equal(full?.page, cdpPage);
  }
  assert.equal(await boardFullPage({ native: natives[0]!, fallback: async () => null }, { width: 2880, height: 1680 }), null);
});

test("裁图按 DPR 换成物理像素，回完整的 BGRA 原始像素", () => {
  const out = boardShotPixels(fakePage(2880, 1680), { x: 312, y: 92, width: 625, height: 420 }, 2);
  assert.equal(out?.width, 1250);
  assert.equal(out?.height, 840);
  assert.equal(out?.pixels.byteLength, 1250 * 840 * 4);
});

test("回退来的帧比视口小（裁出来是局部）或还没画好（一片空白）都回 null，局部图绝不进缓存", () => {
  assert.equal(boardShotPixels(fakePage(1440, 840), { x: 312, y: 92, width: 625, height: 420 }, 2), null);
  assert.equal(boardShotPixels(fakePage(2880, 1680, true), { x: 312, y: 92, width: 625, height: 420 }, 2), null);
});
