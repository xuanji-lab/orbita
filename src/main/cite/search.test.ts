/**
 * 在线检索的回归网 —— 输入识别、两个解析器、失败分类、缓存。
 *
 * 样本是**接口实际长什么样**（不是我们理想中的样子）：Crossref 的标题带 `<i>` 与
 * `&amp;`、作者可能只有 `name`、年份藏在 `issued.date-parts[0][0]`；arXiv 的 Atom
 * 里 `<entry>` 可能没有作者或没有 `<published>`。网络全部由注入的 `request` 替身给，
 * 所以「超时 / 断网 / 429」都能离线跑。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  parseArxivFeed,
  parseCrossrefWorks,
  planQuery,
  searchCite,
  type CiteHttpRequest,
  type CiteHttpResponse,
} from "./search.ts";

/** Crossref `/works?query.bibliographic=` 的真实形状（只留用到的字段） */
const CROSSREF_BODY = JSON.stringify({
  status: "ok",
  message: {
    items: [
      {
        title: ["Attention is <i>All</i> You Need &amp; More"],
        author: [
          { given: "Ashish", family: "Vaswani" },
          { name: "Google Brain" },
        ],
        issued: { "date-parts": [[2017, 6, 12]] },
        "container-title": ["Advances in Neural Information Processing Systems"],
        DOI: "10.5555/3295222.3295349",
        type: "proceedings-article",
        volume: "30",
        page: "5998-6008",
      },
      {
        // 缺作者、缺年份、缺刊物：仍然该成为一条（只是字段少）
        title: ["A Study of Nothing"],
        type: "journal-article",
      },
      { title: [] },
      { author: [{ given: "No", family: "Title" }] },
    ],
  },
});

const ARXIV_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title type="html">ArXiv Query</title>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <published>2017-06-12T17:57:16Z</published>
    <title>Attention Is All You Need</title>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <arxiv:primary_category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.CL"/>
    <doi>10.48550/arXiv.1706.03762</doi>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.12345v2</id>
    <title>Fast &amp; Slow: a study</title>
  </entry>
  <entry>
    <title>No identifier at all</title>
  </entry>
