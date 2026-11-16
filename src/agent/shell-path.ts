/**
 * 把 bash 可执行文件的绝对路径**探一次**，之后作为 `shellPath` 交给 bash 工具的执行环境。
 *
 * 查找顺序（与旧版一致）：Windows 上先看 `%ProgramFiles%` / `%ProgramFiles(x86)%` 下的 Git Bash，
 * 再在 PATH 里找 bash.exe（Cygwin、MSYS2、scoop 装的 Git）；其它平台先 `/bin/bash`，再 PATH 里的 bash。
 *
 * PATH 里找是在本进程逐个目录看文件在不在，**不起 `where` / `which` 子进程**：旧版每次 exec 都同步
 * `spawnSync("where")`，Git 不在默认位置的 Windows 机器上每次 bash 调用白付 50~85ms 且卡住事件循环。
 * 探到的结果进程级缓存（createShellPathResolver）。
 *
 * 不认 `C:\Windows\System32\bash.exe`（旧式 WSL 入口）：它要从 stdin 喂命令，现在的执行环境按 `-c` 传，
 * 交给它只会每条命令都失败；跳过它，接着找 PATH 里后面的 bash。
 */
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join, win32 } from "node:path";

function exists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** 这个路径能不能当 `shellPath`：必须是绝对路径且存在（裸名 `sh` 之类交下去只会「找不到」） */
function usableShellPath(path: string): boolean {
  return isAbsolute(path) && exists(path);
}

function isLegacyWslBash(path: string, env: NodeJS.ProcessEnv): boolean {
  const normalized = win32.normalize(path).toLowerCase();
  const systemRoot = env["SystemRoot"] ?? env["SYSTEMROOT"] ?? "C:\\Windows";
  return ["System32", "Sysnative"].some((dir) => normalized === win32.join(systemRoot, dir, "bash.exe").toLowerCase());
}

/** 按平台的查找顺序找 bash；找不到给 undefined（Windows 没装 Git Bash 时，bash 工具在执行时报错） */
export function findBash(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, fileExists: (path: string) => boolean = exists): string | undefined {
  const pathDirs = (env["PATH"] ?? env["Path"] ?? "").split(platform === "win32" ? ";" : delimiter).filter((dir) => dir !== "");
  if (platform === "win32") {
    const candidates = [env["ProgramFiles"], env["ProgramFiles(x86)"]].flatMap((root) => (root === undefined || root === "" ? [] : [`${root}\\Git\\bin\\bash.exe`]));
    const known = candidates.find(fileExists);
    if (known !== undefined) return known;
    return pathDirs.map((dir) => win32.join(dir, "bash.exe")).find((path) => !isLegacyWslBash(path, env) && fileExists(path));
  }
  if (fileExists("/bin/bash")) return "/bin/bash";
  return pathDirs.map((dir) => join(dir, "bash")).find(fileExists);
}

/**
 * 造一个带进程级缓存的探测器。
 *
 * `find` 探到给路径、探不到给 `undefined`。
 *
 * **只缓存成功**：探不到就每轮重试（那几个 `existsSync` 本身是廉价的），
 * 于是用户在会话进行中装好 Git Bash，下一轮就能用上，不需要重启应用。
 * 缓存了失败路径反而会让「装完了还是不生效」变成要查的 bug。
 *
 * 同一枚硬币的另一面（已知代价）：缓存命中后**不再复查存在性**——钉住的 bash 若在
 * 应用存活期间被卸载/挪走，bash 工具每次执行都报找不到 shell，直到重启
 * 应用才回到探测。取「装好即生效」舍「卸载即自愈」：中途卸载是罕见事件，且失败是
 * 响亮的（直接报错，不是静默走错 shell），一眼能查。
 */
export function createShellPathResolver(
  find: () => string | undefined = () => findBash(),
  isUsable: (path: string) => boolean = usableShellPath,
): () => string | undefined {
  let cached: string | undefined;
  return () => {
    if (cached !== undefined) return cached;
    const found = find();
    if (found !== undefined && isUsable(found)) cached = found;
    return cached;
  };
}
