/**
 * GitHub API provider 的测试（updater/github-api-provider.ts）。
 *
 * 用替身 transport 钉住四件事：
 * - 检查更新只打 `api.github.com`，**不碰 github.com**（issue #283：网页域名被拦、API 仍通）；
 * - **文件名保持发布资产原名（带 .exe）**，资产端点地址只在 `resolveFiles()` 里出现——
 *   返工前在检查阶段就改写文件名，库拿不到后缀，下载下来叫资产编号、NSIS 装不上；
 * - latest.yml 与安装包都从发布资产端点取，且必须带 `Accept: application/octet-stream`；
 * - 发布里缺 channel 文件 / 安装包 / blockmap 时抛出可分类的错误码，让库退回完整下载；
 * - 更新器与「历史版本」列表**共用同一个客户端**：同一份 latest.yml 只取一次。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor.js";
import { GitHubApiProvider } from "./github-api-provider.ts";
import {
  GitHubClient,
  type GitHubResponse,
  type GitHubTransport,
} from "./github-client.ts";
import { createRecentReleases } from "./recent-releases.ts";

const RELEASE = {
  tag_name: "v0.2.0",
  assets: [
    { id: 11, name: "latest.yml", size: 200 },
    { id: 12, name: "orbita-0.2.0-win-x64-setup.exe", size: 177_819_819 },
    { id: 13, name: "orbita-0.2.0-win-x64-setup.exe.blockmap", size: 185_003 },
  ],
};

const LATEST_YML = [
  "version: 0.2.0",
  "files:",
  "  - url: orbita-0.2.0-win-x64-setup.exe",
  "    sha512: abc",
  "    size: 177819819",
  "path: orbita-0.2.0-win-x64-setup.exe",
  "sha512: abc",
  "releaseDate: '2026-10-22T00:00:00.000Z'",
  "",
].join("\n");

const INSTALLER = "orbita-0.2.0-win-x64-setup.exe";

const LATEST_API = "https://api.github.com/repos/xuanji-lab/orbita/releases/latest";
const RELEASES_API = "https://api.github.com/repos/xuanji-lab/orbita/releases";

interface RecordedRequest {
  url: string;
  accept: string | null;
}

function assetUrl(id: number): string {
  return `https://api.github.com/repos/xuanji-lab/orbita/releases/assets/${id}`;
}

/** 按地址前缀作答的 transport 替身（最长前缀优先：资产地址本身也以 releases 端点开头）；
 * 没登记的地址回 404（与 HttpError 的 code 对齐） */
function stubTransport(
  calls: RecordedRequest[],
  routes: Record<string, { body: string; status?: number }>,
): GitHubTransport {
  return async ({ url, headers }) => {
    calls.push({ url: url.href, accept: headers.accept ?? null });
    const matched = Object.keys(routes)
      .filter((prefix) => url.href.startsWith(prefix))
      .sort((left, right) => right.length - left.length)[0];
    const route = matched === undefined ? undefined : routes[matched];
    const response: GitHubResponse =
      route === undefined
        ? { status: 404, headers: {}, body: JSON.stringify({ message: "Not Found" }) }
        : { status: route.status ?? 200, headers: {}, body: route.body };
    return response;
  };
}

/** provider 的 runtimeOptions：元数据不再走 executor，给个不会用到的空壳 */
function makeProvider(client: GitHubClient): GitHubApiProvider {
  return new GitHubApiProvider(
    { provider: "custom", owner: "xuanji-lab", repo: "orbita", client },
    {},
    { isUseMultipleRangeRequest: true, platform: "win32", executor: {} as ElectronHttpExecutor },
  );
}

