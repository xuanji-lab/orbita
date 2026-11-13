/**
 * 缺宏包反查 —— 日志里的文件名 → 发行版的包名 → 安装命令。
 *
 * 为什么不在 renderer 里拼 `tlmgr install <文件名去掉扩展名>`（#282 的做法）：
 *
 *   - **文件名不等于包名。** `ctexart.cls` 属于 `ctex`，`tikzlibrary…` 属于 `pgf`，
 *     `algorithm2e.sty` 属于 `algorithm2e`；TeX Live 里还有大量 `texlive-*` 的伞包。
 *     猜错的名字会装进一个不存在的包，tlmgr 报错，用户还以为是我们的 bug。
 *   - 反查要起 `kpsewhich` / `tlmgr` / `mpm`，renderer 没有起外部进程的授权，那是主进程的事。
 *
 * 三条命令（都随 TeX 发行版一起装，不新增依赖）：
 *
 *   kpsewhich --all <file>            本机能不能定位到这个文件（探的是**当前 TeX 树**）
 *   tlmgr search --file /<file>       TeX Live：本地 tlpdb 里哪个包包含这个路径
 *   mpm --find-file=<file>            MiKTeX：哪个包包含这个文件
 *
 * 关于 `tlmgr search --global`：那是**查远端仓库**，要联网，而且跨年度（本机 2025 ↔
 * 远端 2026）时它会直接拒绝执行（2026-10-24 本机实测：7.5 秒后只打印
 * 「Cross release updates are only supported with …」）。本地 tlpdb 已经列着**整个
 * 发行版**的包（装没装都有），所以这里只用本地查询：快、离线、且不会给出一个当前
 * 发行版装不上的包名。--global 只在「本地库缺一个只在更新版本里出现的包」时才有用，
 * 而那种情况下 tlmgr 本来就拒绝跨版本安装。
 *
 * **名字来自编译日志，等于来自 .tex 文件内容**，所以要拼进命令的字符串只接受
 * `x.sty` / `x.cls` 的白名单形状；别的形状直接回「未知包」，不去拼。
 *
 * 失败一律不抛：没有命令、超时、退出码非零都只是「反查不到」，问题抽屉照常显示
 * （它显示的是文件名，不是这里的结果）。结果按文件名缓存——同一次会话里重编十遍，
 * 不该起十遍 tlmgr（它一次要 3 秒上下）。
 */
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import {
  LATEX_MAX_PACKAGE_LOOKUPS,
  type LatexPackageDistro,
  type LatexPackageReason,
  type LatexResolvedPackage,
} from "../../shared/latex.ts";

/** 单条反查命令的等待上限：tlmgr 起 Perl 在这台机器上 3–4 秒，冷盘也够用 */
const LOOKUP_TIMEOUT_MS = 20_000;

/** 输出上限：tlmgr search 对一个泛匹配可能回几十行，1 MB 已经远超正常需要 */
const LOOKUP_OUTPUT_LIMIT = 1024 * 1024;

export interface PackageRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** 起不来的原因（ENOENT / EACCES…）；非 null 时 `code` 无意义 */
  spawnError: string | null;
}

export interface PackageDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  exists(path: string): boolean;
  /** 软链解析（macOS 的 /Library/TeX/texbin/tlmgr 指向 …/texlive/<年>basic/…）；失败回原样 */
  realpath(path: string): string;
  run(command: string, argv: string[]): Promise<PackageRunResult>;
}

export interface PackageDistro {
  distro: LatexPackageDistro;
  /** tlmgr / mpm 的完整路径；没认出来时 null */
  tool: string | null;
  /** 安装命令要不要 sudo */
  sudo: boolean;
  /**
   * 找到了可执行文件但它跑不起来（起不来 / 非零退出 / 版本输出为空）。
   * 与「根本没装」是两件事：前者要说「命令出错了」，后者才说「没找到 tlmgr」。
   */
  broken: boolean;
}

