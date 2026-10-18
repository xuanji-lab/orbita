/**
 * 自动更新（electron-updater + GitHub Releases）。
 *
 * **门控**：只有打包产物才接线（`packaged`）——dev 实例没有任何可更新的安装，检查只会
 * 往日志里灌网络错误。feed 地址不写在这里：`package.json` 的 `build.publish` 在打包时
 * 烘焙进 `resources/app-update.yml`，库自己去读。
 *
 * **节奏**（沿用参考实现 Proma，去掉它的「等 agent 空闲再装」调度）：启动 10s 后首查，
 * 之后每 4h 一次；手动检查同一条路。`autoDownload=false`——发现新版本只进 `available`，
 * 用户点「下载」才 `downloadUpdate()`；下完进 `downloaded`，用户点「重启安装」才
 * `quitAndInstall()`。库自己有 `autoInstallOnAppQuit`，关掉它：静默安装必须由用户那一下
 * 触发，不能变成「下次随便什么时候退应用就顺手装了」。
 *
 * **安装前先 `beforeInstall()`**（由 index.ts 注入：收掉 agent utility 进程）。安装程序
 * 要替换应用文件，而 utility 进程是同一个 electron.exe，压着文件会让 NSIS 静默安装失败。
 * app.quit() 触发的 before-quit 里还有同一条 dispose，重入幂等。
 */
import { CancellationToken, autoUpdater } from "electron-updater";
import type { ProgressInfo, UpdateInfo } from "electron-updater";
import type { UpdateNote, UpdaterSnapshot, UpdateRelease, UpdateStage, UpdateState } from "../../shared/updater.ts";
import { readCurrentNotes, saveCurrentNotes } from "./current-notes.ts";
import { parseReleaseNotes } from "./notes.ts";
import { releasesUrl } from "./releases-url.ts";
import { reduceUpdater, type UpdaterAction } from "./state.ts";

/** 启动后延迟首查：错开启动时那一串磁盘 / 网络活动，别和界面首帧抢 */
const FIRST_CHECK_DELAY_MS = 10_000;
/** 定期检查：内测期发布节奏不快，4h 足够（手动检查随时可用） */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export interface UpdaterOptions {
  /** 只有打包产物才做更新（dev 下 supported=false，界面据此置灰） */
  packaged: boolean;
  /** 当前应用版本（app.getVersion()），界面「当前版本」那一行用它 */
  version: string;
  /** 「本版更新内容」落在哪里（userData 下的一个 JSON，见 current-notes.ts） */
  currentNotesFile: string;
  /** 安装前的收尾：把 agent utility 进程收掉（见文件头） */
  beforeInstall: () => void;
}

/** 更新说明：GitHub 给的是 Release 正文的 HTML，fullChangelog 时是一个数组（最新一条在前） */
function notesOf(info: UpdateInfo): readonly UpdateNote[] | null {
  const notes = info.releaseNotes;
  if (notes === undefined || notes === null) return null;
  return parseReleaseNotes(typeof notes === "string" ? notes : (notes[0]?.note ?? null));
}

function releaseOf(info: UpdateInfo): UpdateRelease {
  const size = info.files?.[0]?.size;
  return {
    version: info.version,
    size: typeof size === "number" ? size : null,
    releaseNotes: notesOf(info),
  };
}

/** 日志前缀带上阶段：出问题时 console 里一眼看出是检查还是下载 */
function stageLabel(stage: UpdateStage): string {
  if (stage === "check") return "检查";
  if (stage === "download") return "下载";
  return "安装";
}

