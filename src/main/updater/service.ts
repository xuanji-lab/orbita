/**
 * 自动更新（electron-updater + GitHub Releases）。
 *
 * **门控**：只有打包好的 Windows 应用才接线（`updateSupport`，见 state.ts；macOS 包未签名公证、
 * 装不上，本版不接）——dev 实例没有任何可更新的安装，检查只会
 * 往日志里灌网络错误。
 *
 * **更新源**：owner/repo 仍以 `package.json` 的 `build.publish` 为唯一真源；但读取方式
 * 换成了 GitHub REST API + 发布资产端点（`github-api-provider.ts`）。原因是 electron-updater
 * 自带的 GitHub provider 要先访问 `github.com/.../releases.atom`，而部分网络只拦网页域名、
 * `api.github.com` 仍通（issue #283）——同一份 Release，不引入镜像源。
 * `build.publish` 仍会在打包时写进 `resources/app-update.yml`，这里用 setFeedURL 覆盖
 * provider；取不到 owner/repo 时退回库自己读 app-update.yml 的行为。
 *
 * **代理**：electron-updater 用自己的 Electron session，不读 `HTTPS_PROXY`。启动时如果
 * 环境里有这个变量，就给那个 session 设 proxyRules（见 proxy.ts）——给系统代理没开、
 * 只能显式走代理的机器一条出口；没配就维持默认（跟随系统代理）。
 *
 * **下载**：库自带的下载器单连接、一断就从 0 重来；这里换成 4MB 分段、最多 6 段并行、
 * 每段从已写字节续传（见 resilient-executor.ts），下完按 latest.yml 的 sha512 校验。
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
import { session } from "electron";
import { CancellationToken, autoUpdater } from "electron-updater";
import { NET_SESSION_NAME } from "electron-updater/out/electronHttpExecutor.js";
import type { ProgressInfo, UpdateInfo } from "electron-updater";
import type {
  UpdateNote,
  UpdaterSnapshot,
  UpdateRelease,
  UpdateStage,
  UpdateState,
  UpdateSupport,
} from "../../shared/updater.ts";
import { builtinNotes } from "./builtin-notes.ts";
import { failureKindOf } from "./failure.ts";
import { GitHubApiProvider } from "./github-api-provider.ts";
import { appNotesOf } from "./notes.ts";
import { hasProxySetting, proxyRulesOf } from "./proxy.ts";
import { publishTarget, releasesUrl } from "./releases-url.ts";
import { installResilientDownload } from "./resilient-executor.ts";
import { reduceUpdater, updateSupport, type UpdaterAction } from "./state.ts";

/** 启动后延迟首查：错开启动时那一串磁盘 / 网络活动，别和界面首帧抢 */
const FIRST_CHECK_DELAY_MS = 10_000;
/** 定期检查：内测期发布节奏不快，4h 足够（手动检查随时可用） */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export interface UpdaterOptions {
  /** 是否打包产物（app.isPackaged）；与 platform 一起决定能不能更新（见 state.ts 的 updateSupport） */
  packaged: boolean;
  /** process.platform：本版只有 Windows 接线，macOS 说清楚「暂不支持」 */
  platform: string;
  /** 当前应用版本（app.getVersion()），界面「当前版本」那一行用它 */
  version: string;
  /** 安装前的收尾：把 agent utility 进程收掉（见文件头） */
  beforeInstall: () => void;
}

