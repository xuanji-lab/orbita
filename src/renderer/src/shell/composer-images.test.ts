import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { admitImages, rejectionText } from "./composer-images.ts";
import { PROMPT_IMAGE_MAX_BYTES, PROMPT_IMAGE_MAX_COUNT } from "../../../shared/prompt-images.ts";
import { en } from "../messages-en.ts";

const png = (name: string, size = 100) => ({ name, type: "image/png", size });

describe("admitImages", () => {
  test("合格的按原顺序收下", () => {
    const { accepted, rejected } = admitImages([png("a"), png("b")], 0);
    assert.deepEqual(accepted.map((f) => f.name), ["a", "b"]);
    assert.deepEqual(rejected, []);
  });

  test("格式与体积逐张判，拒绝带名字与原因", () => {
    const { accepted, rejected } = admitImages(
      [png("ok"), { name: "x.heic", type: "image/heic", size: 1 }, png("big", PROMPT_IMAGE_MAX_BYTES + 1)],
      0,
    );
    assert.deepEqual(accepted.map((f) => f.name), ["ok"]);
    assert.deepEqual(rejected, [
      { name: "x.heic", reason: "unsupported" },
      { name: "big", reason: "too-large" },
    ]);
  });

  test("名额算上输入框里已有的；满了之后每一张都记 too-many", () => {
    const { accepted, rejected } = admitImages([png("a"), png("b"), png("c")], PROMPT_IMAGE_MAX_COUNT - 1);
    assert.deepEqual(accepted.map((f) => f.name), ["a"]);
    assert.deepEqual(rejected, [
      { name: "b", reason: "too-many" },
      { name: "c", reason: "too-many" },
    ]);
  });

  test("不合格的不占名额", () => {
    const { accepted } = admitImages(
      [{ name: "x.svg", type: "image/svg+xml", size: 1 }, png("a")],
      PROMPT_IMAGE_MAX_COUNT - 1,
    );
    assert.deepEqual(accepted.map((f) => f.name), ["a"]);
  });
});

describe("rejectionText", () => {
  test("没有拒绝就没有提示", () => {
    assert.equal(rejectionText([], en), null);
  });

  test("too-many 合并成一句，其余逐张点名", () => {
    const text = rejectionText(
      [
        { name: "x.heic", reason: "unsupported" },
        { name: "b", reason: "too-many" },
        { name: "c", reason: "too-many" },
      ],
      en,
    );
    assert.equal(
      text,
      `${en.composer.imageUnsupported("x.heic")} ${en.composer.tooManyImages(PROMPT_IMAGE_MAX_COUNT)}`,
    );
  });
});
