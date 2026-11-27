import { test } from "node:test";
import assert from "node:assert/strict";
import { consistentBinaries, pairBinary, parseWorkspace, type Workspace } from "./workspace.ts";

const ws = (id: string, binaryWith?: string): Workspace => ({ id, name: id, path: `/w/${id}`, createdAt: 0, attachedDirs: [], ...(binaryWith === undefined ? {} : { binaryWith }) });
const partnerOf = (list: readonly Workspace[], id: string): string | undefined => list.find((w) => w.id === id)?.binaryWith;

test("结成联星：两边同时写上对方", () => {
  const next = pairBinary([ws("a"), ws("b"), ws("c")], "a", "b");
  assert.equal(partnerOf(next, "a"), "b");
  assert.equal(partnerOf(next, "b"), "a");
  assert.equal(partnerOf(next, "c"), undefined);
});

test("解除联星：两边一起拿掉（字段整个删掉，不留 undefined）", () => {
  const next = pairBinary([ws("a", "b"), ws("b", "a")], "b", null);
  assert.equal(partnerOf(next, "a"), undefined);
  assert.equal(partnerOf(next, "b"), undefined);
  assert.equal("binaryWith" in (next[0] as object), false);
});

test("换伴星：两边原来的伴星一并解除，一颗星只有一个伴星", () => {
  const next = pairBinary([ws("a", "b"), ws("b", "a"), ws("c", "d"), ws("d", "c")], "a", "c");
  assert.deepEqual(next.map((w) => [w.id, w.binaryWith ?? null]), [
    ["a", "c"],
    ["b", null],
    ["c", "a"],
    ["d", null],
  ]);
});

test("配自己、配不存在的工作区：当解除", () => {
  assert.equal(partnerOf(pairBinary([ws("a", "b"), ws("b", "a")], "a", "a"), "b"), undefined);
  assert.equal(partnerOf(pairBinary([ws("a"), ws("b")], "a", "zzz"), "a"), undefined);
});

test("读回守对称：单边、悬空、指自己的都丢掉，成对的留着", () => {
  const list = consistentBinaries([ws("a", "b"), ws("b", "a"), ws("c", "a"), ws("d", "gone"), ws("e", "e")]);
  assert.deepEqual(list.map((w) => w.binaryWith ?? null), ["b", "a", null, null, null]);
});

test("落盘往返：parseWorkspace 读得回 binaryWith，空串当没有", () => {
  const round = parseWorkspace(JSON.parse(JSON.stringify(ws("a", "b"))));
  assert.equal(round?.binaryWith, "b");
  assert.equal(parseWorkspace({ id: "a", path: "/a", binaryWith: "" })?.binaryWith, undefined);
});