export class Updater {
  private readonly packaged: boolean;
  private readonly version: string;
  private readonly currentNotesFile: string;
  private readonly beforeInstall: () => void;
  private readonly listeners = new Set<(snapshot: UpdaterSnapshot) => void>();
  private state: UpdateState = { kind: "idle" };
  /**
   * 当前这一版的更新说明（启动时从 userData 读回，见 readCurrentNotes）。**只读一次**：
   * 它说的是「已经装上的这一版」，本次进程里版本不会变；下载新版时覆盖文件，那是给下次
   * 启动用的（此刻用户还在旧版上跑，他那版的说明不该当场消失）。
   */
  private currentNotes: readonly UpdateNote[] | null = null;
  /**
   * 正在下载的版本（用户主动发起的那一次）。库的 `error` 事件不带阶段，靠它把
   * 「检查失败」与「下载失败」分开——两者的重试动作不同。
   */
  private activeDownload: string | null = null;
  /** 安装请求已发出：此后的 `error` 归到 install（quitAndInstall 拉不起安装程序时用的） */
  private installing = false;
  private cancelToken: CancellationToken | null = null;
  /** 用户点了取消；`cancelHandled` 记住这次取消已经落成状态，库补发的第二个失败信号不再当失败 */
  private cancelRequested = false;
  private cancelHandled = false;

  constructor(options: UpdaterOptions) {
    this.packaged = options.packaged;
    this.version = options.version;
    this.currentNotesFile = options.currentNotesFile;
    this.beforeInstall = options.beforeInstall;
  }

  /** 当前快照。renderer 挂载时拉一次，之后靠 updater:state 推送 */
  snapshot(): UpdaterSnapshot {
    return {
      currentVersion: this.version,
      supported: this.packaged,
      state: this.state,
      currentNotes: this.currentNotes,
      releasesUrl: releasesUrl(),
    };
  }

  /** 状态变化订阅（ipc 层接广播，见 ipc.ts）。 */
  onChange(listener: (snapshot: UpdaterSnapshot) => void): void {
    this.listeners.add(listener);
  }

  /** 接线 electron-updater 并排上两次自动检查。dev（未打包）下什么都不做。 */
  start(): void {
    // 「本版更新内容」在 dev 下也读：它说的是磁盘上的事实（这一版带来了什么），与要不要
    // 接线更新无关——接不了更新的实例同样能看它，验收也靠这条（见 current-notes.ts）
    void this.loadCurrentNotes();
    if (!this.packaged) {
      console.info("[更新] 未打包的实例不接线自动更新（只有安装好的应用才能更新自己）");
      return;
    }
    autoUpdater.logger = {
      info: (message?: unknown) => console.info("[更新:库]", message),
      warn: (message?: unknown) => console.warn("[更新:库]", message),
      error: (message?: unknown) => console.error("[更新:库]", message),
      debug: (message: string) => console.info("[更新:库]", message),
    };
    // 库不自己下载、也不在退出时顺手安装：两步都要用户点（见文件头）
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on("checking-for-update", () => this.apply({ type: "check-started" }));
    autoUpdater.on("update-available", (info) => this.apply({ type: "available", release: releaseOf(info) }));
    autoUpdater.on("update-not-available", (info) => this.apply({ type: "up-to-date", version: info.version }));
    autoUpdater.on("download-progress", (progress: ProgressInfo) => {
      this.apply({
        type: "progress",
        progress: {
          percent: progress.percent,
          transferred: progress.transferred,
          total: progress.total,
          bytesPerSecond: progress.bytesPerSecond,
        },
      });
    });
    autoUpdater.on("update-downloaded", (info) => {
      this.activeDownload = null;
      this.apply({ type: "downloaded", version: info.version });
      // 说明跟着安装包一起落盘：装完重启之后就只剩磁盘这一条出处了（见 current-notes.ts）
      void this.rememberNotes(info);
    });
    autoUpdater.on("error", (error: Error) => this.fail(this.stageOf(), error));

    // 两个计时器跟着进程活（关窗收进托盘后仍要继续检查）；退出时随进程一起没，不需要 dispose
    setTimeout(() => {
      console.info("[更新] 启动后的首次检查");
      void this.check();
    }, FIRST_CHECK_DELAY_MS);
    setInterval(() => {
      console.info("[更新] 定期检查");
      void this.check();
    }, CHECK_INTERVAL_MS);
    console.info(`[更新] 自动更新已接线（当前版本 ${this.version}，自动下载关闭）`);
  }

