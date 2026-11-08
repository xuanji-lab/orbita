/**
 * 连接目录契约 —— IPC 四层的第 1 层。
 *
 * 「连接」= 能力页里一排**待配置的品牌入口**（飞书、GitHub、腾讯文档……），带品牌标，
 * 点「配置」让智能体带用户接好。目录**只放稳定信息**：官方入口、命令名、MCP 地址、认证方式的**类别**。
 * 各家的 MCP / CLI 会变（2026-11-08 核对时就有三家与几个月前的社区目录不一样），所以
 * **具体怎么配不写死在这里**——交给智能体现查官方文档（见 `connectorSetupPrompt` 里的规矩）。
 *
 * 两条原则：
 * - **状态一律来自实测**：命令行跑官方状态命令、MCP 真连一次。「已连接」不是我们写的，是探出来的。
 * - **说明文字与能力词不在这里**：它们是界面文案，住在 renderer 的 messages 里（中英各一份），
 *   这里只有语言无关的事实。
 *
 * 品牌标是「图标只用 lucide」规矩的一个**用户批准的例外**（2026-11-08）：它们是各家的标，
 * 不是我们的图标，文件在 `design-system/assets/connector-logos/`。
 */
import type { McpHttpServer } from "./mcp.ts";

export const CONNECTOR_IDS = [
  "feishu",
  "dingtalk",
  "wecom",
  "github",
  "tabbit",
  "tencent-docs",
  "ctrip",
  "baidu-netdisk",
  "notion",
  "supabase",
] as const;

export type ConnectorId = (typeof CONNECTOR_IDS)[number];

/**
 * 接入形态：
 * - `cli`：官方命令行（可兼带官方远程 MCP，GitHub）；点「配置」开会话让智能体带着装 / 登录
 * - `mcp-token`：远程 MCP，只需用户贴一个 token——卡内就地填，不开会话
 * - `guided`：要用户去官方页拿凭据、再配 skill / token，步骤多——开会话让智能体带着走
 * - `coming-soon`：远程 MCP 但要 OAuth，Orbita 还不支持——没有「配置」按钮
 */
export type ConnectorKind = "cli" | "mcp-token" | "guided" | "coming-soon";

/** 接入方式小标（卡片第二行的灰底药丸）。命令名是机器事实，界面用等宽字。 */
export type ConnectorVia =
  | { kind: "cli"; command: string }
  | { kind: "cli-builtin" }
  | { kind: "mcp" }
  | { kind: "token"; bearer: boolean }
  | { kind: "skill" }
  | { kind: "oauth" };

/** 品牌标：文件在 design-system/assets/connector-logos/。`mono` = 单色标，暗色下跟字色（currentColor）。 */
export interface ConnectorLogo {
  file: string;
  mono: boolean;
}

/** 远程 MCP 的稳定事实（地址与传输）。`tokenHeader` 有 = 卡内就地填 token。 */
export interface ConnectorMcp {
  /** 写进 mcp.json 的 server 名（也是模型看到的 `mcp__<名>__<工具>` 前缀） */
  serverName: string;
  url: string;
  transport: "http" | "sse";
  /** token 放哪个请求头、带什么前缀（腾讯文档要**原样** token，百度网盘要 `Bearer `） */
  tokenHeader?: { name: string; prefix: string };
}

export interface ConnectorEntry {
  id: ConnectorId;
  kind: ConnectorKind;
  logo: ConnectorLogo;
  via: readonly ConnectorVia[];
  /** 官方入口（文档 / 仓库）：交给智能体去核验现行接入方式 */
  officialUrl: string;
  /** 这批事实最后一次对照官方来源的日期（目录会过期，这个日期让人知道多旧） */
  verifiedOn: string;
  /**
   * 官方命令行。`statusArgs` = 官方的「是否已登录」命令（**不能是会打开浏览器标签页的**）；
   * 缺席 = 只认命令存在（Tabbit：没有已知的只读状态命令）。
   */
  cli?: { command: string; statusArgs?: readonly string[]; notAuthedPattern?: string };
  /** 必须都存在才算接好的本机文件（相对用户主目录）。Tabbit 的 skill 由浏览器自动装进来 */
  localFiles?: readonly string[];
  mcp?: ConnectorMcp;
}