/** 更新说明：只认打包时写进 latest.yml 的纯文本；退回到 Release 页正文时不显示（见 notes.ts 的 appNotesOf） */
function notesOf(info: UpdateInfo): readonly UpdateNote[] | null {
  return appNotesOf(info.releaseNotes);
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
  /** 能不能更新；不是 supported 时检查 / 下载 / 安装一律不做 */
  private readonly support: UpdateSupport;
  private readonly version: string;
  private readonly beforeInstall: () => void;
  private readonly listeners = new Set<(snapshot: UpdaterSnapshot) => void>();
  private state: UpdateState = { kind: "idle" };
  /**
   * 当前这一版的更新说明——**应用内置的那份**（package.json 的 build.releaseInfo，
   * 见 builtin-notes.ts）。每个安装包自带自己这一版的说明，离线可用、不问 GitHub；
   * 版本号永远对得上，不再需要「下载时落盘、下次启动读回」那套持久化。
   */
  private readonly currentNotes: readonly UpdateNote[] | null = builtinNotes();
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
    this.support = updateSupport(options.packaged, options.platform);
    this.version = options.version;
    this.beforeInstall = options.beforeInstall;
  }

  /** 当前快照。renderer 挂载时拉一次，之后靠 updater:state 推送 */
  snapshot(): UpdaterSnapshot {
    return {
      currentVersion: this.version,
      support: this.support,
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
  async start(): Promise<void> {
    if (this.support !== "supported") {
      console.info(
        this.support === "unpackaged"
          ? "[更新] 未打包的实例不接线自动更新（只有安装好的应用才能更新自己）"
          : "[更新] 本平台暂不接线自动更新（macOS 包未签名公证，装不上；新版本请到 GitHub 下载）",
      );
      return;
    }
    await this.applyProxy();
    autoUpdater.logger = {
      info: (message?: unknown) => console.info("[更新:库]", message),
      warn: (message?: unknown) => console.warn("[更新:库]", message),
      error: (message?: unknown) => console.error("[更新:库]", message),
      debug: (message: string) => console.info("[更新:库]", message),
    };
    // 库不自己下载、也不在退出时顺手安装：两步都要用户点（见文件头）
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    // 读取方式换成 GitHub API（见 github-api-provider.ts）：网页域名被拦时也能检查更新。
    // owner/repo 仍来自 build.publish；取不到就不覆盖，让库照 app-update.yml 走。
    // 下载器必须在 setFeedURL 前换：provider 的 runtimeOptions 在 setFeedURL 时
    // 捕获 httpExecutor，晚一步换，provider 还会拿旧的。
    installResilientDownload(autoUpdater);
    const target = publishTarget();
    if (target === null) {
      console.warn("[更新] build.publish 里没有 owner/repo，更新源沿用打包时的 app-update.yml");
    } else {
      autoUpdater.setFeedURL({
        provider: "custom",
        updateProvider: GitHubApiProvider,
        owner: target.owner,
        repo: target.repo,
      });
    }

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
    if (this.support !== "supported") return;
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
    if (this.support !== "supported" || this.state.kind !== "available") return;
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
    if (this.support !== "supported" || this.state.kind !== "downloaded") return;
    this.installing = true;
    // 先收掉 agent utility 进程，再让安装程序动手：NSIS 会等父进程退出后才替换文件
    this.beforeInstall();
    console.info("[更新] 退出并安装");
    // 延后一拍：让 install 的 IPC 回执先发回 renderer，再收进程
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
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
    const failure = failureKindOf(error);
    console.error(`[更新] ${stageLabel(stage)}失败（${failure}）：`, message);
    this.apply({ type: "failed", stage, failure, message });
  }

  /**
   * 环境里有 HTTPS_PROXY / HTTP_PROXY 时，把它应用到 electron-updater 自己的 session。
   * 没配就什么都不做——库默认跟随系统代理，保持用户原来的行为。
   *
   * 代理值不写日志（可能带内网地址）；只报「设上了 / 没设上」。
   */
  private async applyProxy(): Promise<void> {
    const rules = proxyRulesOf(process.env);
    if (rules === null) {
      // 配了却用不上（带账号密码 / 协议不认识）：不能静默直连，否则用户以为代理已生效
      if (hasProxySetting(process.env)) {
        console.warn(
          "[更新] HTTPS_PROXY / HTTP_PROXY 的值不能当更新出口（无法解析、协议不认识，或带账号密码），继续直连",
        );
      }
      return;
    }
    try {
      await session.fromPartition(NET_SESSION_NAME, { cache: false }).setProxy({ proxyRules: rules });
      console.info("[更新] 更新出口已按 HTTPS_PROXY / HTTP_PROXY 设置代理");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[更新] HTTPS_PROXY / HTTP_PROXY 没能应用到更新出口，继续直连：", message);
    }
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
