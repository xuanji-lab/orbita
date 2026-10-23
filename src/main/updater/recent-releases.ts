/**
 * 「最近几个版本」——「所有版本」行尾三角展开的那份列表。
 *
 * 更新源（GitHub Releases）只把「最新」交给 electron-updater；想知道「都发过哪些版本」，
 * 只有问列表端点。owner/repo 与网页链接同源（releases-url.ts ← package.json 的
 * build.publish），请求 `GET /repos/<owner>/<repo>/releases?per_page=5`。
 * GitHub 这个端点对未认证请求**默认就不返回 Draft**（草稿只有带 token 才看得见），
 * 所以不额外过滤——发布纪律（tag 叫 `v<版本号>`、不许停在 Draft）在打包技能里管。
 *
 * 三条取舍：
 * - **解析是纯函数**（parseRecentReleases）：字段缺失 / 形状不对的条目**整条丢掉**。
 *   半个版本条目画出来比少一条更糟——它挂着一条点开 404 的链接。
 * - **说明读每一版附带的 latest.yml，不读 Release 正文**（`body` 是给专业用户的完整文档，
 *   见 notes.ts 文件头）：列表里每一行自己是一条 disclosure，展开就地看那一版带来了什么；
 *   没传 latest.yml / 里面没写 / 拉不到就是 `notes: null`，界面据此不画三角（不是丢掉这一行
 *   ——版本号与日期还是要列出来）。每版多一次请求（最多 5 次，并行），走发布资产端点
 *   （`releases/assets/<id>`）而不是 `browser_download_url`：后者在 github.com 网页域名上，
 *   部分网络被拦（与更新器同一个理由，见 github-api-provider.ts）。
 * - **只缓存成功**，10 分钟。失败不缓存，用户点「重试」是真的再打一次；成功则点开 /
 *   收起来回点不打 API。内测期发布节奏远慢于 10 分钟，够用。
 * - **失败是数据**（RecentReleasesResult）：离线 / 限流 / 非 200 都由界面在展开体里
 *   说一句人话并给重试，不让 invoke reject（见 shared/updater.ts 的取舍说明）。
 */
// electron-updater 自己读 latest.yml 的那一个解析函数（js-yaml load）：说明与更新器同口径，
// 也不为读一个字段再引一份 YAML 依赖。包没有 exports 字段，深路径可用；版本精确锁在 6.8.9
import { parseUpdateInfo } from "electron-updater/out/providers/Provider.js";
import type { RecentRelease, RecentReleasesResult, UpdateNote } from "../../shared/updater.ts";
import { appNotesOf } from "./notes.ts";
import { releasesApiUrl } from "./releases-url.ts";

/** 展开体一屏够看，别把发布史整本拉下来 */
const PER_PAGE = 5;
/** 成功结果的内存缓存时长 */
const CACHE_MS = 10 * 60 * 1000;
/** 单次请求的上限：断网 / 挂着不走时不能把设置页的展开体永远转下去 */
const FETCH_TIMEOUT_MS = 10_000;