const VERIFIED_ON = "2026-11-08";

/**
 * 命令行状态命令的「其实没登录」文案：有些 CLI 没登录也退出 0，只在输出里说一句。
 * 只作用于退出 0 的情况；覆盖中英常见说法。**对 lark-cli / dws / wecom-cli 没有真机验证过**
 * （核对时本机没装），先按退出码为主、这条兜底。
 */
const NOT_AUTHED = "not (logged|signed) in|not authenticated|unauthenticated|no (valid )?(credential|token|account|login)|未登录|未授权|未认证|未配置|请先登录";

/** 目录顺序固定（即将支持的沉底）：连上之后卡片不跳位，用户的位置记忆不被打乱。 */
export const CONNECTORS: readonly ConnectorEntry[] = [
  {
    id: "feishu",
    kind: "cli",
    logo: { file: "feishu.svg", mono: false },
    via: [{ kind: "cli", command: "lark-cli" }],
    officialUrl: "https://github.com/larksuite/cli",
    verifiedOn: VERIFIED_ON,
    cli: { command: "lark-cli", statusArgs: ["auth", "status"], notAuthedPattern: NOT_AUTHED },
  },
  {
    id: "dingtalk",
    kind: "cli",
    logo: { file: "dingtalk.png", mono: false },
    via: [{ kind: "cli", command: "dws" }],
    officialUrl: "https://open.dingtalk.com/document/development/dingtalk-cli-performing-tasks-within",
    verifiedOn: VERIFIED_ON,
    cli: { command: "dws", statusArgs: ["auth", "status"], notAuthedPattern: NOT_AUTHED },
  },
  {
    id: "wecom",
    kind: "cli",
    logo: { file: "wecom.png", mono: false },
    via: [{ kind: "cli", command: "wecom-cli" }],
    officialUrl: "https://open.work.weixin.qq.com/help2/pc/21676",
    verifiedOn: VERIFIED_ON,
    cli: { command: "wecom-cli", statusArgs: ["auth", "show"], notAuthedPattern: NOT_AUTHED },
  },
  {
    id: "github",
    kind: "cli",
    logo: { file: "github.svg", mono: true },
    via: [{ kind: "cli", command: "gh" }, { kind: "mcp" }],
    officialUrl: "https://cli.github.com/",
    verifiedOn: VERIFIED_ON,
    // 命令行与官方远程 MCP 是同一张卡的两条路，任一条实测通了就算连上
    cli: { command: "gh", statusArgs: ["auth", "status"] },
    mcp: { serverName: "github", url: "https://api.githubcopilot.com/mcp/", transport: "http" },
  },
  {
    id: "tabbit",
    kind: "cli",
    logo: { file: "tabbit.png", mono: false },
    via: [{ kind: "cli-builtin" }, { kind: "skill" }],
    officialUrl: "https://www.tabbit.ai/blog/2026-09-18-tabbit-cli-quick-start",
    verifiedOn: VERIFIED_ON,
    // Tabbit 浏览器自带命令行与 skill，没有已知的只读状态命令（diagnose 是否会拉起浏览器未核实）：
    // 命令与 skill 文件都在，就算接好
    cli: { command: "tabbit-cli" },
    localFiles: [".agents/skills/tabbit/SKILL.md"],
  },
  {
    id: "tencent-docs",
    kind: "mcp-token",
    logo: { file: "tencent-docs.svg", mono: false },
    via: [{ kind: "mcp" }, { kind: "token", bearer: false }],
    officialUrl: "https://docs.qq.com/open/document/mcp/",
    verifiedOn: VERIFIED_ON,
    mcp: {
      serverName: "tencent-docs",
      url: "https://docs.qq.com/openapi/mcp",
      transport: "http",
      // 官方明确：请求头名必须是 Authorization，值是 token 原样，不加 Bearer
      tokenHeader: { name: "Authorization", prefix: "" },
    },
  },
  {
    id: "ctrip",
    kind: "guided",
    logo: { file: "ctrip.png", mono: false },
    via: [{ kind: "token", bearer: false }, { kind: "skill" }],
    officialUrl: "https://www.ctrip.com/wendao/openclaw",
    verifiedOn: VERIFIED_ON,
  },
  {
    id: "baidu-netdisk",
    kind: "mcp-token",
    logo: { file: "baidu-netdisk.png", mono: false },
    via: [{ kind: "mcp" }, { kind: "token", bearer: true }],
    officialUrl: "https://pan.baidu.com/union/doc/mcp-server/%E6%93%8D%E4%BD%9C%E6%8C%87%E5%8D%97/%E5%9C%A8-agent-%E4%B8%AD%E8%87%AA%E5%AE%9A%E4%B9%89%E4%BD%BF%E7%94%A8",
    verifiedOn: VERIFIED_ON,
    mcp: {
      serverName: "baidu-netdisk",
      url: "https://mcp-pan.baidu.com/sse",
      transport: "sse",
      tokenHeader: { name: "Authorization", prefix: "Bearer " },
    },
  },
  {
    id: "notion",
    kind: "coming-soon",
    logo: { file: "notion.svg", mono: true },
    via: [{ kind: "mcp" }, { kind: "oauth" }],
    officialUrl: "https://developers.notion.com/guides/mcp/get-started-with-mcp",
    verifiedOn: VERIFIED_ON,
    mcp: { serverName: "notion", url: "https://mcp.notion.com/mcp", transport: "http" },
  },
  {
    id: "supabase",
    kind: "coming-soon",
    logo: { file: "supabase.svg", mono: false },
    via: [{ kind: "mcp" }, { kind: "oauth" }],
    officialUrl: "https://supabase.com/docs/guides/ai-tools/mcp",
    verifiedOn: VERIFIED_ON,
    mcp: { serverName: "supabase", url: "https://mcp.supabase.com/mcp", transport: "http" },
  },
];

