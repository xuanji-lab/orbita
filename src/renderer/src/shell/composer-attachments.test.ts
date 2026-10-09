import test from "node:test";
import assert from "node:assert/strict";
import { admitFileRefs, fileRefRejectionText, withStatKinds } from "./composer-attachments.ts";
import type { Messages } from "../messages-en.ts";

test("admitFileRefs 按顺序收、满了记 too-many", () => {
  const files = Array.from({ length: 12 }, (_, i) => ({ path: `/tmp/f${i}.ts`, name: `f${i}.ts` }));
  const { accepted, rejected } = admitFileRefs(files, []);
  assert.equal(accepted.length, 10);
  assert.equal(rejected.length, 2);
  assert.deepEqual(rejected.map((item) => item.reason), ["too-many", "too-many"]);
  // 名额在已有基础上续：占 9 个的草稿只再收 1 个
  const almost = admitFileRefs(files, accepted.slice(0, 9).map((item) => ({ path: item.path })));
  assert.equal(almost.accepted.length, 1);
  assert.equal(almost.rejected.length, 11);
});

test("admitFileRefs：同路径记 duplicate，空路径记 no-path", () => {
  const first = admitFileRefs([{ path: "/tmp/a.ts", name: "a.ts" }], []);
  assert.equal(first.accepted.length, 1);
  const again = admitFileRefs([{ path: "/tmp/a.ts", name: "a.ts" }], first.accepted);
  assert.equal(again.accepted.length, 0);
  assert.equal(again.rejected[0]?.reason, "duplicate");
  const lost = admitFileRefs([{ path: "", name: "clipboard.png" }], []);
  assert.equal(lost.rejected[0]?.reason, "no-path");
});

test("withStatKinds：按 id 贴回真实类型，被移除的与贴不上的不动", () => {
  const base = [
    { id: "a", path: "/tmp/a.ts", kind: "file" as const },
    { id: "dir", path: "/tmp/dir", kind: "file" as const },
    { id: "gone", path: "/tmp/gone", kind: "file" as const },
  ];
  // stat 回来时 gone 已被用户移除；回执只盖得住前两条
  const current = base.filter((item) => item.id !== "gone");
  const next = withStatKinds(current, [
    { id: "a", kind: "file" },
    { id: "dir", kind: "dir" },
  ]);
  assert.deepEqual(next, [
    { id: "a", path: "/tmp/a.ts", kind: "file" },
    { id: "dir", path: "/tmp/dir", kind: "dir" },
  ]);
  // kind 没变的条目返回原对象（React 按引用短路重渲）
  assert.equal(next[0], current[0]);
  // 整批都贴不上（通道回执短一截）时原样返回
  assert.deepEqual(withStatKinds(current, []), current);
});

/** 只走文件拒绝的两个分支——图片的文案归 composer-images 的 rejectionText */
const fakeT = {
  composer: {
    fileNoPath: (name: string) => `no path: ${name}`,
    fileAlreadyAttached: (name: string) => `attached: ${name}`,
    tooManyFiles: (max: number) => `max ${max}`,
  },
} as unknown as Messages;

test("fileRefRejectionText：逐条点名、too-many 合并一句", () => {
  assert.equal(fileRefRejectionText([], fakeT), null);
  const text = fileRefRejectionText(
    [
      { name: "a.ts", reason: "duplicate" },
      { name: "b.ts", reason: "no-path" },
      { name: "c.ts", reason: "too-many" },
    ],
    fakeT,
  );
  assert.equal(text, "attached: a.ts no path: b.ts max 10");
});