export interface LatexPackageLookup {
  /** 文件名的顺序与请求一致；不认识的形状也各自给一条（packageName=null） */
  resolve(missing: readonly string[]): Promise<LatexResolvedPackage[]>;
}

/** `x.sty` / `x.cls`，其余一律不碰。名字来自日志，不能让它变成命令参数的注入面 */
const LOOKUPABLE = /^[A-Za-z0-9][A-Za-z0-9._+-]*\.(?:sty|cls)$/i;

/**
 * 包名的形状（tlmgr / mpm 的包名：字母数字加 `._+-`，没有空白）。反查结果也要过这一关：
 * 包名虽然来自本地 tlpdb、理论上不是攻击面，但 `parseTlmgrSearch` 只要「顶格且带冒号」，
 * 一条畸形的库行（`ctex;curl$IFS…:`）就能穿过去进到拼命令的那一步——纵深防御不嫌多。
 */
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export function isLookupableFile(missing: string): boolean {
  return LOOKUPABLE.test(missing.trim());
}

/**
 * `tlmgr search --file` 的输出：
 *
 *   ctex:
 *   	texmf-dist/tex/latex/ctex/ctexart.cls
 *
 * 包名是顶格、以冒号结尾的那几行（缩进行是路径）。tlmgr 自己的错误 / 提示
 * （`tlmgr.pl: …`）带空格——包名形状校验（PACKAGE_NAME）会把它们和任何畸形行一起挡掉。
 */
export function parseTlmgrSearch(stdout: string): string[] {
  const names: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.endsWith(":")) continue;
    const name = line.slice(0, -1).trim();
    if (!PACKAGE_NAME.test(name)) continue;
    names.push(name);
  }
  return [...new Set(names)];
}

/**
 * `mpm --find-file=<file>` 的输出。MiKTeX 各版本写法不完全一致：可能是裸的包名，
 * 也可能带 `Package: ` 前缀——两种都认，夹着空格的长句子一律不当包名。
 */
export function parseMpmFind(stdout: string): string[] {
  const names: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const prefixed = /^package\s*:\s*(\S+)$/i.exec(line);
    const name = prefixed === null ? line : (prefixed[1] ?? "");
    if (!PACKAGE_NAME.test(name)) continue;
    names.push(name);
  }
  return [...new Set(names)];
}

/** 安装命令。sudo 只加前缀，**不代替用户输密码**（终端里的人自己输） */
export function installCommandFor(distro: LatexPackageDistro, packageName: string, sudo: boolean): string | null {
  // 包名过不了形状校验就**不给命令**：拼进终端的字符串不接受可疑字符
  if (distro === null || !PACKAGE_NAME.test(packageName)) return null;
  const prefix = sudo ? "sudo " : "";
  return distro === "miktex" ? `${prefix}mpm --install=${packageName}` : `${prefix}tlmgr install ${packageName}`;
}

/**
 * macOS 上什么时候要 sudo。**BasicTeX / MacTeX 都装进 root 拥有的
 * `/usr/local/texlive`**（BasicTeX 是 `/usr/local/texlive/<年>basic`），tlmgr 写那里
 * 必须提权；Homebrew 的 texlive 在 `/opt/homebrew`（用户拥有的）不需要。
 * 判据用软链解析后的真路径：`/Library/TeX/texbin/tlmgr` 本身看不出是哪一档。
 */
export function needsSudo(platform: NodeJS.Platform, toolPath: string, realpath: (path: string) => string): boolean {
  if (platform !== "darwin") return false;
  const resolved = realpath(toolPath).replace(/\\/g, "/").toLowerCase();
  return resolved.startsWith("/usr/local/texlive/");
}

/**
 * 一个工具的可执行文件候选：**先看 latexmk 同目录**（TeX Live / MiKTeX 都把整套
 * 命令装在一起），再顺着 PATH 找。Windows 上 tlmgr 是 `.bat`——
 * `execFile` 直接起不了它，`run` 会套一层 cmd。
 */