export function findConnector(id: string): ConnectorEntry | undefined {
  return CONNECTORS.find((entry) => entry.id === id);
}

/** 点「配置」是不是会开一条会话（cli / guided）；mcp-token 卡内就地填，coming-soon 没有配置。 */
export function opensSetupSession(entry: ConnectorEntry): boolean {
  return entry.kind === "cli" || entry.kind === "guided";
}

// ───────────────────────────── 状态 ─────────────────────────────

/** 为什么是「未配置」（给卡片一句具体的话；不是错误） */
export type ConnectorUnsetReason = "cli-missing" | "not-logged-in" | "no-config" | "disabled";

/** 连接是靠哪条通路测通的 */
export type ConnectorTestedBy = "cli" | "mcp" | "local";

export type ConnectorStatus =
  | { kind: "unset"; reason: ConnectorUnsetReason }
  | { kind: "connected"; by: ConnectorTestedBy; tools?: number }
  /** 探测本身出了事（超时 / 没权限 / MCP 连不上）。`code` 让界面把已知的几种说成本地话，其余原样显示 message */
  | { kind: "failed"; code: "timeout" | "error" | "mcp"; message: string }
  | { kind: "coming-soon" };

/** 命令行探测的原始事实（主进程跑完交给纯函数推导，好测） */
export interface CliRun {
  /** 在固定 PATH 里找到了可执行文件 */
  found: boolean;
  /** 状态命令退出码；没跑状态命令（条目没给 / 没找到）为 null */
  exitCode: number | null;
  /** stdout + stderr 合并，已截断 */
  output: string;
  timedOut: boolean;
  /** 启动就失败（没权限、坏文件）的原因；ENOENT 算 found=false 不算它 */
  spawnError: string | null;
}

