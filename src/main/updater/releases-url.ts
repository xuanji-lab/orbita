/**
 * Release 页基址 —— 界面上「查看说明」「所有版本」两个入口的出处。
 *
 * owner/repo **只有一份真源**：package.json 的 `build.publish`。打包时 electron-builder 读的
 * 就是它（写进 `resources/app-update.yml` 的那份发布配置），所以更新源与界面上的链接永远
 * 指向同一个仓——在这里再写一份仓址就等于埋了第二个会漂移的真源。
 *
 * 「所有版本」行尾三角展开的最近版本列表（recent-releases.ts）打的是 GitHub API，它的
 * owner/repo 也从这里来（releasesApiUrl）：更新源、网页链接、API 三处同一个出处。
 *
 * 读的是源码树里的 package.json（electron-vite 打包 main 时把这段 JSON 内联进 bundle），
 * 不在运行时去翻 asar 里的 package.json：那份是 electron-builder 重新生成的裁剪版，
 * `build` 字段不保证还在。
 */
import packageJson from "../../../package.json" with { type: "json" };

/** 发布源里的仓：owner / repo */
export interface PublishTarget {
  owner: string;
  repo: string;
}

/**
 * `build.publish` 的第一个条目里的仓。取不到（没配 publish、owner/repo 是空的、
 * provider 不是 github——generic / s3 没有网页可跳）时返回 null。
 */
export function publishTarget(): PublishTarget | null {
  const entry = packageJson.build.publish[0];
  if (entry === undefined || entry.provider !== "github") return null;
  if (entry.owner === "" || entry.repo === "") return null;
  return { owner: entry.owner, repo: entry.repo };
}

/**
 * `https://github.com/<owner>/<repo>/releases`。取不到时返回 null：界面据此不画那两个入口，
 * 而不是硬编码一个兜底仓址。
 */
export function releasesUrl(): string | null {
  const target = publishTarget();
  if (target === null) return null;
  return `https://github.com/${target.owner}/${target.repo}/releases`;
}

/**
 * `https://api.github.com/repos/<owner>/<repo>/releases`（列表端点，`?per_page=` 由调用方拼）。
 * 与上面两个入口同一个 owner/repo——发布源只有一份真源。
 */
export function releasesApiUrl(): string | null {
  const target = publishTarget();
  if (target === null) return null;
  return `https://api.github.com/repos/${target.owner}/${target.repo}/releases`;
}
