/**
 * MXC 的 Node 版本闸门 —— 纯函数，单独一个文件是为了**不 import SDK**。
 *
 * SDK 的入口会 `import koffi`（原生 addon）并在 probe 时 `koffi.load(mxc_ffi.dll)`；
 * 把这两条判据放在这里，单测与「没装 SDK 的机器」都不必为它付出加载代价。
 *
 * 语义照抄 SDK 的 semver range（`dist/bindings/native-stdio.js` 的 `nodeRange`）：
 * `>=24.21.0 <25 || >=26.8.0`。这个闸门**在 provision 之后才会炸**，错误码
 * `backend_unavailable`，很容易被误判成「会话起不来」——所以要在启动前先判。
 */
export function nodeSupportsNativeStdio(version: string): boolean {
  const parts = version.trim().replace(/^v/, "").split(".");
  const major = Number.parseInt(parts[0] ?? "", 10);
  const minor = Number.parseInt(parts[1] ?? "", 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  // 与 SDK 的 range 逐字对齐：`>=24.21.0 <25 || >=26.8.0`。**25.x 不在里面**——
  // 别把它写成「24.21 以上都行」，那是另一个 range。
  if (major === 24) return minor >= 21;
  if (major === 26) return minor >= 8;
  return major >= 27;
}

/** 版本不够时给用户看的话（`nodeOk:false` 时由它解释，而不是一句「不可用」） */
export function nodeTooOldReason(version: string): string {
  return (
    `当前 Node ${version} 太旧：MXC 的 native stdio 要求 Node 24.21 以上（或 26.8 以上）。` +
    "Electron 43 自带 24.21.0，够用；开发时把 Electron 降级就会撞上这条。"
  );
}
