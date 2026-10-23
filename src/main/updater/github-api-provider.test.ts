/**
 * GitHub API provider 的测试（updater/github-api-provider.ts）。
 *
 * 用替身 executor 钉住三件事：
 * - 检查更新只打 `api.github.com`，**不碰 github.com**（issue #283：网页域名被拦、API 仍通）；
 * - latest.yml 与安装包都从发布资产端点取，且下载要带 `Accept: application/octet-stream`；
 * - 发布里缺 channel 文件 / 安装包 / blockmap 时抛出可分类的错误码，让库退回完整下载。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { OutgoingHttpHeaders, RequestOptions } from "node:http";
import type { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor.js";
import { GitHubApiProvider } from "./github-api-provider.ts";

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

interface RecordedRequest {
  url: string;
  accept: string | null;
}

function assetUrl(id: number): string {
  return `https://api.github.com/repos/xuanji-lab/orbita/releases/assets/${id}`;
}

/** 按地址前缀作答的 executor 替身；没登记的地址抛 404（与 HttpError 的 code 对齐） */
function stubExecutor(
  calls: RecordedRequest[],
  routes: Record<string, string | null>,
  statuses: Record<string, number> = {},
): ElectronHttpExecutor {
  return {
    request: async (options: RequestOptions) => {
      const url = `https://${options.hostname}${options.path ?? ""}`;
      const headers = Array.isArray(options.headers)
        ? {}
        : (options.headers as OutgoingHttpHeaders | undefined) ?? {};
      const accept = typeof headers.accept === "string" ? headers.accept : null;
      calls.push({ url, accept });
      const matched = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
      if (matched === undefined) {
        const error = new Error(`HTTP_ERROR_404 ${url}`) as Error & { statusCode?: number; code?: string };
        error.statusCode = 404;
        error.code = "HTTP_ERROR_404";
        throw error;
      }
      const status = statuses[matched[0]];
      if (status !== undefined) {
        const error = new Error(`HTTP_ERROR_${status} ${url}`) as Error & { statusCode?: number; code?: string };
        error.statusCode = status;
        error.code = `HTTP_ERROR_${status}`;
        throw error;
      }
      return matched[1];
    },
  } as unknown as ElectronHttpExecutor;
}

function makeProvider(executor: ElectronHttpExecutor): GitHubApiProvider {
  return new GitHubApiProvider(
    { provider: "custom", owner: "xuanji-lab", repo: "orbita" },
    {},
    { isUseMultipleRangeRequest: true, platform: "win32", executor },
  );
}

describe("GitHubApiProvider —— 检查更新", () => {
  test("只打 api.github.com，latest.yml 与安装包都改写成发布资产地址", async () => {
    const calls: RecordedRequest[] = [];
    const provider = makeProvider(
      stubExecutor(calls, {
        "https://api.github.com/repos/xuanji-lab/orbita/releases/latest": JSON.stringify(RELEASE),
        [assetUrl(11)]: LATEST_YML,
      }),
    );

    const info = await provider.getLatestVersion();
    assert.equal(info.version, "0.2.0");
    assert.equal(info.files?.[0]?.url, assetUrl(12));
    assert.equal(info.files?.[0]?.size, 177_819_819);

    // 检查更新一次请求：Release 元数据 + latest.yml；没有任何 github.com 请求
    assert.deepEqual(
      calls.map((call) => call.url),
      [
        "https://api.github.com/repos/xuanji-lab/orbita/releases/latest",
        assetUrl(11),
      ],
    );
    // 资产端点必须声明要文件，否则 GitHub 回 JSON 元数据
    assert.equal(calls[1]?.accept, "application/octet-stream");

    const resolved = provider.resolveFiles(info);
    assert.equal(resolved[0]?.url.href, assetUrl(12));
  });

  test("下载安装包时带资产头（库从 provider 取 fileExtraDownloadHeaders）", () => {
    const provider = makeProvider(stubExecutor([], {}));
    assert.deepEqual(provider.fileExtraDownloadHeaders, { accept: "application/octet-stream" });
    // 对象存储不支持多段 Range 合并（同 electron-updater 的 GitHubProvider）
    assert.equal(provider.isUseMultipleRangeRequest, false);
  });

  test("Release 里没有 latest.yml → ERR_UPDATER_CHANNEL_FILE_NOT_FOUND", async () => {
    const provider = makeProvider(
      stubExecutor([], {
        "https://api.github.com/repos/xuanji-lab/orbita/releases/latest": JSON.stringify({
          ...RELEASE,
          assets: [{ id: 12, name: "orbita-0.2.0-win-x64-setup.exe", size: 1 }],
        }),
      }),
    );
    await assert.rejects(provider.getLatestVersion(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND");
      return true;
    });
  });

  test("latest.yml 列了发布里没有的安装包 → ERR_UPDATER_ASSET_NOT_FOUND", async () => {
    const provider = makeProvider(
      stubExecutor([], {
        "https://api.github.com/repos/xuanji-lab/orbita/releases/latest": JSON.stringify({
          ...RELEASE,
          assets: [{ id: 11, name: "latest.yml", size: 200 }],
        }),
        [assetUrl(11)]: LATEST_YML,
      }),
    );
    await assert.rejects(provider.getLatestVersion(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "ERR_UPDATER_ASSET_NOT_FOUND");
      return true;
    });
  });

  test("没有 owner/repo 就直接失败（不猜一个仓址）", () => {
    assert.throws(
      () =>
        new GitHubApiProvider(
          { provider: "custom" },
          {},
          { isUseMultipleRangeRequest: true, platform: "win32", executor: stubExecutor([], {}) },
        ),
      /owner \/ repo/,
    );
  });
});

describe("GitHubApiProvider —— 差分下载的 blockmap", () => {
  test("新版在本次 Release 找，旧版去 releases/tags/v<旧版本> 找", async () => {
    const calls: RecordedRequest[] = [];
    const provider = makeProvider(
      stubExecutor(calls, {
        "https://api.github.com/repos/xuanji-lab/orbita/releases/latest": JSON.stringify(RELEASE),
        [assetUrl(11)]: LATEST_YML,
        "https://api.github.com/repos/xuanji-lab/orbita/releases/tags/v0.1.16": JSON.stringify({
          tag_name: "v0.1.16",
          assets: [{ id: 21, name: "orbita-0.1.16-win-x64-setup.exe.blockmap", size: 1 }],
        }),
      }),
    );

    const info = await provider.getLatestVersion();
    const installer = info.files?.[0];
    assert.ok(installer !== undefined);
    const blocks = await provider.getBlockMapFiles(new URL(installer.url), "0.1.16", "0.2.0");
    assert.deepEqual(
      blocks.map((url) => url.href),
      [assetUrl(21), assetUrl(13)],
    );
    assert.ok(calls.some((call) => call.url.endsWith("/releases/tags/v0.1.16")));
  });

  test("旧版本没有 blockmap → 抛错（库退回完整下载）", async () => {
    const provider = makeProvider(
      stubExecutor([], {
        "https://api.github.com/repos/xuanji-lab/orbita/releases/latest": JSON.stringify(RELEASE),
        [assetUrl(11)]: LATEST_YML,
        "https://api.github.com/repos/xuanji-lab/orbita/releases/tags/v0.1.16": JSON.stringify({
          tag_name: "v0.1.16",
          assets: [],
        }),
      }),
    );
    const info = await provider.getLatestVersion();
    const installer = info.files?.[0];
    assert.ok(installer !== undefined);
    await assert.rejects(provider.getBlockMapFiles(new URL(installer.url), "0.1.16", "0.2.0"), /blockmap/);
  });
});
