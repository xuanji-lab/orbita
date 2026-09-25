import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { heroFace, SLOGAN_EN, SLOGAN_ZH, sloganCells, sloganOf } from "./home-hero.ts";

describe("heroFace / sloganOf —— 门面按主题分，不按界面语言分", () => {
  test("稿纸两档各有自己的门面，其余主题是普通一行", () => {
    assert.equal(heroFace("manuscript"), "manuscript");
    assert.equal(heroFace("typescript"), "typescript");
    assert.equal(heroFace("light"), "plain");
    assert.equal(heroFace("black"), "plain");
    assert.equal(heroFace(undefined), "plain");
  });

  test("只有打字稿换英文 slogan；英文界面的 Light 仍是中文 slogan", () => {
    assert.equal(sloganOf("typescript"), SLOGAN_EN);
    assert.equal(sloganOf("manuscript"), SLOGAN_ZH);
    assert.equal(sloganOf("plain"), SLOGAN_ZH);
  });
});

describe("sloganCells —— 一字一格", () => {
  test("九个字九格，全角逗号标为标点", () => {
    const cells = sloganCells(SLOGAN_ZH);
    assert.equal(cells.length, 9);
    assert.deepEqual(
      cells.filter((c) => c.punct).map((c) => c.char),
      ["，"],
    );
    assert.equal(cells.map((c) => c.char).join(""), SLOGAN_ZH);
  });

  test("按码位拆：扩展区汉字不会被劈成两半", () => {
    assert.deepEqual(sloganCells("𠀀字"), [
      { char: "𠀀", punct: false },
      { char: "字", punct: false },
    ]);
  });
});