describe("GitHubApiProvider —— 检查更新", () => {
  test("文件名保持资产原名（.exe），资产地址只在 resolveFiles 里解析", async () => {
    const calls: RecordedRequest[] = [];
    const client = new GitHubClient({
      transport: stubTransport(calls, {
        [LATEST_API]: { body: JSON.stringify(RELEASE) },
        [assetUrl(11)]: { body: LATEST_YML },
      }),
    });
    const provider = makeProvider(client);

    const info = await provider.getLatestVersion();
    assert.equal(info.version, "0.2.0");
    // 检查更新拿到的 FileInfo 就是 latest.yml 里那一行：带 .exe 的原名
    assert.equal(info.files?.[0]?.url, INSTALLER);
    assert.equal(info.files?.[0]?.size, 177_819_819);
    // 库用 info.url 推缓存文件名：它必须仍以 .exe 结尾（返工前这里是资产编号）
    assert.ok(info.files?.[0]?.url.endsWith(".exe"));

    // 真正下载时才换地址：resolved.url 是资产端点，info 原样带出
    const resolved = provider.resolveFiles(info);
    assert.equal(resolved[0]?.url.href, assetUrl(12));
    assert.equal(resolved[0]?.info.url, INSTALLER);
    assert.ok(resolved[0]?.info.url.endsWith(".exe"));

    // 检查更新一次请求：Release 元数据 + latest.yml；没有任何 github.com 请求
    assert.deepEqual(
      calls.map((call) => call.url),
      [LATEST_API, assetUrl(11)],
    );
    assert.equal(calls[0]?.accept, "application/vnd.github+json");
    // 资产端点必须声明要文件，否则 GitHub 回 JSON 元数据
    assert.equal(calls[1]?.accept, "application/octet-stream");
  });

  test("每次检查都真的问一次版本（不吃缓存），latest.yml 可以走缓存", async () => {
    const calls: RecordedRequest[] = [];
    const client = new GitHubClient({
      transport: stubTransport(calls, {
        [LATEST_API]: { body: JSON.stringify(RELEASE) },
        [assetUrl(11)]: { body: LATEST_YML },
      }),
    });
    const provider = makeProvider(client);
    await provider.getLatestVersion();
    await provider.getLatestVersion();
    assert.deepEqual(
      calls.map((call) => call.url),
      [LATEST_API, assetUrl(11), LATEST_API],
      "版本端点两次都打，latest.yml 第二次命中共享缓存",
    );
  });

  test("下载安装包时带资产头（库从 provider 取 fileExtraDownloadHeaders）", () => {
    const provider = makeProvider(new GitHubClient({ transport: stubTransport([], {}) }));
    assert.deepEqual(provider.fileExtraDownloadHeaders, { accept: "application/octet-stream" });
    // 对象存储不支持多段 Range 合并（同 electron-updater 的 GitHubProvider）
    assert.equal(provider.isUseMultipleRangeRequest, false);
  });

  test("Release 里没有 latest.yml → ERR_UPDATER_CHANNEL_FILE_NOT_FOUND", async () => {
    const client = new GitHubClient({
      transport: stubTransport([], {
        [LATEST_API]: {
          body: JSON.stringify({ ...RELEASE, assets: [{ id: 12, name: INSTALLER, size: 1 }] }),
        },
      }),
    });
    await assert.rejects(makeProvider(client).getLatestVersion(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND");
      return true;
    });
  });

  test("latest.yml 列了发布里没有的安装包 → resolveFiles 抛 ERR_UPDATER_ASSET_NOT_FOUND", async () => {
    const client = new GitHubClient({
      transport: stubTransport([], {
        [LATEST_API]: {
          body: JSON.stringify({ ...RELEASE, assets: [{ id: 11, name: "latest.yml", size: 200 }] }),
        },
        [assetUrl(11)]: { body: LATEST_YML },
      }),
    });
    const provider = makeProvider(client);
    const info = await provider.getLatestVersion();
    assert.throws(() => provider.resolveFiles(info), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "ERR_UPDATER_ASSET_NOT_FOUND");
      return true;
    });
  });

  test("没有 owner/repo 或没有共享客户端就直接失败（不猜仓址、不另起一套网络）", () => {
    assert.throws(
      () =>
        new GitHubApiProvider(
          { provider: "custom" },
          {},
          {
            isUseMultipleRangeRequest: true,
            platform: "win32",
            executor: undefined as unknown as ElectronHttpExecutor,
          },
        ),
      /owner \/ repo/,
    );
    assert.throws(
      () =>
        new GitHubApiProvider(
          { provider: "custom", owner: "xuanji-lab", repo: "orbita" },
          {},
          {
            isUseMultipleRangeRequest: true,
            platform: "win32",
            executor: undefined as unknown as ElectronHttpExecutor,
          },
        ),
      /共享 GitHub 客户端/,
    );
  });
});

