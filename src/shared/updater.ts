/**
 * 自动更新契约 —— IPC 四层的第 1 层。
 *
 * 更新回路只有一条：主进程的 Updater（`main/updater/service.ts`，electron-updater +
 * GitHub Releases）持有唯一真值，每次变化推一份**完整快照**给 renderer
 * （`updater:state`）；renderer 没有本地状态，照着 `state.kind` 分支渲染即可。
 * 推快照而不是推增量：漏一推不会留下半新半旧的两张脸（同 usage:event 的做法）。
 *
 * 通道常量在 `agent-ipc.ts` 的 ipcChannels 里（全仓一份）：
 *   updater:get       拉当前快照（设置页挂载时一次；之后靠推送）
 *   updater:check     手动检查（自动检查见 service.ts：启动 10s 后首查 + 每 4h）
 *   updater:download  用户确认后开始下载（autoDownload=false，库不自己下）
 *   updater:cancel    取消正在进行的下载，退回 available（安装包留着，可再下）
 *   updater:install   退出并安装已下载的更新（quitAndInstall）
 *   updater:state     主进程 → renderer 的状态广播
 *
 * **只有打包好的 Windows 应用接线**（`UpdaterSnapshot.support`）：dev 下没有可更新的安装；
 * macOS 包只是 ad-hoc 签名、未公证，Squirrel.Mac 安装时要校验代码签名，接上只会得到
 * 「检查失败」或「下完装不上」。两种都把入口说清楚并置灰——参考实现（Proma）在 dev 下
 * 点「检查更新」会走进库的失败路径，那不是设计，是漏判。
 */

/**
 * 自动更新在这个实例上可不可用，以及不可用的原因（界面按原因出不同的话）：
 * - `supported`：打包好的 Windows 应用，正常检查 / 下载 / 安装
 * - `unpackaged`：未打包（dev / 从源码跑），没有可更新的安装
 * - `platform`：打包了但本平台暂不支持（macOS，见上），新版本要用户自己去下载
 */
export type UpdateSupport = "supported" | "unpackaged" | "platform";

/** 下载进度（electron-updater 的 ProgressInfo 子集，单位一律字节与百分比） */
export interface UpdateDownloadProgress {
  /** 0–100 */
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

/**
 * 更新源给出的一份发布。available 与 downloading 共用同一份：下载被取消时要能原样
 * 退回 available（版本号 / 安装包大小 / 更新说明都还在），不为「退回」再造一份状态。
 */
export interface UpdateRelease {
  version: string;
  /** 安装包字节数；更新源没给是 null（界面少画一段「· 14.8 MB」） */
  size: number | null;
  /** 更新说明，逐条（发布约定与解析见 main/updater/notes.ts）；没有是 null */
  releaseNotes: readonly UpdateNote[] | null;
}

/**
 * 一条更新说明。**发布约定**：Release 正文每行一条，行首可选 `[icon:名字]` 前缀指定
 * 条目图标（例：`[icon:download] 下载改为用户确认后才开始。`）。
 *
 * `icon` 是 lucide 图标名，但是**未校验的字符串**：白名单只能来自 renderer 的
 * `Icon.tsx` ICONS 表（主进程没有这张表），所以取值时在那边兑底——名字不在表里就当
 * 没图标，不做第二个真源。
 */
export interface UpdateNote {
  icon: string | null;
  text: string;
}

/** 失败在哪一步：界面按它出文案，重试按钮按它决定重试哪个动作 */
export type UpdateStage = "check" | "download" | "install";

/**
 * 更新状态机的状态。**每个状态都把界面要画的东西带齐**（版本号、大小、进度），
 * renderer 不做推导。
 *
 * 两个终态意义上的状态要认得：`downloaded`（安装包在盘上，等用户重启安装）与
 * `error`（可重试）。粘性规则（已下载的更新不被检查顶掉、下载中不被检查结果覆盖）
 * 在 `main/updater/state.ts` 里，有测试。
 */
export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date"; version: string }
  | { kind: "available"; release: UpdateRelease }
  | { kind: "downloading"; release: UpdateRelease; progress: UpdateDownloadProgress }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; stage: UpdateStage; message: string };

