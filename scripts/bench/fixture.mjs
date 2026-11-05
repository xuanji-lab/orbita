// 素材：把一条真实长会话（zip）按轮数截成快照，铺进一个隔离的 userData。
//
// zip 里是什么（打包方式见 README）：manifest.json、session.jsonl（Orbita 自己的会话记录）、
// session.meta.json、pi-session.jsonl（pi 的会话本，agent 每轮重读它）、attachments/、snapshots/。
//
// 「第 N 轮」的口径：Orbita 会话里的用户消息，去掉被撤回的那些（撤回后重发的不重复计）。
// 6df79261 共 71 条用户消息、10 条被撤回，剩 61 轮，就是「60 轮会话」。
//
// 截法：两份 JSONL 都只追加不改写，所以「文件的前缀」就是会话当时在盘上的样子——
// 在第 N+1 轮的用户消息前一刀切下即可，不用重建树。pi 那份按同一条用户消息（文字相同、时间最近）对齐。
//
// 超出原会话的刻度（100 轮）：整条会话 + 再把前 (100−61) 轮复制一遍接在后面。
// 复制的记录换新 id（含 parentId、toolCallId、撤回目标），时间整体后移，pi 那段接到原会话最后一条下面。
// 这样体量和结构都是真实的，代价是后 39 轮的内容和前 39 轮重复（markdown 解析量一样，缓存命中不受影响：
// 渲染侧按消息 id 缓存，id 都换了）。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const hash8 = (s) => createHash("sha1").update(s).digest("hex").slice(0, 8);
const splitLines = (text) => text.split("\n").filter((l) => l.trim() !== "");
const textOf = (content) =>
  typeof content === "string" ? content : (content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");

/** 解 zip：Windows 10+ 与 macOS 自带的 tar（bsdtar）都认 zip，不用装依赖 */
export function extractFixture(zipPath, cacheDir) {
  const marker = join(cacheDir, "manifest.json");
  if (existsSync(marker)) return cacheDir;
  mkdirSync(cacheDir, { recursive: true });
  execFileSync("tar", ["-xf", zipPath, "-C", cacheDir]);
  if (!existsSync(marker)) throw new Error(`${zipPath} 里没有 manifest.json，不是测量素材包`);
  return cacheDir;
}

export function loadFixture(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const orb = splitLines(readFileSync(join(dir, "session.jsonl"), "utf8"));
  const pi = splitLines(readFileSync(join(dir, "pi-session.jsonl"), "utf8"));
  const meta = JSON.parse(readFileSync(join(dir, "session.meta.json"), "utf8"));
  const orbRecs = orb.map((l) => JSON.parse(l));
  const piRecs = pi.map((l) => JSON.parse(l));
  const reverted = new Set(orbRecs.filter((r) => r.role === "revert").map((r) => r.targetMessageId));
  // 存活的用户消息（行号）：被撤回的不算一轮
  const turnStarts = orbRecs.flatMap((r, i) => (r.role === "user" && !reverted.has(r.id) ? [i] : []));
  return { dir, manifest, orb, pi, orbRecs, piRecs, meta, turnStarts, totalTurns: turnStarts.length };
}

/**
 * pi 会话本里和 Orbita 第 k 行用户消息对应的那一行：文字相同（忽略空白——带引用的消息 Orbita 存两块、
 * pi 合成一块）、时间最近（实测两边同一条消息的时间戳到毫秒都一样）
 */
function piIndexOf(fx, orbIndex) {
  const u = fx.orbRecs[orbIndex];
  const norm = (c) => textOf(c).replace(/\s+/g, "").slice(0, 200);
  const want = norm(u.content);
  let best = -1;
  let bestGap = Infinity;
  fx.piRecs.forEach((r, i) => {
    if (r.type !== "message" || r.message?.role !== "user") return;
    if (norm(r.message.content) !== want) return;
    const gap = Math.abs(Date.parse(r.timestamp) - u.timestamp);
    if (gap < bestGap) [best, bestGap] = [i, gap];
  });
  if (best < 0 || bestGap > 60_000) throw new Error(`pi 会话本里找不到第 ${orbIndex} 行用户消息的对应项`);
  return best;
}

/**
 * 前 n 轮（n ≤ 原会话轮数）的两份行数组。切在第 n 轮之后的**第一条**用户消息前（不管它后来被没被撤回）：
 * 切在下一条存活消息前的话，尾巴会挂着一条「发了又撤回」的半截状态（撤回会把原文放回输入框）
 */
function prefix(fx, n) {
  if (n >= fx.totalTurns) return { orb: fx.orb, pi: fx.pi };
  const cut = fx.orbRecs.findIndex((r, i) => i > fx.turnStarts[n - 1] && r.role === "user");
  return { orb: fx.orb.slice(0, cut), pi: fx.pi.slice(0, piIndexOf(fx, cut)) };
}

const ID_KEYS = new Set(["id", "parentId", "targetMessageId", "toolCallId", "messageId"]);
/** 复制段换 id、时间后移：递归改所有 id 类字段与 timestamp / at */
function remap(value, shiftMs, idMap) {
  if (Array.isArray(value)) return value.map((v) => remap(v, shiftMs, idMap));
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (ID_KEYS.has(k) && typeof v === "string") out[k] = idMap(v);
    else if ((k === "timestamp" || k === "at") && typeof v === "number") out[k] = v + shiftMs;
    else if (k === "timestamp" && typeof v === "string") out[k] = new Date(Date.parse(v) + shiftMs).toISOString();
    else out[k] = remap(v, shiftMs, idMap);
  }
  return out;
}

