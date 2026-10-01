import { test } from "node:test";
import assert from "node:assert/strict";
import { chipsOf } from "./revert-preview.ts";

test("chipsOf：每个路径只出一枚胶囊，会伤到你的排在前面", () => {
  const chips = chipsOf({
    restore: ["/w/a.md", "/w/b.md"],
    deletes: ["/w/new.html"],
    userModified: ["/w/b.md"],
    unrecoverable: ["/w/big.bin"],
  });
  assert.deepEqual(
    chips.map((chip) => [chip.path, chip.effect]),
    [
      ["/w/b.md", "yours"],
      ["/w/new.html", "delete"],
      ["/w/a.md", "restore"],
      ["/w/big.bin", "stuck"],
    ],
  );
});

test("chipsOf：撤销计划里「后续轮也改过」与「你改过」重叠时只算你改过", () => {
  const chips = chipsOf({
    turnId: "t1",
    restore: ["/w/a.md", "/w/c.md"],
    deletes: [],
    userModified: ["/w/a.md"],
    laterTouched: ["/w/a.md", "/w/c.md"],
    unrecoverable: [],
  });
  assert.deepEqual(
    chips.map((chip) => [chip.path, chip.effect]),
    [
      ["/w/a.md", "yours"],
      ["/w/c.md", "later"],
    ],
  );
});
