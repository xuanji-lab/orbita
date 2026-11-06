import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { DocFile, DocWriteResult } from "../../../../shared/doc.ts";
import { DocSession, type ExternalChange, type SyncState } from "./doc-session.ts";

const hash = (text: string): string => createHash("sha1").update(text).digest("hex");

/** 内存里的「盘」：与主进程 writeDoc 同一个比较后交换语义 */
class FakeDisk {
  text: string;
  writes = 0;
  failNext = false;
  constructor(text: string) {
    this.text = text;
  }
  file(): DocFile {
    return { text: this.text, hash: hash(this.text), modifiedAt: 0 };
  }
  io = {
    read: async (): Promise<DocFile> => this.file(),
    write: async (text: string, expectedHash: string): Promise<DocWriteResult> => {
      if (this.failNext) {
        this.failNext = false;
        throw new Error("磁盘写失败");
      }
      if (hash(this.text) !== expectedHash) return { ok: false, reason: "conflict", file: this.file() };
      this.text = text;
      this.writes += 1;
      return { ok: true, hash: hash(text), modifiedAt: 0 };
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function open(text: string) {
  const disk = new FakeDisk(text);
  const states: SyncState[] = [];
  const externals: ExternalChange[] = [];
  let error: string | null = null;
  const session = new DocSession(
    disk.io,
    disk.file(),
    {
      onState: (state, message) => {
        states.push(state);
        error = message;
      },
      onExternal: (change) => externals.push(change),
    },
    20,
  );
  return { disk, session, states, externals, error: () => error };
}

const DOC = "第一段\n\n第二段\n\n第三段\n";

describe("DocSession —— 自动保存", () => {
  it("A2：打字 → 防抖后落盘；连续打字只写一次", async () => {
    const { disk, session, states } = open("");
    for (const text of ["你", "你好", "你好，世", "你好，世界"]) {
      session.edit(text);
      await sleep(5);
    }
    assert.equal(disk.writes, 0, "还在防抖里");
    await sleep(60);
    assert.equal(disk.text, "你好，世界");
    assert.equal(disk.writes, 1);
    assert.equal(states.at(-1), "saved");
    assert.ok(states.includes("dirty") && states.includes("saving"));
  });

  it("flush 立刻落盘并等写完", async () => {
    const { disk, session } = open("");
    session.edit("要关面板了");
    await session.flush();
    assert.equal(disk.text, "要关面板了");
  });

  it("写失败：状态 error 带原因，文本不丢，下一次编辑再试", async () => {
    const { disk, session, states, error } = open("");
    disk.failNext = true;
    session.edit("别丢");
    await sleep(60);
    assert.equal(states.at(-1), "error");
    assert.match(error() ?? "", /磁盘写失败/);
    assert.equal(session.text, "别丢");
    session.edit("别丢啊");
    await sleep(60);
    assert.equal(disk.text, "别丢啊");
    assert.equal(states.at(-1), "saved");
  });
});

describe("DocSession —— agent 同时在写（B1 / B2）", () => {
  it("B1：agent 追加一段、用户没动 → 编辑器只收到那一处插入", async () => {
    const { disk, session, externals } = open(DOC);
    disk.text = `${DOC}\n总结：全部完成。\n`;
    session.diskChanged();
    await sleep(20);
    assert.equal(externals.length, 1);
    assert.equal(session.text, disk.text);
    assert.equal(externals[0]?.changes.length, 1);
    assert.equal(externals[0]?.inserted.length, 1);
    const range = externals[0]!.inserted[0]!;
    assert.match(session.text.slice(range.from, range.to), /总结/);
  });

  it("B2：用户正在第一段打字（还没落盘），agent 写入 → 用户的字和 agent 的段落都在，且最终落盘的是合并结果", async () => {
    const { disk, session, externals } = open(DOC);
    session.edit(DOC.replace("第一段", "第一段，用户正在打"));
    disk.text = `${DOC}\n总结：agent 加的。\n`; // agent 在用户保存之前写了盘
    session.diskChanged();
    await sleep(20);
    assert.equal(externals.length, 1);
    assert.ok(session.text.includes("第一段，用户正在打"));
    assert.ok(session.text.includes("总结：agent 加的。"));
    await session.flush();
    assert.equal(disk.text, session.text, "落盘的是两边的合并，agent 那段没被盖掉");
  });

  it("B2：agent 在用户保存的间隙写入 → 写盘撞上 conflict，合并后重写，不覆盖 agent", async () => {
    const { disk, session, externals } = open(DOC);
    session.edit(DOC.replace("第二段", "第二段（用户）"));
    // 用户的防抖到点之前，agent 写盘了，而我们还没收到变化事件（事件有延迟）
    disk.text = DOC.replace("第三段", "第三段（agent）");
    await session.flush();
    assert.equal(externals.length, 1, "合并的结果通知了编辑器");
    assert.equal(disk.text, "第一段\n\n第二段（用户）\n\n第三段（agent）\n");
    assert.equal(session.text, disk.text);
  });

  it("自己写盘的回声（文件监听报了一次变化）：不当外部改动、不通知编辑器", async () => {
    const { session, externals } = open(DOC);
    session.edit(`${DOC}新写的\n`);
    await session.flush();
    session.diskChanged();
    await sleep(20);
    assert.equal(externals.length, 0);
  });

  it("保存进行中来了变化事件：排在保存之后处理，顺序不乱", async () => {
    const { disk, session, externals } = open(DOC);
    session.edit(DOC.replace("第一段", "第一段改"));
    const saving = session.flush();
    disk.text = `${DOC.replace("第一段", "第一段改")}\nagent 追加\n`;
    session.diskChanged();
    await saving;
    await sleep(40);
    assert.ok(session.text.includes("agent 追加"));
    assert.ok(session.text.includes("第一段改"));
    assert.equal(externals.length >= 1, true);
  });

  it("agent 改了文件、用户一直没打字：不触发回写（不制造自己的写）", async () => {
    const { disk, session } = open(DOC);
    disk.text = `${DOC}\nagent\n`;
    session.diskChanged();
    await sleep(60);
    assert.equal(disk.writes, 0);
  });
});