/** 生成某个刻度的会话：{ orb, pi, turns }（turns 是实际轮数） */
export function buildTick(fx, turns) {
  if (turns <= fx.totalTurns) return { ...prefix(fx, turns), turns: Math.min(turns, fx.totalTurns) };
  const extra = turns - fx.totalTurns;
  if (extra > fx.totalTurns) throw new Error(`最多拼到 ${fx.totalTurns * 2} 轮`);
  const copy = prefix(fx, extra);
  const lastTs = fx.orbRecs.at(-1).timestamp;
  const shift = lastTs - fx.orbRecs[0].timestamp + 60_000;
  // uuid 保持格式（换最后 8 位），pi 的 8 位 id 整体换，其它（toolu_…、call_…）加后缀
  const idMap = (id) =>
    /^[0-9a-f-]{36}$/.test(id) ? id.slice(0, 28) + hash8(id + "#copy") : /^[0-9a-f]{8}$/.test(id) ? hash8(id + "#copy") : `${id}c`;
  const orbCopy = copy.orb.map((l) => JSON.stringify(remap(JSON.parse(l), shift, idMap)));
  // pi：跳过开头的 session / model_change / thinking_level_change，第一条接到原会话最后一条下面
  const piHeaderIds = new Set(fx.piRecs.filter((r) => r.type !== "message" && r.type !== "custom").map((r) => r.id));
  const leaf = fx.piRecs.at(-1).id;
  const piCopy = copy.pi
    .map((l) => JSON.parse(l))
    .filter((r) => !piHeaderIds.has(r.id))
    .map((r) => {
      const out = remap(r, shift, idMap);
      if (piHeaderIds.has(r.parentId)) out.parentId = leaf;
      return JSON.stringify(out);
    });
  return { orb: [...fx.orb, ...orbCopy], pi: [...fx.pi, ...piCopy], turns };
}

/**
 * 铺一个隔离实例：userData 下放会话（主会话 + 1 轮的「bench-home」用来切走再切回）、
 * provider（指向假模型，密钥启动后由驱动经主进程 inspector 用本机 safeStorage 写入）。
 * 会话放 Home（不建工作区），cwd 指向 ws（工具读的文件也在那里）。
 */
export function seedInstance({ fx, userData, ws, mockPort, turns }) {
  const sessions = join(userData, "sessions");
  const piDir = join(userData, "pi-sessions");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(piDir, { recursive: true });
  mkdirSync(ws, { recursive: true });
  writeFileSync(
    join(userData, "providers.json"),
    JSON.stringify({
      version: 1,
      providers: [{
        id: "bench", displayName: "Bench Mock",
        endpoint: { baseUrl: `http://127.0.0.1:${mockPort}/v1`, api: "openai-completions" },
        models: { declared: [{ id: "bench-model", name: "Bench Model", contextWindow: 2_000_000, maxTokens: 32_000 }] },
        auth: { scheme: "api_key", secretRef: { kind: "keychain", account: "bench-key" } },
      }],
    }, null, 2),
  );
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ theme: "black" }, null, 2));

  const srcAttach = fx.manifest.sourceAttachmentsDir;
  const put = (id, title, tick, updatedAt) => {
    const attach = join(sessions, `${id}.attachments`);
    // 绝对路径换成本实例的（JSON 字符串里的反斜杠要转义）
    const fix = (l) => (l.includes(srcAttach) ? l.split(srcAttach).join(JSON.stringify(attach).slice(1, -1)) : l);
    const piFile = join(piDir, `bench-${id}.jsonl`);
    const piLines = tick.pi.map(fix);
    const head = JSON.parse(piLines[0]);
    piLines[0] = JSON.stringify({ ...head, cwd: ws });
    writeFileSync(join(sessions, `${id}.jsonl`), tick.orb.map(fix).join("\n") + "\n");
    writeFileSync(piFile, piLines.join("\n") + "\n");
    cpSync(join(fx.dir, "attachments"), attach, { recursive: true });
    cpSync(join(fx.dir, "snapshots"), join(sessions, `${id}.snapshots`), { recursive: true });
    const meta = {
      ...fx.meta, id, title, titleSource: "manual", cwd: ws, workspaceId: null, piSessionFile: piFile,
      providerId: "bench", modelId: "bench-model", mode: "skip", completion: "open", unread: null,
      pinned: false, archived: false, updatedAt,
    };
    writeFileSync(join(sessions, `${id}.meta.json`), JSON.stringify(meta, null, 2));
  };
  const main = buildTick(fx, turns);
  put(fx.meta.id, `bench-${turns}`, main, Date.now());
  put("00000000-0000-4000-8000-00000000b001", "bench-home", buildTick(fx, 1), Date.now() - 60_000);
  return { sessionId: fx.meta.id, turns: main.turns };
}

/** 素材体量（每个刻度开跑前记一笔：所有数都对齐到这条横轴） */
export function tickSizes(userData, sessionId) {
  const meta = JSON.parse(readFileSync(join(userData, "sessions", `${sessionId}.meta.json`), "utf8"));
  const size = (p) => readFileSync(p).length;
  return {
    sessionBytes: size(join(userData, "sessions", `${sessionId}.jsonl`)),
    piBytes: size(meta.piSessionFile),
    records: splitLines(readFileSync(join(userData, "sessions", `${sessionId}.jsonl`), "utf8")).length,
  };
}

