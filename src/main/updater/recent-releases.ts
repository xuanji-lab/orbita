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
 * - **正文也在这里解析**（`body` → `notes`，复用 notes.ts 的同一套发布约定）：列表里每
 *   一行自己是一条 disclosure，展开就地看那一版带来了什么；解不出条目就是 `notes: null`，
 *   界面据此不画三角（不是丢掉这一行——版本号与日期还是要列出来）。
 * - **只缓存成功**，10 分钟。失败不缓存，用户点「重试」是真的再打一次；成功则点开 /
 *   收起来回点不打 API。内测期发布节奏远慢于 10 分钟，够用。
 * - **失败是数据**（RecentReleasesResult）：离线 / 限流 / 非 200 都由界面在展开体里
 *   说一句人话并给重试，不让 invoke reject（见 shared/updater.ts 的取舍说明）。
 */
import type { RecentRelease, RecentReleasesResult } from "../../shared/updater.ts";
import { parseReleaseNotes } from "./notes.ts";
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
export function parseRecentReleases(payload: unknown): readonly RecentRelease[] | null {
  if (!Array.isArray(payload)) return null;
  const releases: RecentRelease[] = [];
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
      // 正文按发布约定逐条解析（与 update-downloaded 同一条路）；没正文 / 解不出条目是 null
      notes: parseReleaseNotes(text(record.body)),
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
        const releases = parseRecentReleases(await response.json());
        if (releases === null) return { ok: false, message: "返回的不是版本列表" };
        cached = { at: now(), releases };
        return { ok: true, releases };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
