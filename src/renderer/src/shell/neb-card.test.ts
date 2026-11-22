import { deepStrictEqual, equal } from "node:assert/strict";
import { describe, it } from "node:test";
import { nebCardSpot, sameNebCardSpot } from "./neb-card.ts";

describe("nebCardSpot —— 星云卡片的落位几何", () => {
  it("宽视口：卡居中于云心，底边钉在云顶上方 8px，maxHeight 是云顶余量减 24", () => {
    deepStrictEqual(nebCardSpot({ left: 400, width: 80, top: 300 }, { width: 1400, height: 900 }), {
      left: 260, // 云心 440 − 卡宽一半 180
      bottom: 608, // 900 − 300 + 8
      maxHeight: 276, // 300 − 24
      tailX: 180, // 440 − 260
    });
  });

  it("云在最左：卡夹回左缘 8px，尾巴跟着收紧但不小于 14", () => {
    const spot = nebCardSpot({ left: 0, width: 80, top: 300 }, { width: 1400, height: 900 });
    equal(spot.left, 8);
    equal(spot.tailX, 32); // 云心 40 − 8
  });

  it("云在最右：卡夹回右缘（视口宽 − 卡宽 − 8），尾巴跟着云心、仍落在卡内", () => {
    const spot = nebCardSpot({ left: 410, width: 80, top: 300 }, { width: 500, height: 900 });
    equal(spot.left, 132); // min(round(450−180)=270, 500−360−8=132)
    equal(spot.tailX, 318); // 450 − 132
  });

  it("云心远过卡右内缘：尾巴钳在卡宽 − 14", () => {
    const spot = nebCardSpot({ left: 440, width: 80, top: 300 }, { width: 500, height: 900 });
    equal(spot.left, 132);
    equal(spot.tailX, 346); // round(480−132)=348 → 钳到 360−14
  });

  it("窄视口：卡宽收到视口 − 16，两端各留 8", () => {
    const spot = nebCardSpot({ left: 40, width: 80, top: 300 }, { width: 200, height: 900 });
    equal(spot.left, 8); // max(8, min(round(80−92)=−12, 200−184−8=8))
    equal(spot.tailX, 72); // 云心 80 − 8，未触 [14, 170] 的边
  });

  it("云贴着视口顶：bottom 不小于 8，maxHeight 兜底 120", () => {
    const spot = nebCardSpot({ left: 400, width: 80, top: 0 }, { width: 1400, height: 900 });
    equal(spot.bottom, 908); // 900 − 0 + 8
    equal(spot.maxHeight, 120); // max(120, −24)
  });
});

describe("sameNebCardSpot —— 落位相等判断", () => {
  it("四个数全同才相等；任一不同即不等", () => {
    const a = nebCardSpot({ left: 400, width: 80, top: 300 }, { width: 1400, height: 900 });
    equal(sameNebCardSpot(a, { ...a }), true);
    equal(sameNebCardSpot(a, { ...a, tailX: a.tailX + 1 }), false);
    equal(sameNebCardSpot(a, { ...a, maxHeight: a.maxHeight + 1 }), false);
  });
});
