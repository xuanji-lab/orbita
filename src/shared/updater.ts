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
 * **dev（未打包）下不接线**：`UpdaterSnapshot.supported` 为 false，界面据此把入口
 * 说清楚并置灰——参考实现（Proma）在 dev 下点「检查更新」会走进库的失败路径，
 * 那不是设计，是漏判。
 */

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
  /** 更新说明，纯文本（GitHub 给的是 HTML 正文，主进程在边界上转干净）；没有是 null */
  releaseNotes: string | null;
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
  /** false = 未打包（dev / 从源码跑）：不检查也不下载，界面把入口说清楚并置灰 */
  supported: boolean;
  state: UpdateState;
}
