/**
 * 旧版备份目录的启动清理（2026-11-14 验收 B5 的遗留）。
 *
 * 旧版本把 Office 备份写在会话工作台 `workbench/office-backups/`——工作台是文件面板的
 * 第一个根，所以那个内部目录会出现在文件树里（验收时就被看到了）。新版改到 userData 的
 * `office-backups/<sessionId>/`，但**升级前的空目录还留在盘上**。
 *
 * 这里在启动时用 `rmdir`（只删空目录）清掉：目录里还有文件时 rmdir 会失败（ENOTEMPTY），
 * 我们**不删任何数据**——旧备份没人认领也只是不显示清理，不因为升级丢用户可能还想找回的文件。
 * 选「启动清理」而不是「文件树过滤」：过滤只遮住一个入口，Finder / 其它读工作台的路径
 * 仍然看得到这个内部目录；而且清理只发生一次，不需要文件树长期背一条特例。
 */
import { readdir, rmdir } from "node:fs/promises";
import { join } from "node:path";

/** 返回清掉了几个空目录（只为日志 / 测试；失败一律忽略） */
export async function removeEmptyLegacyOfficeBackupDirs(workbenchesRoot: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(workbenchesRoot, { withFileTypes: true });
  } catch {
    return 0; // 还没有 workbenches 目录（新装）：无事可做
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await rmdir(join(workbenchesRoot, entry.name, "office-backups"));
      removed += 1;
    } catch {
      // 不存在 / 非空 / 没权限：都不动。非空目录里的旧备份宁可留着，也不替用户删
    }
  }
  return removed;
}