describe("GitHubApiProvider —— 与历史版本列表共用客户端", () => {
  test("同一份 latest.yml 只取一次：列表读到的说明用的是更新器刚缓存的原文", async () => {
    const calls: RecordedRequest[] = [];
    const client = new GitHubClient({
      transport: stubTransport(calls, {
        [LATEST_API]: { body: JSON.stringify(RELEASE) },
        [RELEASES_API]: {
          body: JSON.stringify([
            {
              tag_name: "v0.2.0",
              name: "0.2.0",
              published_at: "2026-10-22T00:00:00Z",
              html_url: "https://github.com/xuanji-lab/orbita/releases/tag/v0.2.0",
              assets: [
                { id: 11, name: "latest.yml", browser_download_url: "https://example.com/latest.yml" },
              ],
            },
          ]),
        },
        [assetUrl(11)]: { body: LATEST_YML.replace("releaseDate", "releaseNotes: 这版说明\nreleaseDate") },
      }),
    });

    await makeProvider(client).getLatestVersion();
    const recent = createRecentReleases({ client });
    const result = await recent.recent();
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.releases[0]?.notes : null, [{ icon: null, text: "这版说明" }]);
    assert.equal(
      calls.filter((call) => call.url === assetUrl(11)).length,
      1,
      "latest.yml 由共享客户端缓存：列表直接命中更新器刚取的那份",
    );
  });
});

describe("GitHubApiProvider —— 差分下载的 blockmap", () => {
  test("新版在本次 Release 找，旧版去 releases/tags/v<旧版本> 找", async () => {
    const calls: RecordedRequest[] = [];
    const client = new GitHubClient({
      transport: stubTransport(calls, {
        [LATEST_API]: { body: JSON.stringify(RELEASE) },
        [assetUrl(11)]: { body: LATEST_YML },
        "https://api.github.com/repos/xuanji-lab/orbita/releases/tags/v0.1.16": {
          body: JSON.stringify({
            tag_name: "v0.1.16",
            assets: [{ id: 21, name: "orbita-0.1.16-win-x64-setup.exe.blockmap", size: 1 }],
          }),
        },
      }),
    });

    const provider = makeProvider(client);
    const info = await provider.getLatestVersion();
    const installer = provider.resolveFiles(info)[0];
    assert.ok(installer !== undefined);
    const blocks = await provider.getBlockMapFiles(installer.url, "0.1.16", "0.2.0");
    assert.deepEqual(
      blocks.map((url) => url.href),
      [assetUrl(21), assetUrl(13)],
    );
    assert.ok(calls.some((call) => call.url.endsWith("/releases/tags/v0.1.16")));
  });

  test("旧版本没有 blockmap → 抛错（库退回完整下载）", async () => {
    const client = new GitHubClient({
      transport: stubTransport([], {
        [LATEST_API]: { body: JSON.stringify(RELEASE) },
        [assetUrl(11)]: { body: LATEST_YML },
        "https://api.github.com/repos/xuanji-lab/orbita/releases/tags/v0.1.16": {
          body: JSON.stringify({ tag_name: "v0.1.16", assets: [] }),
        },
      }),
    });
    const provider = makeProvider(client);
    const info = await provider.getLatestVersion();
    const installer = provider.resolveFiles(info)[0];
    assert.ok(installer !== undefined);
    await assert.rejects(provider.getBlockMapFiles(installer.url, "0.1.16", "0.2.0"), /blockmap/);
  });
});
