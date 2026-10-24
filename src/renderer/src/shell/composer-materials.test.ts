import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { composerMaterials } from "./composer-materials.ts";
import type { TextQuote } from "../../../shared/quote.ts";
import type { ComposerFileRef } from "./composer-attachments.ts";
import type { ComposerImage } from "./composer-images.ts";
import { en } from "../messages-en.ts";

const t = en;

const image: ComposerImage = { id: "img-1", name: "shot.png", image: { type: "image", data: "aGk=", mimeType: "image/png" } };
const dir: ComposerFileRef = { id: "f-1", name: "src", path: "/repo/src", kind: "dir", origin: "workspace" };
const file: ComposerFileRef = { id: "f-2", name: "a.ts", path: "/repo/a.ts", kind: "file", origin: "workspace" };
const quotes: TextQuote[] = [
  { text: "被引用的一段", messageId: "m-1", role: "assistant", turn: 3 },
  { text: "第二条", messageId: "m-2", role: "user", turn: 4, truncated: true },
];

function materials() {
  const removed: string[] = [];
  const list = composerMaterials({
    attachments: [image],
    files: [dir, file],
    quotes,
    tasks: [{ id: "s-1", title: "审核PR" }, { id: "s-2", title: "" }],
    onRemoveAttachment: (id) => removed.push(`attachment:${id}`),
    onRemoveFile: (id) => removed.push(`file:${id}`),
    onRemoveQuote: (index) => removed.push(`quote:${index}`),
    onRemoveTask: (id) => removed.push(`task:${id}`),
    t,
  });
  return { list, removed };
}

describe("composerMaterials —— 材料清单", () => {
  it("四路摊平成一张清单，顺序 = 叠放规范顺序：图 → 文件/目录 → 任务 → 引用（粘贴走句中胶囊，不进材料区）", () => {
    const { list } = materials();
    assert.deepEqual(
      list.map((item) => item.kind),
      ["image", "dir", "file", "task", "task", "quote", "quote"],
    );
  });

  it("任务引用：名字是会话标题，空标题给占位；移除按会话 id", () => {
    const { list, removed } = materials();
    assert.equal(list[3]?.name, "审核PR");
    assert.equal(list[4]?.name, t.common.newTask);
    list[4]?.remove();
    assert.deepEqual(removed, ["task:s-2"]);
  });

  it("显示名与元信息：图与文件不带 meta，引用带来源与字数", () => {
    const { list } = materials();
    const [img, d, f, , , q1, q2] = list;
    assert.equal(img?.name, "shot.png");
    assert.equal(img?.meta, null);
    assert.equal(d?.name, "src");
    assert.equal(d?.meta, null);
    assert.equal(f?.name, "a.ts");
    assert.equal(q1?.name, "被引用的一段");
    assert.match(q1?.meta ?? "", /Turn 3/);
    assert.match(q2?.meta ?? "", /first 3 chars only/);
  });

  it("移除回调各接各的：图/文件按 id，引用按下标（后面的引用删一条，角标前移）", () => {
    const { list, removed } = materials();
    list[0]?.remove();
    list[1]?.remove();
    list[6]?.remove(); // 第二条引用 → index 1
    assert.deepEqual(removed, ["attachment:img-1", "file:f-1", "quote:1"]);
  });

  it("原始对象随行携带：排布层要用的（图的数据、引用跳转）不用再对账", () => {
    const { list } = materials();
    assert.equal(list[0]?.kind === "image" && list[0].image === image ? true : false, true);
    assert.equal(list[5]?.kind === "quote" && list[5].quote === quotes[0] ? true : false, true);
  });

  it("引用的 id 含下标：同一消息引两段也不撞 key", () => {
    const twice: TextQuote[] = [
      { text: "第一段", messageId: "m-1", role: "assistant" },
      { text: "第二段", messageId: "m-1", role: "assistant" },
    ];
    const list = composerMaterials({
      attachments: [],
      files: [],
      quotes: twice,
      tasks: [],
      onRemoveAttachment: () => undefined,
      onRemoveFile: () => undefined,
      onRemoveQuote: () => undefined,
      onRemoveTask: () => undefined,
      t,
    });
    assert.notEqual(list[0]?.id, list[1]?.id);
  });
});
