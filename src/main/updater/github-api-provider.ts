/**
 * GitHub Releases 的更新信息与安装包，走 REST API 与发布资产端点。
 *
 * **为什么不用 electron-updater 自带的 GitHub provider**：它先读
 * `https://github.com/<owner>/<repo>/releases.atom`，安装包地址也是
 * `github.com/.../releases/download/...`（重定向到 objects.githubusercontent.com）。
 * 这几个域名在部分网络被拦，而 `api.github.com` 与 `release-assets.githubusercontent.com`
 * 仍然可达。同一份 Release 换一条入口，用户就不必先开代理才能检查更新（issue #283：
 * 直连 github.com 挂起，加 --proxy-server 后整条链路才通）。
 *
 * **更新源没有变**：owner/repo 仍来自 package.json 的 `build.publish`（见 releases-url.ts），
 * 不做镜像、不留第二份真源。这里只是把「怎么读 Release」从网页换到 GitHub 自己的 API。
 *
 * 四条实现约束：
 *
 * 1. **所有请求都经共享客户端**（github-client.ts）：同一套网络 / 代理 / 缓存 / 限流记录，
 *    与「历史版本」列表是同一个实例。
 * 2. **`latest.yml` 里的文件名一律不改写**。`UpdateInfo.files[].url` 保持发布资产的原名
 *    （`orbita-0.1.16-win-x64-setup.exe`），资产端点地址只在 `resolveFiles()` 里给到
 *    `ResolvedUpdateFileInfo.url`。以前在检查更新阶段就把文件名换成 `releases/assets/<id>`，
 *    库拿不到 `.exe` 后缀，缓存文件名退成资产编号（下载下来叫 `668422282`，NSIS 装不上）。
 * 3. **资产端点必须带 `Accept: application/octet-stream`**，否则 GitHub 回 JSON 元数据。
 *    `fileExtraDownloadHeaders` 管库的下载与 blockmap；差分下载的 Range 请求是库写死
 *    通配 Accept 的（`DifferentialDownloader.createRequestOptions`），由下载器
 *    （resilient-executor.ts）按地址把资产头补回去。实测不带这个头，资产端点回
 *    **206 + JSON**，分段长度对得上、内容对不上，要等 sha512 才失败。
 * 4. **差分下载的 blockmap 也用资产端点**：新版在本次 Release 里按「安装包名.blockmap」找，
 *    旧版去 `releases/tags/v<旧版本>` 找。任何一步找不到就抛错，库会退回完整下载——不会装坏。
 */
import type { ResolvedUpdateFileInfo, UpdateFileInfo, UpdateInfo } from "electron-updater";
import { parseUpdateInfo, resolveFiles, Provider } from "electron-updater/out/providers/Provider.js";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider.js";
import { API_ORIGIN, GitHubClient } from "./github-client.ts";

/** API 只给得出这几个字段；其余（body / html_url）用不上，不声明 */
interface GitHubAsset {
  id: number;
  name: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
}