/** 远程 MCP 探测的原始事实 */
export interface McpProbeFacts {
  /** mcp.json 里有这条 */
  present: boolean;
  disabled: boolean;
  /** 真连了一次：成功带工具数，失败带原因；没连（没条目 / 停用）为 null */
  probe: { ok: true; tools: number } | { ok: false; message: string } | null;
}

export interface ConnectorFacts {
  cli?: CliRun;
  /** `localFiles` 是否全在 */
  filesOk?: boolean;
  mcp?: McpProbeFacts;
}

function cliStatus(entry: ConnectorEntry, run: CliRun, filesOk: boolean): ConnectorStatus {
  const cli = entry.cli;
  if (cli === undefined || !run.found) return { kind: "unset", reason: "cli-missing" };
  if (run.timedOut) return { kind: "failed", code: "timeout", message: "" };
  if (run.spawnError !== null) return { kind: "failed", code: "error", message: run.spawnError };
  if (cli.statusArgs === undefined) {
    // 没有状态命令：命令在，再看配套文件（Tabbit 的 skill）
    return filesOk ? { kind: "connected", by: "local" } : { kind: "unset", reason: "no-config" };
  }
  if (run.exitCode !== 0) return { kind: "unset", reason: "not-logged-in" };
  if (cli.notAuthedPattern !== undefined && new RegExp(cli.notAuthedPattern, "i").test(run.output)) {
    return { kind: "unset", reason: "not-logged-in" };
  }
  return { kind: "connected", by: "cli" };
}

function mcpStatus(facts: McpProbeFacts): ConnectorStatus {
  if (!facts.present) return { kind: "unset", reason: "no-config" };
  if (facts.disabled) return { kind: "unset", reason: "disabled" };
  if (facts.probe === null) return { kind: "unset", reason: "no-config" };
  return facts.probe.ok
    ? { kind: "connected", by: "mcp", tools: facts.probe.tools }
    : { kind: "failed", code: "mcp", message: facts.probe.message };
}

/**
 * 把各条通路的实测事实合成一张卡的状态。**已连接 > 连接失败 > 未配置**：
 * 任一条通路实测通了就是连上了（GitHub 的 gh 与远程 MCP）；有通路坏了且没有更好的，如实报失败；
 * 都没配才是未配置，原因取最具体的那条（命令行优先于 MCP——它是第一入口）。
 */
export function deriveConnectorStatus(entry: ConnectorEntry, facts: ConnectorFacts): ConnectorStatus {
  if (entry.kind === "coming-soon") return { kind: "coming-soon" };
  const channels: ConnectorStatus[] = [];
  if (entry.cli !== undefined && facts.cli !== undefined) channels.push(cliStatus(entry, facts.cli, facts.filesOk === true));
  if (entry.mcp !== undefined && facts.mcp !== undefined) channels.push(mcpStatus(facts.mcp));
  const connected = channels.find((status) => status.kind === "connected");
  if (connected !== undefined) return connected;
  const failed = channels.find((status) => status.kind === "failed");
  if (failed !== undefined) return failed;
  return channels[0] ?? { kind: "unset", reason: "no-config" };
}

// ───────────────────────────── token ─────────────────────────────

export type TokenProblem = "empty" | "invalid" | "too-long";

export type TokenCheck = { ok: true; token: string } | { ok: false; problem: TokenProblem };

const TOKEN_MAX = 4096;

/**
 * 用户贴进来的 token → 能放进请求头的值。
 * 去首尾空白与成对引号；带 `Bearer ` 前缀的条目（百度网盘）容忍用户连前缀一起贴，剥掉免得变成 `Bearer Bearer x`；
 * 其余必须是可见 ASCII（请求头里放换行或中文是注入 / 乱码的入口，直接拒绝，不替用户「清理」）。
 */
