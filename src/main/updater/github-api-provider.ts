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
 * 三条实现约束：
 * - latest.yml 与安装包都从 `releases/assets/<id>` 取，必须带
 *   `Accept: application/octet-stream` 才会返回文件（否则 API 返回 JSON 元数据）；
 * - 资产地址不带扩展名，`findFile` 的 `.exe` 过滤会落到 `files[0]`（latest.yml 里只有
 *   一个安装包，成立）；缓存文件名因此由 `info.url` 回退（electron-updater 已有这条路径）；
 * - 差分下载的 blockmap 也用资产端点：新版 blockmap 在本次 Release 里按文件名找，旧版去
 *   `releases/tags/v<旧版本>` 找。任何一步找不到就抛错，库会退回完整下载——不会装坏。
 */
import type { ResolvedUpdateFileInfo, UpdateFileInfo, UpdateInfo } from "electron-updater";
import { Provider, getFileList, parseUpdateInfo, resolveFiles } from "electron-updater/out/providers/Provider.js";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider.js";

/** GitHub REST API。与网页域名分开：这是本 provider 存在的理由 */
const API_ORIGIN = "https://api.github.com";

/** 读 JSON 元数据（releases/latest、releases/tags/...） */
const JSON_ACCEPT = "application/vnd.github+json";

/** 读发布资产（latest.yml、安装包、blockmap）：不带这个头，API 只会回 JSON 元数据 */
const ASSET_ACCEPT = "application/octet-stream";

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

/** 从 setFeedURL 的 options 里取仓址：唯一真源是 package.json 的 build.publish（见 releases-url.ts） */
function repositoryOf(options: unknown): { owner: string; repo: string } {
  if (!isRecord(options)) throw new Error("GitHub API provider 缺少 owner / repo。");
  const { owner, repo } = options;
  if (typeof owner !== "string" || owner === "" || typeof repo !== "string" || repo === "") {
    throw new Error("GitHub API provider 缺少 owner / repo。");
  }
  return { owner, repo };
}

export class GitHubApiProvider extends Provider<UpdateInfo> {
  private readonly base: string;
  /** 本次检查的那份 Release：latest.yml 的资产映射与 blockmap 查找都从这里来 */
  private release: GitHubRelease | null = null;
  /** 资产 URL → 文件名：getBlockMapFiles 只拿得到 URL，靠这张表找回安装包名 */
  private readonly namesByAssetUrl = new Map<string, string>();
  /** 旧版本的 Release（差分下载才用；按 tag 缓存，一次下载最多问一次） */
  private readonly releasesByTag = new Map<string, GitHubRelease>();

  constructor(options: unknown, _updater: unknown, runtimeOptions: ProviderRuntimeOptions) {
    super(runtimeOptions);
    const { owner, repo } = repositoryOf(options);
    this.base = `${API_ORIGIN}/repos/${owner}/${repo}`;
  }

  /** 下载安装包 / blockmap 时统一带资产头；否则 API 回 JSON */
  override get fileExtraDownloadHeaders(): Record<string, string> {
    return { accept: ASSET_ACCEPT };
  }

  /** GitHub 的资产走对象存储（重定向后是签名 URL），多段 Range 合并请求不可靠（同库的 GitHubProvider） */
  override get isUseMultipleRangeRequest(): boolean {
    return false;
  }

  async getLatestVersion(): Promise<UpdateInfo> {
    const release = asRelease(await this.fetchJson(`${this.base}/releases/latest`));
    this.release = release;
    this.namesByAssetUrl.clear();
    const byName = new Map<string, GitHubAsset>();
    for (const asset of release.assets) {
      byName.set(asset.name, asset);
      this.namesByAssetUrl.set(this.assetUrl(asset.id).href, asset.name);
    }

    const channelFile = `${this.getDefaultChannelName()}.yml`;
    const channelAsset = byName.get(channelFile);
    if (channelAsset === undefined) {
      throw tagged(
        new Error(`${release.tag_name} 里没有 ${channelFile}（发布产物没传全）。`),
        "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
      );
    }

    const raw = await this.httpRequest(this.assetUrl(channelAsset.id), { accept: ASSET_ACCEPT });
    if (raw === null) {
      throw tagged(new Error(`${channelFile} 是空的。`), "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND");
    }
    const info = parseUpdateInfo(raw, channelFile, this.assetUrl(channelAsset.id));
    const files = getFileList(info).map((file) => this.toAssetFile(file, byName));
    return { ...info, files };
  }

  resolveFiles(updateInfo: UpdateInfo): ResolvedUpdateFileInfo[] {
    // 文件地址在 getLatestVersion 里已经换成绝对资产地址；base 只是让相对地址也有个家
    return resolveFiles(updateInfo, new URL(`${this.base}/releases/assets/`));
  }

  /**
   * 差分下载要的两份 blockmap。新版在本 Release 里按「安装包名.blockmap」找；
   * 旧版去 `releases/tags/v<旧版本>` 找同名文件。找不到就抛——库退回完整下载。
   */
  override async getBlockMapFiles(baseUrl: URL, oldVersion: string, newVersion: string): Promise<URL[]> {
    const fileName = this.namesByAssetUrl.get(baseUrl.href);
    if (fileName === undefined || this.release === null) {
      throw tagged(new Error("找不到本次发布对应的安装包资产。"), "ERR_UPDATER_ASSET_NOT_FOUND");
    }
    const newBlock = this.release.assets.find((asset) => asset.name === `${fileName}.blockmap`);
    if (newBlock === undefined) {
      throw tagged(new Error(`本次发布没有 ${fileName}.blockmap。`), "ERR_UPDATER_ASSET_NOT_FOUND");
    }

    const oldRelease = await this.releaseOfTag(`v${oldVersion}`);
    const oldFileName = fileName.replace(newVersion, oldVersion);
    const oldBlock = oldRelease.assets.find((asset) => asset.name === `${oldFileName}.blockmap`);
    if (oldBlock === undefined) {
      throw tagged(new Error(`v${oldVersion} 没有 ${oldFileName}.blockmap。`), "ERR_UPDATER_ASSET_NOT_FOUND");
    }
    return [this.assetUrl(oldBlock.id), this.assetUrl(newBlock.id)];
  }

  private toAssetFile(file: UpdateFileInfo, byName: Map<string, GitHubAsset>): UpdateFileInfo {
    const asset = byName.get(file.url);
    if (asset === undefined) {
      throw tagged(new Error(`Release 里没有更新文件 ${file.url}。`), "ERR_UPDATER_ASSET_NOT_FOUND");
    }
    return { ...file, url: this.assetUrl(asset.id).href };
  }

  private async releaseOfTag(tag: string): Promise<GitHubRelease> {
    const cached = this.releasesByTag.get(tag);
    if (cached !== undefined) return cached;
    const release = asRelease(await this.fetchJson(`${this.base}/releases/tags/${encodeURIComponent(tag)}`));
    this.releasesByTag.set(tag, release);
    return release;
  }

  private assetUrl(id: number): URL {
    return new URL(`${this.base}/releases/assets/${id}`);
  }

  private async fetchJson(url: string): Promise<unknown> {
    const raw = await this.httpRequest(new URL(url), { accept: JSON_ACCEPT });
    if (raw === null) throw new Error(`GitHub API 返回空响应：${url}`);
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`GitHub API 返回的不是 JSON：${url}`);
    }
  }
}
