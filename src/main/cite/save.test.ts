/**
 * 写进 .bib 的回归网：**写哪一份**、**别人已写过就不覆盖**、**项目外一步都不写**、
 * **同一篇不写第二份**。
 *
 * 夹具在临时目录里现造：真实论文仓的 .bib 名字五花八门（`refs.bib`、`refs/lit.bib`、
 * 中文文件名），"写到哪"是用户能直接看见的后果，所以每条分支都钉死。
 *
 * 冲突 / 并发用两种方式验：
 * - 注入写函数制造「读完之后盘上被改过」——这是不覆盖承诺的核心，不能靠碰时间窗；
 * - 真并发 `Promise.all` 两次新建：独占创建只有一个能成，另一个必须回 conflict
 *   （评审 F4：以前两条都回 created，先写的那条被后写的抹掉）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { contentHash, EDITOR_WRITE_LIMIT, type FileWriteResult } from "../../shared/files.ts";
import type { CiteAuthor, CiteCandidate } from "../../shared/cite.ts";
import { chooseBibTarget, normalizeArxiv, normalizeDoi, writeCiteEntry } from "./save.ts";
import { scanBibFiles } from "./library.ts";

function candidate(patch: Partial<CiteCandidate> = {}): CiteCandidate {
  return {
    source: "crossref",
    title: "Attention Is All You Need",
    authors: [{ given: "Ashish", family: "Vaswani" } satisfies CiteAuthor],
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

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

describe("chooseBibTarget —— 写哪一份", () => {
  test("主文件声明了 \\bibliography{refs/lit}：写它，哪怕 refs.bib 也在", () => {
    const dir = withProject((root) => {
      mkdirSync(join(root, "refs"), { recursive: true });
      writeFileSync(join(root, "refs", "lit.bib"), "@misc{lit,\n}\n");
      writeFileSync(join(root, "refs.bib"), "@misc{root,\n}\n");
    });
    try {
      const choice = chooseBibTarget(dir, ["refs/lit.bib"], scanBibFiles(dir).files, null);
      assert.equal(choice.outside, null);
      assert.match(choice.target?.path ?? "", /refs[\\/]lit\.bib$/);
      assert.equal(choice.target?.exists, true);
    } finally {
      cleanup(dir);
    }
  });

  test("声明的那份还不存在：按它新建", () => {
    const dir = withProject(() => undefined);
    try {
      const choice = chooseBibTarget(dir, ["refs/lit.bib"], [], null);
      assert.equal(choice.target?.exists, false);
      assert.match(choice.target?.path ?? "", /refs[\\/]lit\.bib$/);
    } finally {
      cleanup(dir);
    }
  });

  test("没有声明：项目根 refs.bib 优先，否则扫描顺序第一份", () => {
    const dir = withProject((root) => {
      writeFileSync(join(root, "b.bib"), "@misc{b,\n}\n");
      writeFileSync(join(root, "a.bib"), "@misc{a,\n}\n");
    });
    try {
      const first = chooseBibTarget(dir, [], scanBibFiles(dir).files, null);
      assert.equal(first.target?.path, scanBibFiles(dir).files[0]);

      writeFileSync(join(dir, "refs.bib"), "@misc{r,\n}\n");
      const preferred = chooseBibTarget(dir, [], scanBibFiles(dir).files, null);
      assert.match(preferred.target?.path ?? "", /refs\.bib$/);
    } finally {
      cleanup(dir);
    }
  });

  test("一份都没有：在主文件旁新建 refs.bib", () => {
    const dir = withProject((root) => {
      mkdirSync(join(root, "chapters"), { recursive: true });
    });
    try {
      const choice = chooseBibTarget(dir, [], [], null);
      assert.equal(choice.target?.exists, false);
      assert.match(choice.target?.path ?? "", /refs\.bib$/);
    } finally {
      cleanup(dir);
    }
  });

  test("声明落在项目外：明确回 outside，不写（评审 F16 的同一条线）", () => {
    const dir = withProject(() => undefined);
    try {
      const choice = chooseBibTarget(dir, ["../shared/lit.bib"], [], null);
      assert.equal(choice.target, null);
      assert.equal(choice.outside, "../shared/lit.bib");
    } finally {
      cleanup(dir);
    }
  });

  test("主文件在项目外且没有任何 .bib：回 outside，不在工作区外建文件", () => {
    const dir = withProject(() => undefined);
    try {
      const choice = chooseBibTarget(dir, [], [], "../outside/main.tex");
      assert.equal(choice.target, null);
      assert.equal(choice.outside, "../outside/main.tex");
    } finally {
      cleanup(dir);
    }
  });
});

describe("writeCiteEntry", () => {
  test("追加到 refs.bib：原有条目留着，新条目带 key，回相对路径", async () => {
    const dir = withProject((root) => {
      writeFileSync(join(root, "refs.bib"), "@misc{keepme,\n  title = {Keep},\n}\n");
    });
    try {
      const outcome = await writeCiteEntry(dir, null, candidate());
      assert.ok(outcome.ok);
      assert.equal(outcome.path, "refs.bib");
      assert.equal(outcome.key, "vaswani2017attention");
      assert.equal(outcome.created, false);
      assert.equal(outcome.reused, false);
      const text = readFileSync(join(dir, "refs.bib"), "utf8");
      assert.match(text, /@misc\{keepme,/);
      assert.match(text, /@inproceedings\{vaswani2017attention,/);
      assert.ok(text.indexOf("keepme") < text.indexOf("vaswani2017attention"));
    } finally {
      cleanup(dir);
    }
  });

  test("按主文件里的 \\bibliography 写进 refs/lit.bib（评审 F5）", async () => {
    const dir = withProject((root) => {
      mkdirSync(join(root, "refs"), { recursive: true });
      writeFileSync(join(root, "main.tex"), "\\documentclass{article}\n\\bibliography{refs/lit}\n");
      writeFileSync(join(root, "notes.bib"), "@misc{notes,\n}\n");
    });
    try {
      const outcome = await writeCiteEntry(dir, "main.tex", candidate());
      assert.ok(outcome.ok);
      assert.equal(outcome.path, "refs/lit.bib");
      assert.equal(outcome.created, true);
      assert.match(readFileSync(join(dir, "refs", "lit.bib"), "utf8"), /vaswani2017attention/);
      // 那份没人引用的 notes.bib 一个字都不该动
      assert.equal(readFileSync(join(dir, "notes.bib"), "utf8"), "@misc{notes,\n}\n");
    } finally {
      cleanup(dir);
    }
  });

  test("\\addbibresource（biblatex）同样认", async () => {
    const dir = withProject((root) => {
      writeFileSync(join(root, "main.tex"), "\\addbibresource[location=local]{refs/library.bib}\n");
    });
    try {
      const outcome = await writeCiteEntry(dir, "main.tex", candidate());
      assert.ok(outcome.ok);
      assert.equal(outcome.path, "refs/library.bib");
    } finally {
      cleanup(dir);
    }
  });

  test("key 与**另一份** .bib 重名也加后缀（评审 F3）", async () => {
    const dir = withProject((root) => {
      writeFileSync(join(root, "a.bib"), "@misc{vaswani2017attention,\n}\n");
      writeFileSync(join(root, "refs.bib"), "@misc{keepme,\n}\n");
    });
    try {
      const outcome = await writeCiteEntry(dir, null, candidate());
      assert.ok(outcome.ok);
      assert.equal(outcome.path, "refs.bib");
      assert.equal(outcome.key, "vaswani2017attentiona");
    } finally {
      cleanup(dir);
    }
  });

  test("同一篇（同 DOI）再选一次：复用已有 key，不再写（评审 F6）", async () => {
    const dir = withProject((root) => {
      writeFileSync(
        join(root, "refs.bib"),
        "@article{vaswani2017attention,\n  title = {Attention Is All You Need},\n  doi = {https://doi.org/10.5555/3295222.3295349},\n}\n",
      );
    });
    try {
      const before = readFileSync(join(dir, "refs.bib"), "utf8");
      const outcome = await writeCiteEntry(dir, null, candidate());
      assert.ok(outcome.ok);
      assert.equal(outcome.reused, true);
      assert.equal(outcome.key, "vaswani2017attention");
      assert.equal(outcome.path, "refs.bib");
      assert.equal(readFileSync(join(dir, "refs.bib"), "utf8"), before);
    } finally {
      cleanup(dir);
    }
  });

  test("同一篇（同 arXiv 号）再选一次：复用已有 key", async () => {
    const dir = withProject((root) => {
      writeFileSync(
        join(root, "refs.bib"),
        "@misc{vaswani2017attention,\n  eprint = {arXiv:1706.03762v7},\n}\n",
      );
    });
    try {
      const outcome = await writeCiteEntry(
        dir,
        null,
        candidate({ doi: null, arxivId: "1706.03762", type: "misc" }),
      );
      assert.ok(outcome.ok);
      assert.equal(outcome.reused, true);
      assert.equal(outcome.key, "vaswani2017attention");
    } finally {
      cleanup(dir);
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
      cleanup(dir);
    }
  });

  test("并发新建同一份 .bib：只有一个 created，另一个 conflict，先写的条目还在（评审 F4）", async () => {
    const dir = withProject(() => undefined);
    try {
      const [a, b] = await Promise.all([
        writeCiteEntry(dir, null, candidate()),
        writeCiteEntry(dir, null, candidate({ doi: "10.9999/other", title: "A Different Paper" })),
      ]);
      const created = [a, b].filter((outcome) => outcome.ok && outcome.created);
      const conflicts = [a, b].filter((outcome) => !outcome.ok && outcome.reason === "conflict");
      assert.equal(created.length, 1, JSON.stringify([a, b]));
      assert.equal(conflicts.length, 1, JSON.stringify([a, b]));
      // 文件里恰好一条，且就是 created 那条的 key
      const text = readFileSync(join(dir, "refs.bib"), "utf8");
      const winner = created[0];
      assert.ok(winner?.ok === true);
      assert.equal((text.match(/^@/gm) ?? []).length, 1);
      assert.match(text, new RegExp(`\\{${winner.key},`));
    } finally {
      cleanup(dir);
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
      assert.equal(seenHash, contentHash("@misc{original,\n}\n"));
      assert.equal(readFileSync(join(dir, "refs.bib"), "utf8"), "@misc{original,\n}\n");
    } finally {
      cleanup(dir);
    }
  });

  test("main 指向项目外：回 outside-project，不在项目外建任何东西（评审 F16）", async () => {
    const dir = withProject((root) => {
      writeFileSync(join(root, "main.tex"), "documentclass only");
    });
    const sibling = mkdtempSync(join(tmpdir(), "orbita-cite-outside-"));
    try {
      const mainRelative = `../${basename(sibling)}/main.tex`;
      const outcome = await writeCiteEntry(dir, mainRelative, candidate());
      assert.deepEqual(outcome, { ok: false, reason: "outside-project", detail: mainRelative });
      // 工作区外一个字节都没写
      assert.throws(() => readFileSync(join(sibling, "refs.bib"), "utf8"));
    } finally {
      cleanup(dir);
      cleanup(sibling);
    }
  });

  test("超大的 .bib：不回写，detail 是技术串（评审 F14）", async () => {
    const dir = withProject((root) => {
      writeFileSync(join(root, "refs.bib"), "x".repeat(EDITOR_WRITE_LIMIT + 1));
    });
    try {
      const outcome = await writeCiteEntry(dir, null, candidate());
      assert.ok(outcome.ok === false);
      assert.equal(outcome.detail.startsWith("too-large: refs.bib ("), true);
      assert.doesNotMatch(outcome.detail, /[一-鿿]/);
    } finally {
      cleanup(dir);
    }
  });

  test("写失败（权限 / 磁盘）：回 write-failed，不抛；detail 是原文", async () => {
    const dir = withProject((root) => {
      writeFileSync(join(root, "refs.bib"), "@misc{original,\n}\n");
    });
    try {
      const outcome = await writeCiteEntry(dir, null, candidate(), {
        write: () => Promise.reject(new Error("EACCES: permission denied")),
      });
      assert.deepEqual(outcome, { ok: false, reason: "write-failed", detail: "EACCES: permission denied" });
    } finally {
      cleanup(dir);
    }
  });
});

describe("normalizeDoi / normalizeArxiv —— 「同一篇」的判定口径", () => {
  test("DOI：去掉 URL 前缀与大小写差异", () => {
    assert.equal(normalizeDoi("https://doi.org/10.1000/ABC"), "10.1000/abc");
    assert.equal(normalizeDoi("10.1000/abc"), "10.1000/abc");
    assert.equal(normalizeDoi(""), null);
    assert.equal(normalizeDoi(null), null);
  });

  test("盘上的 TeX 转义要还原（我们写进去时转义了 _，不还原就认不出同一篇）", () => {
    assert.equal(normalizeDoi("10.1007/978-3-031-84300-6\_13"), "10.1007/978-3-031-84300-6_13");
  });

  test("arXiv：去掉前缀与版本号", () => {
    assert.equal(normalizeArxiv("arXiv:1706.03762v7"), "1706.03762");
    assert.equal(normalizeArxiv("1706.03762"), "1706.03762");
    assert.equal(normalizeArxiv(null), null);
  });
});