export function normalizeConnectorToken(entry: ConnectorEntry, raw: string): TokenCheck {
  let token = raw.trim();
  if (token.length >= 2 && ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))) {
    token = token.slice(1, -1).trim();
  }
  if (entry.mcp?.tokenHeader?.prefix.toLowerCase() === "bearer ") token = token.replace(/^bearer\s+/i, "");
  if (token === "") return { ok: false, problem: "empty" };
  if (token.length > TOKEN_MAX) return { ok: false, problem: "too-long" };
  if (!/^[\x21-\x7e]+$/.test(token)) return { ok: false, problem: "invalid" };
  return { ok: true, token };
}

/** 一张 mcp-token 卡 + 已校验的 token → 写进 mcp.json 的那条。不是 mcp-token 卡返回 null。 */
export function connectorServerConfig(entry: ConnectorEntry, token: string): McpHttpServer | null {
  const mcp = entry.mcp;
  if (entry.kind !== "mcp-token" || mcp?.tokenHeader === undefined) return null;
  return {
    transport: mcp.transport,
    url: mcp.url,
    headers: { [mcp.tokenHeader.name]: `${mcp.tokenHeader.prefix}${token}` },
  };
}

// ───────────────────────────── IPC ─────────────────────────────

export type ConnectorSaveResult =
  | { ok: true; status: ConnectorStatus }
  | { ok: false; code: TokenProblem | "unsupported" | "write-failed"; message: string };

// ───────────────────────────── 配置引导 ─────────────────────────────

export type ConnectorGuideMode = "setup" | "manage";

type GuideLocale = "zh" | "en";

/** 给智能体的线索：目录里记的稳定事实，一行一条（会过期，所以前面写明「先核验」） */
function leads(entry: ConnectorEntry, locale: GuideLocale): string[] {
  const zh = locale === "zh";
  const lines: string[] = [];
  if (entry.cli !== undefined) {
    const status = entry.cli.statusArgs === undefined ? "" : zh ? `，官方状态命令 \`${entry.cli.command} ${entry.cli.statusArgs.join(" ")}\`` : `, official status command \`${entry.cli.command} ${entry.cli.statusArgs.join(" ")}\``;
    lines.push(zh ? `命令行：\`${entry.cli.command}\`${status}` : `CLI: \`${entry.cli.command}\`${status}`);
  }
  if (entry.localFiles !== undefined) {
    lines.push(zh ? `本机应有的文件：${entry.localFiles.map((file) => `~/${file}`).join("、")}` : `Files expected on this machine: ${entry.localFiles.map((file) => `~/${file}`).join(", ")}`);
  }
  if (entry.mcp !== undefined) {
    const auth = entry.mcp.tokenHeader === undefined ? "" : zh ? `，请求头 \`${entry.mcp.tokenHeader.name}\`${entry.mcp.tokenHeader.prefix === "" ? "（值是 token 原样，不加 Bearer）" : "（值是 `Bearer <token>`）"}` : `, header \`${entry.mcp.tokenHeader.name}\`${entry.mcp.tokenHeader.prefix === "" ? " (the raw token, no Bearer)" : " (value `Bearer <token>`)"}`;
    lines.push(zh ? `远程 MCP：${entry.mcp.url}（${entry.mcp.transport === "sse" ? "SSE" : "Streamable HTTP"}）${auth}` : `Remote MCP: ${entry.mcp.url} (${entry.mcp.transport === "sse" ? "SSE" : "Streamable HTTP"})${auth}`);
  }
  return lines;
}

/**
 * 点「配置」时预填进新会话输入框的话。规矩来自 Proma 的配置提示词，按 Orbita 的做法改过：
 * 核验官方文档不猜 endpoint、登录交给用户在内置浏览器里做、凭据不进日志、「已连接」只认实测。
 * 用户能在发送前看到并改这段话——它不是藏在背后的系统提示。
 *
 * `mode: "manage"` 给已连接的卡（点「管理」）：不重新配，只复核现状、讲怎么用、怎么断开。
 */
