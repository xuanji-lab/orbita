import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { admitImages, promptImagesBytes, rejectionText } from "./composer-images.ts";
import {
  PROMPT_IMAGE_MAX_BYTES,
  PROMPT_IMAGE_MAX_COUNT,
  PROMPT_IMAGES_TOTAL_MAX_BYTES,
} from "../../../shared/prompt-images.ts";
import { en } from "../messages-en.ts";
import { zh } from "../messages-zh.ts";

const png = (name: string, size = 100) => ({ name, type: "image/png", size });
const MB = 1024 * 1024;

describe("admitImages", () => {
  test("合格的按原顺序收下", () => {
    const { accepted, rejected } = admitImages([png("a"), png("b")], 0, 0);
    assert.deepEqual(accepted.map((f) => f.name), ["a", "b"]);
    assert.deepEqual(rejected, []);
  });

  test("格式与体积逐张判，拒绝带名字与原因", () => {
    const { accepted, rejected } = admitImages(
      [png("ok"), { name: "x.heic", type: "image/heic", size: 1 }, png("big", PROMPT_IMAGE_MAX_BYTES + 1)],
      0,
      0,
    );
    assert.deepEqual(accepted.map((f) => f.name), ["ok"]);
    assert.deepEqual(rejected, [
      { name: "x.heic", reason: "unsupported" },
      { name: "big", reason: "too-large" },
    ]);
  });

  test("名额算上输入框里已有的；满了之后每一张都记 too-many", () => {
    const { accepted, rejected } = admitImages([png("a"), png("b"), png("c")], PROMPT_IMAGE_MAX_COUNT - 1, 0);
    assert.deepEqual(accepted.map((f) => f.name), ["a"]);
    assert.deepEqual(rejected, [
      { name: "b", reason: "too-many" },
      { name: "c", reason: "too-many" },
    ]);
  });

  test("不合格的不占名额，也不占总量", () => {
    const { accepted } = admitImages(
      [{ name: "x.svg", type: "image/svg+xml", size: PROMPT_IMAGES_TOTAL_MAX_BYTES }, png("a")],
      PROMPT_IMAGE_MAX_COUNT - 1,
      0,
    );
    assert.deepEqual(accepted.map((f) => f.name), ["a"]);
  });

  test("没到总量线就全收", () => {
    const size = PROMPT_IMAGES_TOTAL_MAX_BYTES / 4;
    const { accepted, rejected } = admitImages([png("a", size), png("b", size), png("c", size), png("d", size)], 0, 0);
    assert.deepEqual(accepted.map((f) => f.name), ["a", "b", "c", "d"]);
    assert.deepEqual(rejected, []);
  });

  test("加入某张会让总量超线时拒收这张，后面更小的仍可入列", () => {
    const half = PROMPT_IMAGES_TOTAL_MAX_BYTES / 2;
    const { accepted, rejected } = admitImages([png("a", half), png("b", half + 1), png("c", 1)], 0, 0);
    // a + b 会超线：b 拒收；c 很小，a + c 仍在限内
    assert.deepEqual(accepted.map((f) => f.name), ["a", "c"]);
    assert.deepEqual(rejected, [{ name: "b", reason: "total-too-large" }]);
  });

  test("总量线算上输入框里已有的图", () => {
    const { accepted, rejected } = admitImages([png("a", 15 * MB)], 1, PROMPT_IMAGES_TOTAL_MAX_BYTES - 10 * MB);
    assert.deepEqual(accepted.map((f) => f.name), []);
    assert.deepEqual(rejected, [{ name: "a", reason: "total-too-large" }]);
  });

  test("同一批里 too-many 与 total-too-large 可以并存，各记各的", () => {
    // 9 × 2MB = 18MB 收下；big 会让总量到 21MB 超线拒收；t1 小、能入列并把名额用完；t2 撞名额
    const files = [...Array.from({ length: 9 }, (_, i) => png(`s${i}`, 2 * MB)), png("big", 3 * MB), png("t1", 1), png("t2", 1)];
    const { accepted, rejected } = admitImages(files, 0, 0);
    assert.deepEqual(accepted.map((f) => f.name), ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "t1"]);
    assert.deepEqual(rejected, [
      { name: "big", reason: "total-too-large" },
      { name: "t2", reason: "too-many" },
    ]);
  });
});

describe("promptImagesBytes", () => {
  test("base64 长度反推字节数（不去 padding，误差方向保守）", () => {
    // 8 个无填充字符 = 6 字节，正好准确
    assert.equal(promptImagesBytes([{ type: "image", data: "AAAAAAAA", mimeType: "image/png" }]), 6);
    // 2 个填充字符被当数据算：真值 4 字节、算出 6——多算不少算，准入方向保守
    assert.equal(promptImagesBytes([{ type: "image", data: "AAAAAB==", mimeType: "image/png" }]), 6);
    assert.equal(promptImagesBytes([]), 0);
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

  test("total-too-large 合并成一句，与逐张点名并列", () => {
    const text = rejectionText(
      [
        { name: "big", reason: "too-large" },
        { name: "b", reason: "total-too-large" },
        { name: "c", reason: "total-too-large" },
      ],
      en,
    );
    assert.equal(
      text,
      `${en.composer.imageTooLarge("big", PROMPT_IMAGE_MAX_BYTES / 1024 / 1024)} ${en.composer.imagesTotalTooLarge(
        PROMPT_IMAGES_TOTAL_MAX_BYTES / 1024 / 1024,
      )}`,
    );
  });

  test("too-many 与 total-too-large 同时出现时两句都在", () => {
    const text = rejectionText(
      [
        { name: "b", reason: "too-many" },
        { name: "c", reason: "total-too-large" },
      ],
      en,
    );
    assert.equal(
      text,
      `${en.composer.tooManyImages(PROMPT_IMAGE_MAX_COUNT)} ${en.composer.imagesTotalTooLarge(
        PROMPT_IMAGES_TOTAL_MAX_BYTES / 1024 / 1024,
      )}`,
    );
  });

  test("三种超限文案都给出文件夹附加的办法（中英各验）", () => {
    for (const t of [zh, en]) {
      assert.match(t.composer.tooManyImages(PROMPT_IMAGE_MAX_COUNT), /folder|文件夹/);
      assert.match(t.composer.imageTooLarge("x", 30), /folder|文件夹/);
      assert.match(t.composer.imagesTotalTooLarge(20), /folder|文件夹/);
    }
    // 中文说清两条真实入口：拖进来、回形针
    assert.match(zh.composer.tooManyImages(10), /拖进来/);
    assert.match(zh.composer.tooManyImages(10), /回形针/);
    assert.match(en.composer.tooManyImages(10), /drag it in/);
    assert.match(en.composer.tooManyImages(10), /paperclip/);
  });
});