function toolCandidates(base: string, deps: PackageDeps, latexmk: string | null): string[] {
  const names =
    deps.platform === "win32"
      ? [`${base}.exe`, `${base}.bat`, `${base}.cmd`, base]
      : [base];
  const dirs: string[] = [];
  if (latexmk !== null && latexmk !== "") dirs.push(dirname(latexmk));
  const pathKey =
    deps.platform === "win32"
      ? Object.keys(deps.env).find((name) => name.toUpperCase() === "PATH")
      : "PATH";
  const value = pathKey === undefined ? undefined : deps.env[pathKey];
  if (value !== undefined && value !== "") {
    for (const part of value.split(deps.platform === "win32" ? ";" : delimiter)) {
      const dir = part.trim().replace(/^"(.*)"$/, "$1");
      if (dir !== "") dirs.push(dir);
    }
  }
  if (latexmk !== null && latexmk !== "") {
    return [...new Set(dirs.map((dir) => names.map((name) => join(dir, name))).flat())];
  }
  // 连 latexmk 都不知道在哪：退回裸名字，让 OS 顺着 PATH 找
  return [base, ...names];
}

async function findTool(base: string, deps: PackageDeps, latexmk: string | null): Promise<string | null> {
  const candidates = toolCandidates(base, deps, latexmk);
  for (const candidate of candidates) {
    // 裸名字没有目录，exists 判断不了，交给 run 的 ENOENT
    if (!candidate.includes("/") && !candidate.includes("\\")) return candidate;
    if (deps.exists(candidate)) return candidate;
  }
  return null;
}