  /**
   * 检查更新（自动与手动同一条）。**库在失败时既发 `error` 事件又 reject 这个 promise**，
   * 两条都翻译成同一个 action，状态机自己去重（同一条错误不换对象、不重复广播）。
   */
  async check(): Promise<void> {
    if (!this.packaged) return;
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.fail("check", error);
    }
  }

  /**
   * 用户确认后的下载。**立刻进 downloading**，不等第一个进度事件：按钮当场变进度条，
   * 也堵住「下载已经排上、界面还能再点一次」的那个窗口。
   */
  async download(): Promise<void> {
    if (!this.packaged || this.state.kind !== "available") return;
    const version = this.state.release.version;
    this.apply({ type: "download-started" });
    this.activeDownload = version;
    this.cancelRequested = false;
    this.cancelHandled = false;
    const token = new CancellationToken();
    this.cancelToken = token;
    try {
      await autoUpdater.downloadUpdate(token);
    } catch (error) {
      this.fail("download", error);
    } finally {
      this.cancelToken = null;
      this.activeDownload = null;
    }
  }

  /**
   * 取消正在进行的下载。库的 cancellationToken 会拒掉 `downloadUpdate`，并且可能再补发
   * 一个 `error` 事件——两个信号都经 `fail()` 归成同一次取消（`cancelHandled`），
   * 状态退回 `available`：安装包只是没下完，随时可以再下。
   */
  cancel(): void {
    if (this.state.kind !== "downloading") return;
    this.cancelRequested = true;
    this.cancelToken?.cancel();
  }

  /**
   * 退出并安装已下载的更新。用户点的那一下就是同意，不再拦一道「有没有 agent 在跑」——
   * 单 agent 应用里那个判断只会变成「点了没反应」。**代价如实写在这里**：正在跑的一轮
   * 会随进程一起停掉（等空闲再装是后续单独立的项）。
   */
  install(): void {
    if (!this.packaged || this.state.kind !== "downloaded") return;
    this.installing = true;
    // 先收掉 agent utility 进程，再让安装程序动手：NSIS 会等父进程退出后才替换文件
    this.beforeInstall();
    console.info("[更新] 退出并安装");
    // 延后一拍：让 install 的 IPC 回执先发回 renderer，再收进程
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  }

  /**
   * 启动时读一次「本版更新内容」。**慢在磁盘上、不阻塞任何人**（窗口与设置页不等它），
   * 读到就在读到的那一刻推一份快照——渲染层是「整份替换」，不关心它什么时候到。
   */
  private async loadCurrentNotes(): Promise<void> {
    const notes = await readCurrentNotes(this.currentNotesFile, this.version);
    if (notes === null) return;
    this.currentNotes = notes;
    this.push();
  }

  /**
   * 落盘这一版的说明（`update-downloaded`）。**失败不影响「已下载」这个事实**：界面照旧
   * 进 downloaded 等用户重启，最坏的结果只是重启后看不到这一版的说明。
   */
  private async rememberNotes(info: UpdateInfo): Promise<void> {
    try {
      await saveCurrentNotes(this.currentNotesFile, info.version, notesOf(info));
    } catch (error) {
      console.warn("[更新] 本版更新内容没能落盘：", error);
    }
  }

  private stageOf(): UpdateStage {
    if (this.installing) return "install";
    if (this.activeDownload !== null) return "download";
    return "check";
  }

  private fail(stage: UpdateStage, error: unknown): void {
    if (stage === "download" && (this.cancelRequested || this.cancelHandled)) {
      this.cancelRequested = false;
      this.cancelHandled = true;
      this.activeDownload = null;
      console.info("[更新] 下载已取消");
      this.apply({ type: "download-cancelled" });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[更新] ${stageLabel(stage)}失败：`, message);
    this.apply({ type: "failed", stage, message });
  }

  /** 状态机对无关动作返回同一个引用：据此跳过广播 */
  private apply(action: UpdaterAction): void {
    const next = reduceUpdater(this.state, action);
    if (next === this.state) return;
    this.state = next;
    this.push();
  }

  /** 推一份完整快照给订阅者（ipc 层转发到窗口） */
  private push(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