/** `updater:get` / `updater:state` 的载荷：整份快照 */
export interface UpdaterSnapshot {
  /** 当前应用版本（主进程的 app.getVersion()），界面「当前版本」那一行用它 */
  currentVersion: string;
  /** 不是 `supported` 时不检查也不下载，界面按原因把入口说清楚并置灰 */
  support: UpdateSupport;
  state: UpdateState;
  /**
   * **已装上的这一版**的更新说明——装完之后才有的那一份。更新源只会给「新版本」的说明，
   * 版本装上以后用户再想问「我现在这版带来了什么」就没有出处了；所以下载完成时把那一版的
   * 说明留在 userData 上（写字的地方见 main/updater/service.ts 的 update-downloaded），
   * 下次启动版本号对得上就放进快照。没有（没存过 / 存的不是这一版 / 文件坏了）是 null，
   * 界面据此不画「本版更新内容」。
   */
  currentNotes: readonly UpdateNote[] | null;
  /**
   * Release 页基址（`https://github.com/<owner>/<repo>/releases`）。**owner/repo 只有一份
   * 真源**：主进程从 package.json 的 `build.publish` 取（main/updater/releases-url.ts）——
   * 打包时写进 app-update.yml 的也是它。界面上的「查看说明」「所有版本」两个入口都由这个
   * 基址拼出来，不再硬编码第二份仓址。publish 里没有 owner/repo 时是 null：没有出处就不画
   * 链接，也不拿一个兜底地址冒充。
   */
  releasesUrl: string | null;
}

/**
 * 某一版的 Release 页地址（界面的「查看说明」打开它）。**发布约定**：tag 是 `v<版本号>`。
 *
 * 版本号还没到（快照未到，currentVersion 是空串）时返回 null——拼不出地址就不渲染入口，
 * 而不是把用户送到 `/tag/v` 上。
 */
export function releaseTagUrl(releasesUrl: string, version: string): string | null {
  if (version === "") return null;
  return `${releasesUrl}/tag/v${version}`;
}

/**
 * 最近几个版本的 Release —— 「所有版本」行尾三角展开的那份列表。
 *
 * 更新源（GitHub Releases）只把「最新」交给 electron-updater，历史版本本来没有出口。
 * 这份数据来自 `updater:recentReleases`（主进程打 GitHub API，见
 * main/updater/recent-releases.ts）：它是**点开才要**的一次网络请求，所以不放进快照——
 * 混进每次状态推送里，会让与它无关的状态变化也跟着背上一份列表。
 */
export interface RecentRelease {
  /** tag，如 `v0.1.15` */
  tag: string;
  /** 版本号（tag 去掉前缀 `v` 的那一段），列表里显示的是它 */
  version: string;
  /** Release 标题；作者没写标题时主进程回落到 tag */
  title: string;
  /** 发布日期的 ISO 串（界面只截日期那一段） */
  publishedAt: string;
  /** Release 页地址：列表里点一行跳它 */
  htmlUrl: string;
  /**
   * **这一版**的应用内更新说明：读这一版 Release 附带的 `latest.yml` 里的 `releaseNotes`（打包时从
   * package.json 的 `build.releaseInfo.releaseNotes` 写进去，与更新器同一个来源），按发布约定逐条解析。
   * **不读 GitHub Release 页的正文**：那是给专业用户的完整文档，软件里给普通用户看的是另写的几行。
   * 列表里每一行自己也是一条 disclosure——点开就地看这一版带来了什么。没有 `latest.yml` /
   * 里面没写说明 / 拉不到是 null：界面不画那一行的三角、整行不可点。
   */
  notes: readonly UpdateNote[] | null;
}

/**
 * `updater:recentReleases` 的回执。**失败是数据而不是异常**：拉不到列表（离线、限流、
 * 非 200、返回的形状不对）时在展开体里说一句人话并给重试，而不是让 invoke reject、
 * 让界面多写一套异常展示（同 updater:check 那五个 handler 的取舍）。
 */
export type RecentReleasesResult =
  | { ok: true; releases: readonly RecentRelease[] }
  | { ok: false; message: string };

/**
 * 「最近版本」列表里那一行的标题该不该画。**标题与版本号逐字相同就不画**，只留左边的
 * mono 版本号——打包技能里 `gh release create --title` 写的就是裸版本号，再画一遍
 * 屏幕上就是「0.1.15 0.1.15」（2026-10-18 验收发现）。
 *
 * 比之前先把 tag 风格的 `v` 前缀剥掉：标题写 `v0.1.15`、版本号是 `0.1.15` 也是同一个。
 * 返回 null = 这一行只画版本号与日期。空标题（GitHub 允许没写名字）同样返回 null。
 */
export function recentReleaseTitle(release: RecentRelease): string | null {
  const title = release.title.trim();
  if (title === "") return null;
  const bare = title.startsWith("v") ? title.slice(1) : title;
  return bare === release.version ? null : title;
}