export function connectorSetupPrompt(entry: ConnectorEntry, name: string, locale: GuideLocale, mode: ConnectorGuideMode = "setup"): string {
  const zh = locale === "zh";
  const lead = leads(entry, locale);
  const statusLine = entry.cli?.statusArgs !== undefined
    ? zh ? `跑官方状态命令 \`${entry.cli.command} ${entry.cli.statusArgs.join(" ")}\`` : `run the official status command \`${entry.cli.command} ${entry.cli.statusArgs.join(" ")}\``
    : zh ? "调用一个只读的工具（或命令）" : "call one read-only tool (or command)";
  const notes = entry.id === "github"
    ? zh
      ? "GitHub 有命令行 gh 和官方远程 MCP 两条路，先问我选哪条（也可以两条都接）。"
      : "GitHub has two routes, the gh CLI and the official remote MCP. Ask me which one first (both is fine)."
    : entry.kind === "guided"
      ? zh
        ? "这家要在官方页面登录后申请 token，再配合官方 skill 使用；请按官方页面现行步骤带我走。"
        : "This one needs a token requested on the official page after logging in, plus the official skill. Walk me through the page's current steps."
      : "";
  if (mode === "manage") {
    return zh
      ? [
          `「${name}」已经接好了。请帮我复核并讲清楚：`,
          `1. 实测一遍它现在是否可用：${statusLine}，把结果如实告诉我（别凭记忆说「正常」）。`,
          `2. 简短说它能替我做什么、第一次该怎么用。`,
          `3. 如果我想重新登录或断开它，告诉我具体步骤，但先别动手。`,
          "",
          `官方入口：${entry.officialUrl}`,
        ].join("\n")
      : [
          `"${name}" is already connected. Please re-check it and explain:`,
          `1. Test whether it works right now: ${statusLine}, and report the real result (don't say "fine" from memory).`,
          `2. In a few lines: what it can do for me and how to use it the first time.`,
          `3. If I want to log in again or disconnect it, tell me the steps, but don't do it yet.`,
          "",
          `Official entry: ${entry.officialUrl}`,
        ].join("\n");
  }
  return zh
    ? [
        `我想把「${name}」接到 Orbita 里，请你带我配好。请遵守这几条：`,
        `1. 先核验再动手：到官方入口 ${entry.officialUrl} 查现行的接入方式、安装命令和认证方式，不要凭记忆猜命令或 endpoint。下面是目录里记的线索（${entry.verifiedOn} 核对，可能已过期，以官方文档为准）：`,
        ...lead.map((line) => `   - ${line}`),
        ...(notes === "" ? [] : [`   ${notes}`]),
        `2. 需要我本人登录、授权、扫码的步骤，用内置浏览器打开页面后交给我来做，不要代我输入密码或验证码。`,
        `3. 凭据（token、Secret）只让我自己贴；不要写进日志，也不要在对话里复述。需要加 MCP 配置时用 add_mcp_server 工具。`,
        `4. 装全局软件前先告诉我要装什么、装到哪里，等我点头。`,
        `5. 「已连接」只认实测：配完后${statusLine}，把真实结果告诉我；没测过不要说连上了。`,
      ].join("\n")
    : [
        `I want to connect "${name}" to Orbita. Please walk me through it, following these rules:`,
        `1. Verify before acting: check the official entry ${entry.officialUrl} for the current way to connect, the install command and the auth method. Don't guess commands or endpoints from memory. Leads recorded in the catalog (checked ${entry.verifiedOn}, may be outdated; the official docs win):`,
        ...lead.map((line) => `   - ${line}`),
        ...(notes === "" ? [] : [`   ${notes}`]),
        `2. For steps that need me to log in, authorize or scan a code, open the page in the built-in browser and hand it to me. Don't type passwords or codes for me.`,
        `3. Credentials (tokens, secrets) are for me to paste myself; keep them out of logs and don't repeat them in the chat. Use the add_mcp_server tool when an MCP entry is needed.`,
        `4. Before installing anything globally, tell me what and where, and wait for my OK.`,
        `5. "Connected" only counts when tested: when done, ${statusLine} and tell me the real result. Don't say it works if you haven't tested it.`,
      ].join("\n");
}
