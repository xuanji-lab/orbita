import { describe, it } from "node:test";
import { deepStrictEqual } from "node:assert";
import { nextFilterRowMode } from "./filter-row-compact.ts";

describe("nextFilterRowMode —— 筛选行完整 / 紧凑的判定", () => {
  it("没量过自然宽度时保持完整态，先量再说", () => {
    deepStrictEqual(
      nextFilterRowMode({ compact: false, fullWidth: null, containerWidth: 200, contentWidth: 0 }),
      { compact: false, fullWidth: 0 },
    );
  });

  it("完整态放得下：记住自然宽度，仍完整", () => {
    deepStrictEqual(
      nextFilterRowMode({ compact: false, fullWidth: null, containerWidth: 320, contentWidth: 300 }),
      { compact: false, fullWidth: 300 },
    );
  });

  it("完整态放不下：切紧凑", () => {
    deepStrictEqual(
      nextFilterRowMode({ compact: false, fullWidth: null, containerWidth: 260, contentWidth: 300 }),
      { compact: true, fullWidth: 300 },
    );
  });

  it("紧凑态不拿缩小后的 contentWidth 更新自然宽度——否则会来回抖", () => {
    deepStrictEqual(
      nextFilterRowMode({ compact: true, fullWidth: 300, containerWidth: 260, contentWidth: 120 }),
      { compact: true, fullWidth: 300 },
    );
  });

  it("紧凑态下容器再变宽到自然宽度以上：切回完整", () => {
    deepStrictEqual(
      nextFilterRowMode({ compact: true, fullWidth: 300, containerWidth: 340, contentWidth: 120 }),
      { compact: false, fullWidth: 300 },
    );
  });
});
