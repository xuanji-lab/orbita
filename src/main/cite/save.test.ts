/**
 * 写进 .bib 的回归网：**写哪一份**、**key 怎么去重**、**冲突时一个字都不写**。
 *
 * 夹具在临时目录里现造：真实论文仓的 .bib 名字五花八门（`refs.bib`、`refs/notes.bib`、
 * 中文文件名），"写到哪"是用户能直接看见的后果，所以三种分支都钉死。
 *
 * 冲突那一格用注入的写函数制造：要测的是「读完之后盘上被改过 → 不覆盖」这个承诺，
 * 靠并发去碰时间窗只会得到一个时灵时不灵的测试。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash, type FileWriteResult } from "../../shared/files.ts";
import type { CiteCandidate } from "../../shared/cite.ts";
import { chooseBibTarget, writeCiteEntry } from "./save.ts";
import { scanBibFiles } from "./library.ts";

function candidate(patch: Partial<CiteCandidate> = {}): CiteCandidate {
  return {
    source: "crossref",
    title: "Attention Is All You Need",
    authors: ["Ashish Vaswani"],
    year: "2017",
    venue: "NeurIPS",
    doi: "10.5555/3295222.3295349",
    arxivId: null,
    type: "inproceedings",
    volume: "30",
    pages: "5998-6008",
    primaryClass: null,
    ...patch,
  };
}

function withProject(build: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "orbita-cite-save-"));
  build(dir);
  return dir;
}

describe("chooseBibTarget —— 写哪一份", () => {
  test("项目根有 refs.bib：优先它", () => {
    const dir = withProject((root) => {
      writeFileSync(join(root, "a.bib"), "@misc{a,\n}\n");
      writeFileSync(join(root, "refs.bib"), "@misc{r,\n}\n");
    });
    try {
      const target = chooseBibTarget(dir, null, scanBibFiles(dir).files);
      assert.equal(target.exists, true);
      assert.match(target.path, /refs\.bib$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("没有 refs.bib：取扫描顺序里的第一份", () => {
    const dir = withProject((root) => {
      writeFileSync(join(root, "b.bib"), "@misc{b,\n}\n");
      writeFileSync(join(root, "a.bib"), "@misc{a,\n}\n");
    });
    try {
      const files = scanBibFiles(dir).files;
      assert.equal(files.length, 2);
      const target = chooseBibTarget(dir, null, files);
      assert.equal(target.path, files[0]);
      assert.match(target.path, /a\.bib$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("一份都没有：在主文件旁新建 refs.bib", () => {
    const dir = withProject((root) => {
      mkdirSync(join(root, "chapters"), { recursive: true });
    });
    try {
      const target = chooseBibTarget(dir, "chapters/main.tex", scanBibFiles(dir).files);
      assert.equal(target.exists, false);
      assert.match(target.path, /chapters[\\/]refs\.bib$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeCiteEntry", () => {
  test("追加到 refs.bib：原有条目留着，新条目带 key，返回相对路径", async () => {
    const dir = withProject((root) => {
      writeFileSync(join(root, "refs.bib"), "@misc{keepme,\n  title = {Keep},\n}\n");
    });
    try {
      const outcome = await writeCiteEntry(dir, null, candidate());
      assert.ok(outcome.ok);
      assert.equal(outcome.path, "refs.bib");
      assert.equal(outcome.key, "vaswani2017attention");
      assert.equal(outcome.created, false);
      const text = readFileSync(join(dir, "refs.bib"), "utf8");
      assert.match(text, /@misc\{keepme,/);
      assert.match(text, /@inproceedings\{vaswani2017attention,/);
      // 原有条目在前，新条目在后
      assert.ok(text.indexOf("keepme") < text.indexOf("vaswani2017attention"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("key 与盘上已有的重名：加 a 后缀", async () => {
    const dir = withProject((root) => {
      writeFileSync(
        join(root, "refs.bib"),
        "@inproceedings{vaswani2017attention,\n  title = {Same},\n}\n",
      );
    });
    try {
      const outcome = await writeCiteEntry(dir, null, candidate());
      assert.ok(outcome.ok);
      assert.equal(outcome.key, "vaswani2017attentiona");
      const text = readFileSync(join(dir, "refs.bib"), "utf8");
      assert.match(text, /@inproceedings\{vaswani2017attentiona,/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("一份 .bib 都没有：新建 refs.bib，created=true", async () => {
    const dir = withProject(() => undefined);
    try {
      const outcome = await writeCiteEntry(dir, "main.tex", candidate());
      assert.ok(outcome.ok);
      assert.equal(outcome.created, true);
      assert.equal(outcome.path, "refs.bib");
      const text = readFileSync(join(dir, "refs.bib"), "utf8");
      assert.match(text, /@inproceedings\{vaswani2017attention,/);
      assert.ok(text.endsWith("}\n"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("读完之后盘上被改过：回 conflict，正文原样不动", async () => {
    const dir = withProject((root) => {
      writeFileSync(join(root, "refs.bib"), "@misc{original,\n}\n");
    });
    try {
      let seenHash: string | null = null;
      const outcome = await writeCiteEntry(dir, null, candidate(), {
        write: async (_path, _text, expectedHash): Promise<FileWriteResult> => {
          seenHash = expectedHash;
          return {
            kind: "conflict",
            text: "someone else wrote this\n",
            hash: contentHash("someone else wrote this\n"),
            modifiedAt: 0,
            size: 24,
          };
        },
      });
      assert.deepEqual(outcome, { ok: false, reason: "conflict", detail: "refs.bib" });
      // 交给写通道的是**读到那一刻**的指纹：这就是「不覆盖」的凭据
      assert.equal(seenHash, contentHash("@misc{original,\n}\n"));
      assert.equal(readFileSync(join(dir, "refs.bib"), "utf8"), "@misc{original,\n}\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("写失败（权限 / 磁盘）：回 write-failed，不抛", async () => {
    const dir = withProject((root) => {
      writeFileSync(join(root, "refs.bib"), "@misc{original,\n}\n");
    });
    try {
      const outcome = await writeCiteEntry(dir, null, candidate(), {
        write: () => Promise.reject(new Error("EACCES: permission denied")),
      });
      assert.deepEqual(outcome, { ok: false, reason: "write-failed", detail: "EACCES: permission denied" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
