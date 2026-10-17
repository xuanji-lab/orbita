/**
 * 更新状态机 —— 纯模块，`node --test` 直接测（不引 electron / electron-updater）。
 *
 * electron-updater 的事件与我们的命令都先翻译成 `UpdaterAction`，由 `reduceUpdater`
 * 算出下一个状态。两条粘性规则在这里落地，各自对应一个真实的坏表现：
 *
 *  1. **downloaded 是终态**：已下载的更新不能被随后的一次检查（或检查失败）顶掉——
 *     顶掉等于把用户的「重启安装」按钮弄丢，而安装包还在盘上。
 *  2. **downloading 不被检查结果覆盖**：4h 定时检查与下载可能并行，`update-available` /
 *     `update-not-available` 到达时若照单全收，进度条会被顶掉，而下载其实还在跑。
 *
 * 状态不变时**返回同一个对象引用**：调用方据此跳过广播与重渲染（定时检查里的重复事件
 * 不会每 4h 推一次一模一样的快照）。
 */
import type {
  UpdateDownloadProgress,
  UpdateNote,
  UpdateRelease,
  UpdateStage,
  UpdateState,
} from "../../shared/updater.ts";

/** electron-updater 的事件与我们的命令，都先翻译成它 */
export type UpdaterAction =
  | { type: "check-started" }
  | { type: "up-to-date"; version: string }
  | { type: "available"; release: UpdateRelease }
  | { type: "download-started" }
  | { type: "progress"; progress: UpdateDownloadProgress }
  | { type: "download-cancelled" }
  | { type: "downloaded"; version: string }
  | { type: "failed"; stage: UpdateStage; message: string };

/** 更新说明逐条相比：解析一次就得到一份新数组，不比内容的话「同一次检查的同一个答案」会被当成两份 */
function sameNotes(a: readonly UpdateNote[] | null, b: readonly UpdateNote[] | null): boolean {
  if (a === b) return true;
  if (a === null || b === null || a.length !== b.length) return false;
  return a.every((note, index) => {
    const other = b[index];
    return other !== undefined && note.icon === other.icon && note.text === other.text;
  });
}

/** 一份发布的字段是否逐项相同（用于「这次检查与上次的答案一样」时不重发状态） */
function sameRelease(a: UpdateRelease, b: UpdateRelease): boolean {
  return a.version === b.version && a.size === b.size && sameNotes(a.releaseNotes, b.releaseNotes);
}

function sameProgress(a: UpdateDownloadProgress, b: UpdateDownloadProgress): boolean {
  return (
    a.percent === b.percent &&
    a.transferred === b.transferred &&
    a.total === b.total &&
    a.bytesPerSecond === b.bytesPerSecond
  );
}

export function reduceUpdater(state: UpdateState, action: UpdaterAction): UpdateState {
  switch (action.type) {
    case "check-started":
      // 下载中 / 已下载时不改状态：一次检查不该让进度条或「重启安装」闪掉
      if (state.kind === "downloaded" || state.kind === "downloading") return state;
      return { kind: "checking" };

    case "up-to-date":
      if (state.kind === "downloaded" || state.kind === "downloading") return state;
      if (state.kind === "up-to-date" && state.version === action.version) return state;
      return { kind: "up-to-date", version: action.version };

    case "available": {
      if (state.kind === "downloading") return state;
      // 已下载 vA，更新源又给出 vB：B 更新就换成新的发布（安装包是同一个缓存目录，
      // 再下一次即覆盖）；B 不比 A 新（发布被回退 / 重发）就留着已下载的那份
      if (state.kind === "downloaded") {
        return isNewerVersion(action.release.version, state.version)
          ? { kind: "available", release: action.release }
          : state;
      }
      if (state.kind === "available" && sameRelease(state.release, action.release)) return state;
      return { kind: "available", release: action.release };
    }

    case "download-started":
      if (state.kind !== "available") return state;
      return {
        kind: "downloading",
        release: state.release,
        // 0% 的起点：第一个 download-progress 到达前界面已经有进度条与取消键
        progress: { percent: 0, transferred: 0, total: state.release.size ?? 0, bytesPerSecond: 0 },
      };

    case "progress":
      if (state.kind !== "downloading") return state;
      if (sameProgress(state.progress, action.progress)) return state;
      return { kind: "downloading", release: state.release, progress: action.progress };

    case "download-cancelled":
      // 退回同一份发布：版本号 / 大小 / 更新说明都还在，展开的「更新内容」不丢
      if (state.kind !== "downloading") return state;
      return { kind: "available", release: state.release };

    case "downloaded":
      if (state.kind === "downloaded" && state.version === action.version) return state;
      return { kind: "downloaded", version: action.version };

    case "failed":
      // 已下载的更新不怕检查 / 下载失败（安装包还在盘上）；下载中也不因一次检查失败中断
      if (state.kind === "downloaded") return state;
      if (action.stage === "check" && state.kind === "downloading") return state;
      // 同一条错误可能被库报两次（error 事件 + promise rejection），两次算出的阶段可能不同
      // （第二次时「正在下载」的标记已经清掉，会算成 check）：**先到的那条更准**，
      // 同一条消息不许把已有的 error 换个阶段显示
      if (state.kind === "error" && state.message === action.message) return state;
      return { kind: "error", stage: action.stage, message: action.message };
  }
}

interface ParsedVersion {
  /** 数字段（`1.2.3` → [1, 2, 3]）；段数不定，比较时缺的按 0 */
  numbers: number[];
  /** 预发布标识（`1.0.0-beta.1` → ["beta", "1"]）；空数组 = 正式版 */
  prerelease: string[];
}

/** `v` 前缀可省；数字段一段起；build 元数据（`+…`）按 semver 忽略 */
const VERSION_RE = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(raw: string): ParsedVersion | null {
  const match = VERSION_RE.exec(raw.trim());
  if (match === null) return null;
  const numbers = match[1];
  if (numbers === undefined) return null;
  const prerelease = match[2];
  return {
    numbers: numbers.split(".").map(Number),
    prerelease: prerelease === undefined ? [] : prerelease.split("."),
  };
}

/** semver 的大小规则：数字段按数值、正式版高于同号预发布版、预发布标识里数字段低于字母段 */
function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  const width = Math.max(a.numbers.length, b.numbers.length, 3);
  for (let i = 0; i < width; i += 1) {
    const diff = (a.numbers[i] ?? 0) - (b.numbers[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const preWidth = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < preWidth; i += 1) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumber = /^\d+$/.test(x) ? Number(x) : null;
    const yNumber = /^\d+$/.test(y) ? Number(y) : null;
    if (xNumber !== null && yNumber !== null) return xNumber > yNumber ? 1 : -1;
    if (xNumber !== null) return -1;
    if (yNumber !== null) return 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * `candidate` 是否严格比 `base` 新。
 *
 * **解析不出来一律 false**：说不清是不是更新就按「不是更新」处理——宁可多留一份已经
 * 下载好的安装包，也不要把用户下好的更新换成一条更旧的发布。
 *
 * 不引 `semver`：它在 electron-updater 的依赖里，但不是我们的直接依赖（直接 import
 * 一个没在 package.json 里声明的传递依赖是脆的）；为一个比较再加 semver +
 * @types/semver 两份依赖不值，semver 的排序规则这里四十行就够。
 */
export function isNewerVersion(candidate: string, base: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(base);
  if (a === null || b === null) return false;
  return compareVersions(a, b) > 0;
}
