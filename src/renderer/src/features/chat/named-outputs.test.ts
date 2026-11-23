import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration, namedMedia } from "./named-outputs.ts";

const art = (path: string, duration?: number) => (duration === undefined ? { path } : { path, duration });
const FINAL = "/Users/u/Orbita/Home/audio/wang_summary_zh_george.mp3";
const ALL = [
  art(FINAL, 231),
  art("/Users/u/Orbita/Home/audio/wang_summary_zh_george/part_1.mp3", 38),
  art("/Users/u/Orbita/Home/audio/wang_summary_zh_george/silence.mp3", 1),
  art("/Users/u/Orbita/Home/audio/test/george.mp3", 9),
  art("/Users/u/Orbita/Home/audio/test/bella.mp3", 9),
];

describe("namedMedia：回答里点了名的才算产物", () => {
  test("只点了成品：分段、静音、试音一个都不出现（13 个 mp3 的误报场景）", () => {
    const shown = namedMedia(ALL, "跑完了。音频是 **wang_summary_zh_george.mp3**，3 分 51 秒。");
    assert.deepEqual(shown.map((a) => a.path), [FINAL]);
  });
  test("点名用完整路径也算", () => {
    assert.deepEqual(namedMedia(ALL, `成品在 ${FINAL}`).map((a) => a.path), [FINAL]);
  });
  test("子串不算：george.mp3 不是 wang_summary_zh_george.mp3 的提及，反之亦然", () => {
    const onlyFinal = namedMedia(ALL, "音频是 wang_summary_zh_george.mp3");
    assert.equal(onlyFinal.some((a) => a.path.endsWith("/test/george.mp3")), false);
    const onlyTest = namedMedia(ALL, "样本是 george.mp3");
    assert.deepEqual(onlyTest.map((a) => a.path), ["/Users/u/Orbita/Home/audio/test/george.mp3"]);
  });
  test("点了几个就出几个，按候选顺序", () => {
    const shown = namedMedia(ALL, "样本：bella.mp3、george.mp3；成品 wang_summary_zh_george.mp3");
    assert.deepEqual(shown.map((a) => a.path), [FINAL, "/Users/u/Orbita/Home/audio/test/george.mp3", "/Users/u/Orbita/Home/audio/test/bella.mp3"]);
  });
  test("前后是中文 / 标点 / 反引号 / 句号都算边界；后面跟 .bak 或字母不算", () => {
    for (const text of ["音频是wang_summary_zh_george.mp3，好", "`wang_summary_zh_george.mp3`", "见 wang_summary_zh_george.mp3。", "(wang_summary_zh_george.mp3)"]) {
      assert.equal(namedMedia(ALL, text).length, 1, text);
    }
    assert.equal(namedMedia(ALL, "wang_summary_zh_george.mp3.bak").length, 0);
    assert.equal(namedMedia(ALL, "wang_summary_zh_george.mp3x").length, 0);
  });
  test("大小写与 Windows 反斜杠不影响", () => {
    assert.equal(namedMedia([art("C:\\media\\Clip.MP4")], "文件 clip.mp4 在 C:\\media").length, 1);
    assert.equal(namedMedia([art("C:\\media\\Clip.MP4")], "C:\\media\\Clip.MP4").length, 1);
  });
  test("正文空 / 没点名 / 候选空：空；同路径去重", () => {
    assert.deepEqual(namedMedia(ALL, ""), []);
    assert.deepEqual(namedMedia(ALL, "做好了，在 audio 目录里"), []);
    assert.deepEqual(namedMedia([], "x.mp3"), []);
    assert.equal(namedMedia([art("/a/x.mp3"), art("/a/x.mp3")], "x.mp3").length, 1);
  });
});

describe("formatDuration", () => {
  test("m:ss / h:mm:ss，四舍五入到秒，至少 0:01", () => {
    assert.equal(formatDuration(231.04), "3:51");
    assert.equal(formatDuration(0.2), "0:01");
    assert.equal(formatDuration(3723), "1:02:03");
  });
  test("缺 / 非法 → null（不显示）", () => {
    for (const v of [undefined, 0, -3, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(formatDuration(v), null);
  });
});
