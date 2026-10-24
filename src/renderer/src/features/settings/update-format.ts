/**
 * 更新卡上的机器事实（字节数）→ 那一行里的文字。纯函数，附测试。
 *
 * 单位用 MB 起、小数一位：「14.8 MB」「6.2 / 14.8 MB」——安装包是几十到两百 MB 量级，
 * 这一档足够读出「还要多久」。小于 1MB 退到 KB（0 位小数），那是刚起步的第一帧。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  const megabytes = bytes / (1024 * 1024);
  if (megabytes >= 1) return `${megabytes.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * 下载中的「6.2 / 14.8 MB」。总量缺席（更新源没给 size，进度事件的总量为 0）时只报已下载——
 * 写「6.2 / 0 KB」是把「不知道」说成了「就是这么大」。
 */
export function progressAmount(transferred: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return formatBytes(transferred);
  return `${formatBytes(transferred)} / ${formatBytes(total)}`;
}

/** 进度条的填充宽度（0–100）：库偶尔会给出略超 100 或负的百分比，钳住再画 */
export function progressPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}