</feed>`;

function respond(body: string, status = 200): CiteHttpResponse {
  return { status, body };
}

describe("planQuery —— 标题 / DOI / arXiv 编号三种输入", () => {
  test("arXiv 新编号与版本号", () => {
    assert.deepEqual(planQuery("1706.03762"), { kind: "arxiv", id: "1706.03762" });
    assert.deepEqual(planQuery("2401.12345v3"), { kind: "arxiv", id: "2401.12345" });
    assert.deepEqual(planQuery("arXiv:1706.03762"), { kind: "arxiv", id: "1706.03762" });
    assert.deepEqual(planQuery("  arXiv:1706.03762v2 "), { kind: "arxiv", id: "1706.03762" });
  });

  test("arXiv 旧编号（hep-th/9901001）", () => {
    assert.deepEqual(planQuery("hep-th/9901001"), { kind: "arxiv", id: "hep-th/9901001" });
  });

  test("arXiv 自己注册的 DOI 走 arXiv，不丢给 Crossref（那里查不到）", () => {
    assert.deepEqual(planQuery("10.48550/arXiv.1706.03762"), { kind: "arxiv", id: "1706.03762" });
    assert.deepEqual(planQuery("https://doi.org/10.48550/arXiv.1706.03762"), {
      kind: "arxiv",
      id: "1706.03762",
    });
  });

  test("普通 DOI：剥掉 doi.org 前缀与 doi: 前缀", () => {
    assert.deepEqual(planQuery("10.1145/3292500.3330701"), { kind: "doi", doi: "10.1145/3292500.3330701" });
    assert.deepEqual(planQuery("https://doi.org/10.1145/3292500.3330701"), {
      kind: "doi",
      doi: "10.1145/3292500.3330701",
    });
    assert.deepEqual(planQuery("doi: 10.1145/3292500.3330701"), {
      kind: "doi",
      doi: "10.1145/3292500.3330701",
    });
  });

  test("其余都当标题", () => {
    assert.deepEqual(planQuery("Attention is all you need"), {
      kind: "text",
      text: "Attention is all you need",
    });
    // 年份开头的标题不该被误认成 arXiv 编号（arXiv 编号是 4 位年 + 点 + 4~5 位）
    assert.deepEqual(planQuery("2017. A year in review"), { kind: "text", text: "2017. A year in review" });
  });
});

describe("parseCrossrefWorks —— 真的接口形状", () => {
  test("HTML 标签与实体还原；缺字段的条目照样产出；没有标题的丢掉", () => {
    // 五条里两条没有标题（一条 title 是空数组、一条只有作者）：它们不产出空标题条目
    const results = parseCrossrefWorks(CROSSREF_BODY);
    assert.equal(results.length, 2);
    const [first, second] = results;
    assert.equal(first?.title, "Attention is All You Need & More");
    assert.deepEqual(first?.authors, ["Ashish Vaswani", "Google Brain"]);
    assert.equal(first?.year, "2017");
    assert.equal(first?.venue, "Advances in Neural Information Processing Systems");
    assert.equal(first?.type, "inproceedings");
    assert.equal(first?.doi, "10.5555/3295222.3295349");
    assert.equal(first?.volume, "30");
    assert.equal(first?.pages, "5998-6008");

    assert.equal(second?.title, "A Study of Nothing");
    assert.deepEqual(second?.authors, []);
    assert.equal(second?.year, null);
    assert.equal(second?.venue, null);
    assert.equal(second?.type, "article");
  });

  test("单条响应（/works/{doi}）：message 本身是一条 work", () => {
    const body = JSON.stringify({
      message: { title: ["Single Work"], DOI: "10.1/x", issued: { "date-parts": [["2020"]] } },
    });
    const results = parseCrossrefWorks(body);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.title, "Single Work");
    assert.equal(results[0]?.year, "2020");
  });

  test("坏 JSON / 空对象：不抛，回空数组", () => {
    assert.deepEqual(parseCrossrefWorks("<html>rate limited</html>"), []);
    assert.deepEqual(parseCrossrefWorks("{}"), []);
  });
});

describe("parseArxivFeed —— Atom", () => {
  test("编号去版本号、primary category、DOI；缺作者与日期不拦", () => {
    const results = parseArxivFeed(ARXIV_BODY);
    assert.equal(results.length, 2);
    const [first, second] = results;
    assert.equal(first?.title, "Attention Is All You Need");
    assert.equal(first?.arxivId, "1706.03762");
    assert.deepEqual(first?.authors, ["Ashish Vaswani", "Noam Shazeer"]);
    assert.equal(first?.year, "2017");
    assert.equal(first?.primaryClass, "cs.CL");
    assert.equal(first?.doi, "10.48550/arXiv.1706.03762");
    assert.equal(first?.type, "misc");
    assert.equal(first?.venue, "arXiv");

    // 第二条：实体还原、没有作者 / 日期、版本号仍去掉
    assert.equal(second?.title, "Fast & Slow: a study");
    assert.equal(second?.arxivId, "2401.12345");
    assert.deepEqual(second?.authors, []);
    assert.equal(second?.year, null);
  });

  test("没有 entry（接口报错时回 feed + error）：回空数组，不抛", () => {
    assert.deepEqual(parseArxivFeed("<feed><title>Error</title></feed>"), []);
  });
});

describe("searchCite —— 失败分类与缓存", () => {
  test("标题检索：两个来源并发取回，按标题去重", async () => {
    const urls: string[] = [];
    const request: CiteHttpRequest = (url) => {
      urls.push(url);
      return Promise.resolve(respond(url.includes("crossref") ? CROSSREF_BODY : ARXIV_BODY));
    };
    const outcome = await searchCite("attention is all you need cache-a", { request });
    assert.ok(outcome.ok);
    // Crossref 两条（两条没有标题的被丢掉）+ arXiv 两条
    assert.equal(outcome.results.length, 4);
    assert.equal(urls.length, 2);
    // 两个来源各有一条同名论文（本样本标题不同，先确认都留下了）
    assert.equal(outcome.results.filter((item) => item.source === "arxiv").length, 2);
  });

  test("同一条查询 10 分钟内只打一次网络", async () => {
    let calls = 0;
    const request: CiteHttpRequest = () => {
      calls += 1;
      return Promise.resolve(respond(ARXIV_BODY));
    };
    const first = await searchCite("attention is all you need cache-b", { request });
    const second = await searchCite("attention is all you need cache-b", { request });
    assert.ok(first.ok && second.ok);
    assert.equal(calls, 2);
    assert.deepEqual(second.results, first.results);
  });

  test("超时：TimeoutError → timeout", async () => {
    const request: CiteHttpRequest = () => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      return Promise.reject(error);
    };
    const outcome = await searchCite("timeout probe", { request });
    assert.deepEqual(outcome, { ok: false, reason: "timeout", detail: "The operation was aborted due to timeout" });
  });

  test("断网：fetch 的 cause.code=ENOTFOUND → offline", async () => {
    const request: CiteHttpRequest = () => {
      const inner = Object.assign(new Error("getaddrinfo ENOTFOUND api.crossref.org"), { code: "ENOTFOUND" });
      return Promise.reject(new TypeError("fetch failed", { cause: inner }));
    };
    const outcome = await searchCite("offline probe", { request });
    assert.ok(outcome.ok === false);
    assert.equal(outcome.reason, "offline");
    assert.equal(outcome.detail, "ENOTFOUND");
  });

  test("429 限流 → rate-limited", async () => {
    const request: CiteHttpRequest = () => Promise.resolve(respond("slow down", 429));
    const outcome = await searchCite("limit probe", { request });
    assert.deepEqual(outcome, { ok: false, reason: "rate-limited", detail: "429" });
  });

  test("标题检索只有一个来源挂掉：用另一个的结果，不报错", async () => {
    const request: CiteHttpRequest = (url) =>
      url.includes("crossref")
        ? Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) }))
        : Promise.resolve(respond(ARXIV_BODY));
    const outcome = await searchCite("partial failure probe", { request });
    assert.ok(outcome.ok);
    assert.equal(outcome.results.length, 2);
  });

  test("DOI 404 → not-found", async () => {
    const request: CiteHttpRequest = () => Promise.resolve(respond("not found", 404));
    const outcome = await searchCite("10.9999/does-not-exist", { request });
    assert.deepEqual(outcome, { ok: false, reason: "not-found", detail: "10.9999/does-not-exist" });
  });

  test("DOI 走 /works/{doi} 直达一条；arXiv 编号走 id_list", async () => {
    const urls: string[] = [];
    const request: CiteHttpRequest = (url) => {
      urls.push(url);
      return Promise.resolve(
        respond(url.includes("id_list") ? ARXIV_BODY : JSON.stringify({ message: { title: ["One"], DOI: "10.1/one" } })),
      );
    };
    const doi = await searchCite("10.1145/one", { request });
    assert.ok(doi.ok);
    assert.equal(doi.results.length, 1);
    assert.match(urls[0] ?? "", /api\.crossref\.org\/works\/10\.1145%2Fone$/);

    const arxiv = await searchCite("2401.99999", { request });
    assert.ok(arxiv.ok);
    assert.match(urls[1] ?? "", /id_list=2401\.99999/);
  });

  test("空查询不花网络", async () => {
    let calls = 0;
    const request: CiteHttpRequest = () => {
      calls += 1;
      return Promise.resolve(respond("{}"));
    };
    const outcome = await searchCite("   ", { request });
    assert.deepEqual(outcome, { ok: false, reason: "empty-query", detail: "" });
    assert.equal(calls, 0);
  });
});