/** 非空字符串才算数（GitHub 对没有标题的 Release 给 `name: ""`） */
function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** `v0.1.15` → `0.1.15`；没有前缀就原样（tag 约定见 shared/updater.ts，这里不强制） */
function versionOf(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

/**
 * GitHub `releases` 端点的 JSON → 界面用的条目。
 *
 * 返回 null = **根形状不对**（不是一个数组：改过端点、被代理塞了错误页），调用方当失败；
 * 返回空数组 = 真的没有已发布的版本（全是 Draft 时就是这样）。两者在界面上是两句不同的话。
 * 单个条目字段缺失 → 跳过那一条，不影响别的。
 */
/**
 * 列表里的一条，说明还没拉：`notesUrl` 是这一版 Release 附带的 latest.yml（没有就是 null）。
 * 说明不读 Release 正文（`body`）——那是给专业用户的完整文档，见 notes.ts 文件头。
 */
export interface ListedRelease extends Omit<RecentRelease, "notes"> {
  notesUrl: string | null;
}

/** 带说明的更新元数据文件：Windows 的 latest.yml 优先，没有再看 mac 的（两份说明同源） */
const CHANNEL_FILES = ["latest.yml", "latest-mac.yml"] as const;

function channelFileUrl(assets: unknown, assetBaseUrl: string | null): string | null {
  if (!Array.isArray(assets)) return null;
  for (const name of CHANNEL_FILES) {
    for (const asset of assets) {
      if (typeof asset !== "object" || asset === null) continue;
      const record = asset as Record<string, unknown>;
      if (record.name !== name) continue;
      // 优先用资产 id 拼 API 地址；老响应没有 id 才退回网页下载地址（那条可能被拦）
      if (typeof record.id === "number" && assetBaseUrl !== null) return `${assetBaseUrl}/${record.id}`;
      const url = text(record.browser_download_url);
      if (url !== null) return url;
    }
  }
  return null;
}

/** latest.yml 原文 → 软件里的说明；解析不了 / 没写说明都是 null（不拖垮整个列表） */
export function notesFromChannelFile(raw: string): readonly UpdateNote[] | null {
  try {
    return appNotesOf(parseUpdateInfo(raw, "latest.yml", new URL("https://github.com/")).releaseNotes);
  } catch {
    return null;
  }
}

export function parseRecentReleases(payload: unknown, assetBaseUrl: string | null = null): readonly ListedRelease[] | null {
  if (!Array.isArray(payload)) return null;
  const releases: ListedRelease[] = [];
  for (const entry of payload) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const tag = text(record.tag_name);
    const htmlUrl = text(record.html_url);
    const publishedAt = text(record.published_at);
    if (tag === null || htmlUrl === null || publishedAt === null) continue;
    releases.push({
      tag,
      version: versionOf(tag),
      title: text(record.name) ?? tag,
      publishedAt,
      htmlUrl,
      notesUrl: channelFileUrl(record.assets, assetBaseUrl),
    });
  }
  return releases;
}

export interface RecentReleases {
  /** 最近几个版本；带 10 分钟内存缓存，失败不缓存 */
  recent(): Promise<RecentReleasesResult>;
}

export interface RecentReleasesOptions {
  /** 列表端点（默认 releasesApiUrl；测试注入用） */
  endpoint?: () => string | null;
  /** fetch（默认全局；测试注入用） */
  call?: typeof fetch;
  /** 时钟（默认 Date.now；测试注入用） */
  now?: () => number;
}

export function createRecentReleases(options: RecentReleasesOptions = {}): RecentReleases {
  const endpoint = options.endpoint ?? releasesApiUrl;
  const call = options.call ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { at: number; releases: readonly RecentRelease[] } | null = null;

  /** 拉一版的 latest.yml 读说明。transient = 网络层失败（超时 / 断网 / 5xx），不是「没有这份文件」 */
  async function withNotes(
    release: Omit<RecentRelease, "notes">,
    notesUrl: string | null,
  ): Promise<{ release: RecentRelease; transient: boolean }> {
    if (notesUrl === null) return { release: { ...release, notes: null }, transient: false };
    try {
      const response = await call(notesUrl, {
        // 资产端点要这个头才回文件；网页下载地址收到它也无害
        headers: { accept: "application/octet-stream", "user-agent": "orbita" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return { release: { ...release, notes: null }, transient: response.status >= 500 };
      return { release: { ...release, notes: notesFromChannelFile(await response.text()) }, transient: false };
    } catch {
      return { release: { ...release, notes: null }, transient: true };
    }
  }

  return {
    async recent(): Promise<RecentReleasesResult> {
      const url = endpoint();
      if (url === null) return { ok: false, message: "没有配置发布源" };
      if (cached !== null && now() - cached.at < CACHE_MS) return { ok: true, releases: cached.releases };
      try {
        const response = await call(`${url}?per_page=${PER_PAGE}`, {
          headers: { accept: "application/vnd.github+json", "user-agent": "orbita" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) return { ok: false, message: `HTTP ${response.status}` };
        const listed = parseRecentReleases(
          await response.json(),
          url.endsWith("/releases") ? `${url}/assets` : null,
        );
        if (listed === null) return { ok: false, message: "返回的不是版本列表" };
        // 每一版各拉一份 latest.yml（并行，最多 PER_PAGE 份）；单份失败只让那一行没有说明
        const fetched = await Promise.all(listed.map(({ notesUrl, ...release }) => withNotes(release, notesUrl)));
        const releases = fetched.map((entry) => entry.release);
        // 有一份是网络层失败（不是「这一版没传 latest.yml」）就不缓存：下次展开再试，别把
        // 一次抖动记成十分钟的「没有说明」
        if (fetched.every((entry) => !entry.transient)) cached = { at: now(), releases };
        return { ok: true, releases };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
