import test from "node:test";
import assert from "node:assert/strict";
import { admitFileRefs, fileRefRejectionText, withStatKinds } from "./composer-attachments.ts";
import type { Messages } from "../messages-en.ts";

test("admitFileRefs 不再设条数上限：一批拖进来多少收多少", () => {
  const files = Array.from({ length: 50 }, (_, i) => ({ path: `/tmp/f${i}.ts`, name: `f${i}.ts` }));
  const { accepted, rejected } = admitFileRefs(files, []);
  assert.equal(accepted.length, 50);
  assert.equal(rejected.length, 0);
  // 已在草稿里的也照续：上限没有了，「接着加」不再有头
  const more = admitFileRefs([{ path: "/tmp/late.md", name: "late.md" }], accepted);
  assert.equal(more.accepted.length, 1);
  assert.equal(more.rejected.length, 0);
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

test("withStatKinds：按 id 贴回真实类型与超限标记，被移除的与贴不上的不动", () => {
  const base = [
    { id: "a", path: "/tmp/a.ts", kind: "file" as const },
    { id: "dir", path: "/tmp/dir", kind: "file" as const },
    { id: "big", path: "/tmp/big.bin", kind: "file" as const },
    { id: "gone", path: "/tmp/gone", kind: "file" as const },
  ];
  // stat 回来时 gone 已被用户移除；回执只盖得住前三条
  const current = base.filter((item) => item.id !== "gone");
  const next = withStatKinds(current, [
    { id: "a", kind: "file" },
    { id: "dir", kind: "dir" },
    { id: "big", kind: "file", uncopied: true },
  ]);
  assert.deepEqual(next, [
    { id: "a", path: "/tmp/a.ts", kind: "file" },
    { id: "dir", path: "/tmp/dir", kind: "dir" },
    { id: "big", path: "/tmp/big.bin", kind: "file", uncopied: true },
  ]);
  // kind 没变且没有超限标记的条目返回原对象（React 按引用短路重渲）
  assert.equal(next[0], current[0]);
  // 整批都贴不上（通道回执短一截）时原样返回
  assert.deepEqual(withStatKinds(current, []), current);
});

/** 只走文件拒绝的两个分支——图片的文案归 composer-images 的 rejectionText */
const fakeT = {
  composer: {
    fileNoPath: (name: string) => `no path: ${name}`,
    fileAlreadyAttached: (name: string) => `attached: ${name}`,
  },
} as unknown as Messages;

test("fileRefRejectionText：逐条点名", () => {
  assert.equal(fileRefRejectionText([], fakeT), null);
  const text = fileRefRejectionText(
    [
      { name: "a.ts", reason: "duplicate" },
      { name: "b.ts", reason: "no-path" },
    ],
    fakeT,
  );
  assert.equal(text, "attached: a.ts no path: b.ts");
});
