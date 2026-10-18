/**
 * Release 页基址（updater/releases-url.ts）的测试。
 *
 * 这里钉的不是「地址长什么样」，而是**它只有一份真源**：期望值自己从 package.json 的
 * build.publish 算出来，而不是在测试里再抄一遍仓址——否则改了 package.json、链接却指着
 * 旧的仓，测试反而会替那份漂移背书。同时钉住与 tag 拼接的接口（界面「查看说明」用它）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { releaseTagUrl } from "../../shared/updater.ts";
import packageJson from "../../../package.json" with { type: "json" };
import { releasesUrl } from "./releases-url.ts";

describe("releasesUrl —— 与 package.json 的 build.publish 同源", () => {
  test("owner/repo 来自 build.publish，拼出 github 的 releases 页", () => {
    const publish = packageJson.build.publish[0];
    assert.ok(publish !== undefined, "package.json 里要有 build.publish（自动更新的更新源）");
    assert.equal(releasesUrl(), `https://github.com/${publish.owner}/${publish.repo}/releases`);
  });

  test("拿它拼「查看说明」的地址：tag 是 v<版本号>", () => {
    const base = releasesUrl();
    assert.ok(base !== null);
    assert.equal(releaseTagUrl(base, "0.1.15"), `${base}/tag/v0.1.15`);
  });
});
