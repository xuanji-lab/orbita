/**
 * 实验功能清单的账：这张表是设置页的「更新日志」，也是转正时整理正式更新说明的底稿，
 * 坏一条就是用户看到一行空白或错乱的历史。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EXPERIMENTAL_FEATURES, pullRequestUrl } from "./experimental-features.ts";

describe("EXPERIMENTAL_FEATURES", () => {
  it("id 唯一，名字与说明中英俱全", () => {
    const ids = EXPERIMENTAL_FEATURES.map((feature) => feature.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const feature of EXPERIMENTAL_FEATURES) {
      for (const text of [feature.name, feature.summary]) {
        assert.ok(text.zh.trim() !== "" && text.en.trim() !== "", feature.id);
      }
    }
  });

  it("每项至少一条日志；日期合法且按时间顺序；PR 号是正整数或 null；文案中英俱全", () => {
    for (const feature of EXPERIMENTAL_FEATURES) {
      assert.ok(feature.changelog.length > 0, `${feature.id} 没有日志`);
      let previous = "";
      for (const entry of feature.changelog) {
        assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/, feature.id);
        assert.ok(!Number.isNaN(Date.parse(entry.date)), `${feature.id} ${entry.date}`);
        assert.ok(entry.date >= previous, `${feature.id} 的日志要按时间顺序：${entry.date} < ${previous}`);
        previous = entry.date;
        assert.ok(entry.pr === null || (Number.isInteger(entry.pr) && entry.pr > 0), `${feature.id} PR ${entry.pr}`);
        assert.ok(entry.note.zh.trim() !== "" && entry.note.en.trim() !== "", `${feature.id} ${entry.date}`);
      }
    }
  });

  it("PR 链接指向仓库的 PR 页", () => {
    assert.equal(pullRequestUrl(184), "https://github.com/xuanji-lab/orbita/pull/184");
  });
});
