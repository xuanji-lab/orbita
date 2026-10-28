/**
 * 引文核验的账：查得到 / 查到另一篇 / 查不到 / 无法查 / 网络失败 / 上限。
 * 网络用注入的 `search` 换掉（不打真接口），标题匹配规则单独测。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { CiteCandidate, CiteEntry, CiteLibrary, CiteSearchOutcome } from "../../shared/cite.ts";
import { CITE_VERIFY_LIMIT } from "../../shared/cite.ts";
import { normalizeTitle, titlesAgree, verifyCiteEntries, verifyIdentifierOf } from "./verify.ts";

const entry = (patch: Partial<CiteEntry> & { key: string }): CiteEntry => ({
  type: "article",
  title: null,
  author: null,
  year: null,
  doi: null,
  eprint: null,
  file: "refs.bib",
  ...patch,
});

const library = (entries: CiteEntry[]): CiteLibrary => ({ entries, files: [], skipped: [], truncated: false });

const candidate = (patch: Partial<CiteCandidate> & { title: string }): CiteCandidate => ({
  source: "crossref",
  authors: [],
  year: null,
  venue: null,
  doi: null,
  arxivId: null,
  type: "article",
  volume: null,
  pages: null,
  primaryClass: null,
  ...patch,
});

describe("normalizeTitle / titlesAgree", () => {
  test("大小写、标点、LaTeX 命令不影响比较", () => {
    assert.equal(
      normalizeTitle("Sparse Attention: A \\emph{Survey}"),
      normalizeTitle("sparse attention — a survey"),
    );
  });

  test("完全相同 / 一方是另一方的副标题都算同一篇", () => {
    assert.equal(titlesAgree("Attention Is All You Need", "attention is all you need"), true);
    assert.equal(
      titlesAgree("Attention Is All You Need", "Attention Is All You Need: A Retrospective"),
      true,
    );
  });

  test("完全不同的标题不算同一篇；短标题不靠包含关系猜", () => {
    assert.equal(titlesAgree("Attention Is All You Need", "Deep Residual Learning"), false);
    assert.equal(titlesAgree("BERT", "BERT for Everything"), true);
  });

  test("缺标题时不诬告（视为对得上）", () => {
    assert.equal(titlesAgree(null, "Something"), true);
  });
});

describe("verifyIdentifierOf", () => {
  test("优先级 DOI > arXiv 号 > 标题", () => {
    assert.deepEqual(verifyIdentifierOf(entry({ key: "a", doi: "10.1/x", eprint: "2401.1", title: "T" })), {
      kind: "doi",
      value: "10.1/x",
    });
    assert.deepEqual(verifyIdentifierOf(entry({ key: "b", eprint: "2401.1", title: "T" })), { kind: "arxiv", value: "2401.1" });
    assert.deepEqual(verifyIdentifierOf(entry({ key: "c", title: "T" })), { kind: "title", value: "T" });
    assert.equal(verifyIdentifierOf(entry({ key: "d" })), null);
  });
});

describe("verifyCiteEntries", () => {
  test("DOI 查到同一篇 → verified，并带回查到的标题", async () => {
    const batch = await verifyCiteEntries(
      library([entry({ key: "vaswani", doi: "10.1/attention", title: "Attention Is All You Need" })]),
      null,
      {
        search: async () => ({
          ok: true,
          results: [candidate({ title: "Attention is all you need", year: "2017", doi: "10.1/attention" })],
          partial: null,
        }),
      },
    );
    assert.equal(batch.total, 1);
    assert.deepEqual(batch.results[0], {
      key: "vaswani",
      status: "verified",
      identifier: { kind: "doi", value: "10.1/attention" },
      found: { title: "Attention is all you need", year: "2017", doi: "10.1/attention" },
      reason: null,
    });
  });

  test("DOI 查到的是另一篇 → mismatch（编号粘错的第一现场）", async () => {
    const batch = await verifyCiteEntries(
      library([entry({ key: "wrong", doi: "10.1/other", title: "Attention Is All You Need" })]),
      null,
      {
        search: async () => ({
          ok: true,
          results: [candidate({ title: "Deep Residual Learning for Image Recognition" })],
          partial: null,
        }),
      },
    );
    assert.equal(batch.results[0]?.status, "mismatch");
    assert.equal(batch.results[0]?.found?.title, "Deep Residual Learning for Image Recognition");
  });

  test("按标题搜不到 → not-found，不是 error", async () => {
    const batch = await verifyCiteEntries(library([entry({ key: "made-up", title: "A Paper That Does Not Exist" })]), null, {
      search: async () => ({ ok: true, results: [], partial: null }),
    });
    assert.equal(batch.results[0]?.status, "not-found");
    assert.equal(batch.results[0]?.identifier?.kind, "title");
  });

  test("DOI 接口 404 → not-found；离线 / 超时 → error（可以重试）", async () => {
    const notFound = await verifyCiteEntries(library([entry({ key: "a", doi: "10.9/none" })]), null, {
      search: async () => ({ ok: false, reason: "not-found", detail: "404" }),
    });
    assert.equal(notFound.results[0]?.status, "not-found");

    const offline = await verifyCiteEntries(library([entry({ key: "b", doi: "10.9/x" })]), null, {
      search: async () => ({ ok: false, reason: "offline", detail: "ENOTFOUND" }),
    });
    assert.equal(offline.results[0]?.status, "error");
    assert.equal(offline.results[0]?.reason, "offline");
  });

  test("没有 DOI / arXiv 号 / 标题的条目不算可核验（skipped 不进批次）", async () => {
    const batch = await verifyCiteEntries(library([entry({ key: "manual" })]), null, {
      search: async () => {
        throw new Error("不该被调用");
      },
    });
    assert.equal(batch.total, 0);
    assert.deepEqual(batch.results, []);
  });

  test("keys 只查指定条目；上限之外的条目计入 total 但不发请求", async () => {
    const entries = Array.from({ length: CITE_VERIFY_LIMIT + 4 }, (_, index) =>
      entry({ key: `k${index}`, title: `Paper number ${index}` }),
    );
    let calls = 0;
    const batch = await verifyCiteEntries(library(entries), null, {
      search: async () => {
        calls += 1;
        return { ok: true, results: [], partial: null };
      },
    });
    assert.equal(calls, CITE_VERIFY_LIMIT);
    assert.equal(batch.results.length, CITE_VERIFY_LIMIT);
    assert.equal(batch.total, CITE_VERIFY_LIMIT + 4);

    const only = await verifyCiteEntries(library(entries), ["k2", "k5"], {
      search: async () => ({ ok: true, results: [], partial: null }),
    });
    assert.deepEqual(only.results.map((row) => row.key), ["k2", "k5"]);
  });
});