export function createLatexPackageLookup(
  latexmk: () => Promise<string | null>,
  deps: PackageDeps = realDeps(),
): LatexPackageLookup {
  /** 同一个文件的结论不随编译次数变；一次会话里重编多遍只查一次 */
  const cache = new Map<string, LatexResolvedPackage>();
  let distro: Promise<PackageDistro> | null = null;

  const detect = (path: string | null): Promise<PackageDistro> => {
    if (distro !== null) return distro;
    distro = (async (): Promise<PackageDistro> => {
      let broken = false;
      const tlmgr = await findTool("tlmgr", deps, path);
      if (tlmgr !== null) {
        const outcome = await runTool(deps, tlmgr, ["--version"]);
        // 退出码 0 **还不够**：TeX Live 的 tlmgr.bat 在 tlpkg 缺失时最后一条是
        // `if not exist … goto :eof`，cmd 会照样回 0 而 stdout 是空的（真机实测：
        // 只把 bat 复制到别处就会这样）。没有版本输出就等于没跑成。
        if (outcome !== null && outcome.code === 0 && outcome.stdout.trim() !== "") {
          return { distro: "texlive", tool: tlmgr, sudo: needsSudo(deps.platform, tlmgr, deps.realpath), broken: false };
        }
        broken = true;
      }
      const mpm = await findTool("mpm", deps, path);
      if (mpm !== null) {
        const outcome = await runTool(deps, mpm, ["--version"]);
        if (outcome !== null && outcome.code === 0 && outcome.stdout.trim() !== "") {
          return { distro: "miktex", tool: mpm, sudo: false, broken: false };
        }
        broken = true;
      }
      return { distro: null, tool: null, sudo: false, broken };
    })();
    return distro;
  };

  const lookupOne = async (missing: string, latexmkPath: string | null): Promise<LatexResolvedPackage> => {
    const name = missing.trim();
    const empty: LatexResolvedPackage = {
      missing: name,
      packageName: null,
      command: null,
      sudo: false,
      installed: false,
      distro: null,
      // 白名单不过时**必须说出来是哪一种**：旧版把它和「没装 tlmgr」混成一个 null，
      // 界面对着一台装着 TeX Live 的机器说「没找到 tlmgr」，用户会去装不存在的工具
      reason: "invalid-name",
    };
    if (!isLookupableFile(name)) return empty;

    const kpsewhich = await findTool("kpsewhich", deps, latexmkPath);
    const found = kpsewhich === null ? null : await runTool(deps, kpsewhich, ["--all", name]);
    // kpsewhich 命中 = 当前 TeX 树里就有这个文件：别再建议安装（日志多半是旧的，
    // 或者 latexmk 与 kpsewhich 来自两套不同的发行版）
    const installed = found !== null && found.code === 0 && found.stdout.trim() !== "";

    const env = await detect(latexmkPath);
    if (env.distro === null || env.tool === null) {
      // 工具在却跑不起来 → 说「命令出错」，别让用户以为没装发行版
      return { ...empty, installed, reason: env.broken ? "tool-error" : "no-tools" };
    }

    // 失败也分两种：命令没跑成（tool-error）vs 跑成了但没有包认领这个文件（not-found）
    const lookup =
      env.distro === "miktex"
        ? await mpmLookup(deps, env.tool, name)
        : await tlmgrLookup(deps, env.tool, name);
    const packageName = pickPackage(lookup.names);
    if (packageName === null) {
      return {
        ...empty,
        installed,
        distro: env.distro,
        reason: lookup.ok ? "not-found" : "tool-error",
      };
    }
    return {
      missing: name,
      packageName,
      // 已经在盘上就不给安装命令：装第二遍不是用户要的下一步
      command: installed ? null : installCommandFor(env.distro, packageName, env.sudo),
      sudo: env.sudo,
      installed,
      distro: env.distro,
      reason: null,
    };
  };

  return {
    async resolve(missing: readonly string[]): Promise<LatexResolvedPackage[]> {
      const wanted = [...new Set(missing.map((name) => name.trim()))].filter((name) => name !== "");
      const latexmkPath = await latexmk().catch(() => null);
      const asked = wanted.slice(0, LATEX_MAX_PACKAGE_LOOKUPS);
      // 上限之外的名字也各给一条明确结局，界面才不会永远停在「正在反查」
      const rest: LatexResolvedPackage[] = wanted.slice(LATEX_MAX_PACKAGE_LOOKUPS).map((name) => ({
        missing: name,
        packageName: null,
        command: null,
        sudo: false,
        installed: false,
        distro: null,
        reason: "not-looked-up",
      }));
      // 并发三：一条 tlmgr 起一个 Perl（本机 3–4 秒），串行时三个缺包要 12 秒；
      // 三并发既把等待压到一条的量级，又不会一次摊开一堆进程
      const resolved = await mapWithConcurrency(asked, 3, async (name) => {
        const cached = cache.get(name);
        if (cached !== undefined) return cached;
        const entry = await lookupOne(name, latexmkPath);
        cache.set(name, entry);
        return entry;
      });
      return [...resolved, ...rest];
    },
  };
}

/** 有并发上限的 map：结果顺序与输入一致 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 多个包都包含这个文件时挑一个。TeX Live 的 `*-dev` 是 latex-dev 树里的镜像：
 * `tabularx.sty` 同时属于 `tools` 与 `latex-tools-dev`，真机实测 tlmgr 把 dev 排前面——
 * 照着装会装进开发树。优先非 `-dev`，其余按 tlmgr 给的顺序。
 */
export function pickPackage(names: readonly string[]): string | null {
  return names.find((name) => !/-dev$/i.test(name)) ?? names[0] ?? null;
}

interface NameLookup {
  names: string[];
  /** 命令本身跑成了吗——false 与「跑成但没命中」是两件事（前者可能是 tlmgr 起不来） */
  ok: boolean;
}

async function tlmgrLookup(deps: PackageDeps, tool: string, name: string): Promise<NameLookup> {
  // 前导斜杠让 tlmgr 按「路径结尾」匹配：`/ctexart.cls`，不会命中 `myctexart.cls.bak`
  const outcome = await runTool(deps, tool, ["search", "--file", `/${name}`]);
  if (outcome === null || outcome.code !== 0) return { names: [], ok: false };
  return { names: parseTlmgrSearch(outcome.stdout), ok: true };
}