/** 带错误码的 Error：failure.ts 按 code 分类，界面据此出文案 */
function tagged(error: Error, code: string): Error {
  return Object.assign(error, { code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** API 返回的形状不对（改过端点 / 代理塞了错误页）时当失败，不猜 */
function asRelease(value: unknown): GitHubRelease {
  if (!isRecord(value) || typeof value.tag_name !== "string" || !Array.isArray(value.assets)) {
    throw new Error("GitHub API 返回的 Release 形状不对（缺 tag_name / assets）。");
  }
  const assets: GitHubAsset[] = [];
  for (const entry of value.assets) {
    if (!isRecord(entry)) continue;
    if (typeof entry.id !== "number" || typeof entry.name !== "string") continue;
    assets.push({
      id: entry.id,
      name: entry.name,
      size: typeof entry.size === "number" ? entry.size : 0,
    });
  }
  return { tag_name: value.tag_name, assets };
}

/** setFeedURL 的 options：仓址 + 共享客户端（service.ts 注入，「历史版本」列表用的是同一个） */
function repositoryOf(options: unknown): { owner: string; repo: string; client: GitHubClient } {
  if (!isRecord(options)) throw new Error("GitHub API provider 缺少 owner / repo。");
  const { owner, repo, client } = options;
  if (typeof owner !== "string" || owner === "" || typeof repo !== "string" || repo === "") {
    throw new Error("GitHub API provider 缺少 owner / repo。");
  }
  if (!(client instanceof GitHubClient)) {
    throw new Error("GitHub API provider 缺少共享 GitHub 客户端（见 github-client.ts）。");
  }
  return { owner, repo, client };
}

export class GitHubApiProvider extends Provider<UpdateInfo> {
  private readonly base: string;
  private readonly client: GitHubClient;
  /** 本次检查的那份 Release 的资产表（按文件名 / 按解析后的资产地址各一份） */
  private assetsByName = new Map<string, GitHubAsset>();
  private assetsByUrl = new Map<string, GitHubAsset>();

  constructor(options: unknown, _updater: unknown, runtimeOptions: ProviderRuntimeOptions) {
    super(runtimeOptions);
    const { owner, repo, client } = repositoryOf(options);
    this.base = `${API_ORIGIN}/repos/${owner}/${repo}`;
    this.client = client;
  }

  /** 下载安装包 / blockmap 时统一带资产头；否则 API 回 JSON */
  override get fileExtraDownloadHeaders(): Record<string, string> {
    return { accept: "application/octet-stream" };
  }

  /** GitHub 的资产走对象存储（重定向后是签名 URL），多段 Range 合并请求不可靠（同库的 GitHubProvider） */
  override get isUseMultipleRangeRequest(): boolean {
    return false;
  }

  async getLatestVersion(): Promise<UpdateInfo> {
    // 用户点「检查更新」就该真的问一次：版本发现不走缓存
    const release = asRelease(await this.client.getJson(`${this.base}/releases/latest`, { cache: false }));
    this.assetsByName = new Map();
    this.assetsByUrl = new Map();
    for (const asset of release.assets) {
      this.assetsByName.set(asset.name, asset);
      this.assetsByUrl.set(this.assetUrl(asset.id).href, asset);
    }

    const channelFile = `${this.getDefaultChannelName()}.yml`;
    const channelAsset = this.assetsByName.get(channelFile);
    if (channelAsset === undefined) {
      throw tagged(
        new Error(`${release.tag_name} 里没有 ${channelFile}（发布产物没传全）。`),
        "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
      );
    }

    const raw = await this.client.getAsset(this.assetUrl(channelAsset.id));
    if (raw === "") {
      throw tagged(new Error(`${channelFile} 是空的。`), "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND");
    }
    // files 保持 latest.yml 里的原名（约束 2）：资产地址在 resolveFiles 里才出现
    return parseUpdateInfo(raw, channelFile, this.assetUrl(channelAsset.id));
  }

  /**
   * 文件名 → 资产端点。`info` 原样带出（库用 `info.url` 推缓存文件名、比对已下载的包），
   * `url` 才是真正下载时用的地址。
   *
   * 注：URL 末段是资产编号，`findFile` 的 `.exe` 过滤会落到 `files[0]`（latest.yml 里
   * 只有一个安装包，成立；本区分支也只接线 Windows NSIS 安装包）。
   */
  resolveFiles(updateInfo: UpdateInfo): ResolvedUpdateFileInfo[] {
    // base 只是让相对地址也有个家；地址由 pathTransformer 换成资产编号
    return resolveFiles(updateInfo, new URL(`${this.base}/releases/assets/`), (name) => {
      const asset = this.assetsByName.get(name);
      if (asset === undefined) {
        throw tagged(new Error(`Release 里没有更新文件 ${name}。`), "ERR_UPDATER_ASSET_NOT_FOUND");
      }
      return String(asset.id);
    });
  }

  /**
   * 差分下载要的两份 blockmap。新版在本 Release 里按「安装包名.blockmap」找；
   * 旧版去 `releases/tags/v<旧版本>` 找同名文件。找不到就抛——库退回完整下载。
   */
  override async getBlockMapFiles(baseUrl: URL, oldVersion: string, newVersion: string): Promise<URL[]> {
    const asset = this.assetsByUrl.get(baseUrl.href);
    if (asset === undefined) {
      throw tagged(new Error("找不到本次发布对应的安装包资产。"), "ERR_UPDATER_ASSET_NOT_FOUND");
    }
    const newBlock = this.assetsByName.get(`${asset.name}.blockmap`);
    if (newBlock === undefined) {
      throw tagged(new Error(`本次发布没有 ${asset.name}.blockmap。`), "ERR_UPDATER_ASSET_NOT_FOUND");
    }

    const oldTag = `v${oldVersion}`;
    const oldRelease = asRelease(
      await this.client.getJson(`${this.base}/releases/tags/${encodeURIComponent(oldTag)}`),
    );
    const oldFileName = asset.name.replace(newVersion, oldVersion);
    const oldBlock = oldRelease.assets.find((entry) => entry.name === `${oldFileName}.blockmap`);
    if (oldBlock === undefined) {
      throw tagged(new Error(`${oldTag} 没有 ${oldFileName}.blockmap。`), "ERR_UPDATER_ASSET_NOT_FOUND");
    }
    return [this.assetUrl(oldBlock.id), this.assetUrl(newBlock.id)];
  }

  private assetUrl(id: number): URL {
    return new URL(`${this.base}/releases/assets/${id}`);
  }
}