async function mpmLookup(deps: PackageDeps, tool: string, name: string): Promise<NameLookup> {
  const outcome = await runTool(deps, tool, [`--find-file=${name}`]);
  if (outcome === null || outcome.code !== 0) return { names: [], ok: false };
  return { names: parseMpmFind(outcome.stdout), ok: true };
}

/** 跑一条反查命令；起不来 / 超时回 null（反查失败不该变成一条异常） */
async function runTool(
  deps: PackageDeps,
  command: string,
  argv: string[],
): Promise<PackageRunResult | null> {
  const outcome = await deps.run(command, argv);
  if (outcome.spawnError !== null) return null;
  return outcome;
}

/** 一次命令调用的形状（.bat 要借 cmd；判它走哪条路是纯函数，可单测） */
export interface CommandInvocation {
  file: string;
  args: string[];
  /** true = 让 Node 原样拼命令行（.bat 的引号必须由我们自己控制） */
  windowsVerbatimArguments: boolean;
}

/**
 * 一条命令该怎么起。Windows 上 tlmgr 是 .bat（TeX Live 的安装器给的就是批处理）：
 * execFile 起不了它，必须借 cmd。这里唯一的难点是**路径带空格时的引号形状**
 * （MiKTeX 默认装在用户的 AppData 下、TeX Live 也可能装进 `Program Files`，
 * 用户名带空格很常见）：
 *
 *   cmd /d /s /c ""C:\path with space\tlmgr.bat" --version"
 *
 * `/s` 会剥掉 `/c` 之后整串的**外层**引号，所以整条命令自己再包一层；少了这层，
 * 空格把 .bat 路径拆成两个词（实测报「'…\Program' 不是内部或外部命令」）。
 * `windowsVerbatimArguments` 让 Node 原样拼这条命令行——默认它会再给参数补引号，
 * 补完再被 /s 剥一次，正好回到引号错位。
 *
 * 参数已经在 LOOKUPABLE / 包名白名单里筛过，没有空格与引号，所以直接拼。
 */
export function commandInvocation(
  command: string,
  argv: readonly string[],
  platform: NodeJS.Platform,
): CommandInvocation {
  const bat = platform === "win32" && /\.(?:bat|cmd)$/i.test(command);
  if (!bat) return { file: command, args: [...argv], windowsVerbatimArguments: false };
  return {
    file: "cmd.exe",
    args: ["/d", "/s", "/c", `""${command}" ${argv.join(" ")}"`],
    windowsVerbatimArguments: true,
  };
}

/** 生产依赖：真盘 + 真 execFile */
function realDeps(): PackageDeps {
  return {
    platform: process.platform,
    env: process.env,
    exists: (path) => existsSync(path),
    realpath: (path) => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    },
    run: (command, argv) =>
      new Promise((resolvePromise) => {
        const invocation = commandInvocation(command, argv, process.platform);
        execFile(
          invocation.file,
          invocation.args,
          {
            timeout: LOOKUP_TIMEOUT_MS,
            windowsHide: true,
            maxBuffer: LOOKUP_OUTPUT_LIMIT,
            windowsVerbatimArguments: invocation.windowsVerbatimArguments,
          },
          (error, stdout, stderr) => {
            if (error === null) {
              resolvePromise({ code: 0, stdout, stderr, spawnError: null });
              return;
            }
            const code = (error as NodeJS.ErrnoException).code;
            // 字符串 code = 进程没起来（ENOENT / EACCES）；数字 = 起来了但非零退出
            if (typeof code === "string") {
              resolvePromise({ code: null, stdout, stderr, spawnError: code });
              return;
            }
            resolvePromise({ code: typeof code === "number" ? code : null, stdout, stderr, spawnError: null });
          },
        );
      }),
  };
}
