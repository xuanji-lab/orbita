// 素材：把一条真实长会话（zip）截成快照，铺进一个隔离的 userData。
//
// zip 里是什么（打包方式见 README）：manifest.json、session.jsonl（Orbita 自己的会话记录）、
// session.meta.json、pi-session.jsonl（pi 的会话本，agent 每轮重读它）、attachments/、snapshots/（后两个可缺）。
//
// 「第 N 轮」的口径：Orbita 会话里的用户消息，去掉被撤回的那些（撤回后重发的不重复计）。
// 6df79261 共 71 条用户消息、10 条被撤回，剩 61 轮，就是「60 轮会话」。
//
// 刻度的写法：
//   N      前 N 轮（N 超过原会话就复制拼接，见下）
//   pre<k> 第 k 次压缩发生的那一轮之前（不含那一轮，所以盘上只有 k−1 次压缩）
//   end    整条会话
//
// 截法：两份 JSONL 都只追加不改写，所以「文件的前缀」就是会话当时在盘上的样子——
// 在某条用户消息前一刀切下即可，不用重建树。pi 那份按同一条用户消息（文字相同、时间最近）对齐。
//
// 超出原会话的刻度（6df79261 的 100 轮）：整条会话 + 再把前 (100−61) 轮复制一遍接在后面。
// 复制的记录换新 id（含 parentId、toolCallId、撤回目标），时间整体后移，pi 那段接到原会话最后一条下面。
//
// 内存：大素材（145 MB）的记录不全量 JSON.parse 常驻，只留切刻度要用的字段（角色、id、用户消息文字），
// 16 GB 的 Windows 笔记本上驱动自己也不该吃掉几个 GB。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const hash8 = (s) => createHash("sha1").update(s).digest("hex").slice(0, 8);
const splitLines = (text) => text.split("\n").filter((l) => l.trim() !== "");
const textOf = (content) =>
  typeof content === "string" ? content : (content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");
const norm = (c) => textOf(c).replace(/\s+/g, "").slice(0, 200);

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
  // 只留切刻度要用的字段
  const orbRecs = orb.map((l) => {
    const r = JSON.parse(l);
    return { id: r.id, role: r.role, targetMessageId: r.targetMessageId, timestamp: r.timestamp, user: r.role === "user" ? norm(r.content) : undefined };
  });
  const piUsers = [];
  pi.forEach((l, i) => {
    if (!l.includes('"role":"user"')) return;
    const r = JSON.parse(l);
    if (r.type === "message" && r.message?.role === "user") piUsers.push({ i, text: norm(r.message.content), ts: Date.parse(r.timestamp) });
  });
  const reverted = new Set(orbRecs.filter((r) => r.role === "revert").map((r) => r.targetMessageId));
  // 存活的用户消息（行号）：被撤回的不算一轮
  const turnStarts = orbRecs.flatMap((r, i) => (r.role === "user" && !reverted.has(r.id) ? [i] : []));
  const compactions = orbRecs.flatMap((r, i) => (r.role === "compacted" ? [i] : []));
  return { dir, manifest, orb, pi, orbRecs, piUsers, meta, turnStarts, compactions, totalTurns: turnStarts.length };
}

/**
 * pi 会话本里和 Orbita 第 k 行用户消息对应的那一行：文字相同（忽略空白——带引用的消息 Orbita 存两块、
 * pi 合成一块）、时间最近（实测两边同一条消息的时间戳到毫秒都一样）
 */
function piIndexOf(fx, orbIndex) {
  const u = fx.orbRecs[orbIndex];
  let best = -1;
  let bestGap = Infinity;
  for (const p of fx.piUsers) {
    if (p.text !== u.user) continue;
    const gap = Math.abs(p.ts - u.timestamp);
    if (gap < bestGap) [best, bestGap] = [p.i, gap];
  }
  if (best >= 0 && bestGap <= 60_000) return best;
  // 从 Proma 导入的会话（fb46e6be）：pi 那份的用户消息前面拼着时间与工作区上下文，文字对不上；
  // 两边时间戳实测差 1 ms，退而按时间最近（2 秒内）对齐
  for (const p of fx.piUsers) {
    const gap = Math.abs(p.ts - u.timestamp);
    if (gap < bestGap) [best, bestGap] = [p.i, gap];
  }
  if (best < 0 || bestGap > 2_000) throw new Error(`pi 会话本里找不到第 ${orbIndex} 行用户消息的对应项`);
  return best;
}

/** 切在 Orbita 第 cut 行（一条用户消息）之前 */
function cutAt(fx, cut) {
  return { orb: fx.orb.slice(0, cut), pi: fx.pi.slice(0, piIndexOf(fx, cut)) };
}

/**
 * 前 n 轮（n ≤ 原会话轮数）。切在第 n 轮之后的**第一条**用户消息前（不管它后来被没被撤回）：
 * 切在下一条存活消息前的话，尾巴会挂着一条「发了又撤回」的半截状态（撤回会把原文放回输入框）
 */
function prefix(fx, n) {
  if (n >= fx.totalTurns) return { orb: fx.orb, pi: fx.pi };
  return cutAt(fx, fx.orbRecs.findIndex((r, i) => i > fx.turnStarts[n - 1] && r.role === "user"));
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

function spliced(fx, turns) {
  const extra = turns - fx.totalTurns;
  if (extra > fx.totalTurns) throw new Error(`最多拼到 ${fx.totalTurns * 2} 轮`);
  if (fx.compactions.length > 0) throw new Error("压缩过的会话不做复制拼接（摘要会和复制段对不上）");
  const copy = prefix(fx, extra);
  const shift = fx.orbRecs.at(-1).timestamp - fx.orbRecs[0].timestamp + 60_000;
  // uuid 保持格式（换最后 8 位），pi 的 8 位 id 整体换，其它（toolu_…、call_…）加后缀
  const idMap = (id) =>
    /^[0-9a-f-]{36}$/.test(id) ? id.slice(0, 28) + hash8(id + "#copy") : /^[0-9a-f]{8}$/.test(id) ? hash8(id + "#copy") : `${id}c`;
  const orbCopy = copy.orb.map((l) => JSON.stringify(remap(JSON.parse(l), shift, idMap)));
  // pi：跳过开头的 session / model_change / thinking_level_change，第一条接到原会话最后一条下面
  const piAll = fx.pi.map((l) => JSON.parse(l));
  const piHeaderIds = new Set(piAll.filter((r) => r.type !== "message" && r.type !== "custom").map((r) => r.id));
  const leaf = piAll.at(-1).id;
  const piCopy = copy.pi
    .map((l) => JSON.parse(l))
    .filter((r) => !piHeaderIds.has(r.id))
    .map((r) => {
      const out = remap(r, shift, idMap);
      if (piHeaderIds.has(r.parentId)) out.parentId = leaf;
      return JSON.stringify(out);
    });
  return { orb: [...fx.orb, ...orbCopy], pi: [...fx.pi, ...piCopy] };
}

/** 刻度 → { label, turns, compactions, orb, pi } */
export function buildTick(fx, spec) {
  const s = String(spec);
  let cut;
  if (s === "end") cut = { orb: fx.orb, pi: fx.pi };
  else if (/^pre\d+$/.test(s)) {
    const k = Number(s.slice(3));
    const at = fx.compactions[k - 1];
    if (at === undefined) throw new Error(`${fx.manifest.fixture} 只有 ${fx.compactions.length} 次压缩，没有 ${s}`);
    // 第 k 次压缩发生在哪一轮里：它之前最近的一条用户消息；切在这条之前，整轮都不要
    const user = fx.orbRecs.findLastIndex((r, i) => i < at && r.role === "user");
    cut = cutAt(fx, user);
  } else if (/^\d+$/.test(s)) cut = Number(s) <= fx.totalTurns ? prefix(fx, Number(s)) : spliced(fx, Number(s));
  else throw new Error(`看不懂的刻度：${s}（写轮数、pre<k> 或 end）`);
  // 复制拼接的那种没有压缩、轮数就是要的数；其余都是原会话的前缀，用已解析的轻量记录数
  const n = cut.orb.length;
  const inside = n <= fx.orb.length;
  // 撤回只算快照里已经发生的
  const head = fx.orbRecs.slice(0, n);
  const rev = new Set(head.filter((r) => r.role === "revert").map((r) => r.targetMessageId));
  return {
    label: `${fx.manifest.fixture}·${s}`,
    turns: inside ? head.filter((r) => r.role === "user" && !rev.has(r.id)).length : Number(s),
    compactions: inside ? fx.compactions.filter((i) => i < n).length : 0,
    ...cut,
  };
}

/** 切走再切回用的小会话：一问一答，所有来源一样，切会话的数只反映目标会话 */
function homeSession(ws) {
  const t = Date.parse("2026-11-01T00:00:00Z");
  const orb = [
    { id: "b0b0b0b0-0000-4000-8000-000000000001", role: "user", content: [{ type: "text", text: "bench home" }], timestamp: t },
    { id: "b0b0b0b0-0000-4000-8000-000000000002", role: "assistant", content: [{ type: "text", text: "ok" }], model: { provider: "bench", id: "bench-model" }, timestamp: t + 1000, status: "complete", stopReason: "stop" },
  ];
  const pi = [
    { type: "session", version: 3, id: "b0b0b0b0-0000-7000-8000-000000000000", timestamp: new Date(t).toISOString(), cwd: ws },
    { type: "message", id: "b0b0b0b1", parentId: null, timestamp: new Date(t).toISOString(), message: { role: "user", content: [{ type: "text", text: "bench home" }], timestamp: t } },
  ];
  return { orb: orb.map((r) => JSON.stringify(r)), pi: pi.map((r) => JSON.stringify(r)) };
}

/**
 * 铺一个隔离实例：userData 下放会话（主会话 + 一问一答的「bench-home」用来切走再切回）、
 * provider（指向假模型，密钥启动后由驱动经主进程 inspector 用本机 safeStorage 写入）。
 * 会话放 Home（不建工作区），cwd 指向 ws（工具读的文件也在那里）。
 */
export function seedInstance({ fx, userData, ws, mockPort, spec }) {
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
        // 窗口 200 万：pi 在「上一条回复报的上下文 > 窗口 − 保留量（20%）= 160 万」时自动压缩。
        // 素材里真实回复报的用量最多几十万，不会误触；压缩场景由假模型报 ctx=1700000 主动触发
        models: { declared: [{ id: "bench-model", name: "Bench Model", contextWindow: 2_000_000, maxTokens: 32_000 }] },
        auth: { scheme: "api_key", secretRef: { kind: "keychain", account: "bench-key" } },
      }],
    }, null, 2),
  );
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ theme: "black" }, null, 2));

  const srcAttach = fx.manifest.sourceAttachmentsDir;
  const put = (id, title, data, updatedAt, files) => {
    const attach = join(sessions, `${id}.attachments`);
    // 绝对路径换成本实例的（JSON 字符串里的反斜杠要转义）
    const fix = (l) => (srcAttach && l.includes(srcAttach) ? l.split(srcAttach).join(JSON.stringify(attach).slice(1, -1)) : l);
    const piFile = join(piDir, `bench-${id}.jsonl`);
    const piLines = data.pi.map(fix);
    const head = JSON.parse(piLines[0]);
    piLines[0] = JSON.stringify({ ...head, cwd: ws });
    writeFileSync(join(sessions, `${id}.jsonl`), data.orb.map(fix).join("\n") + "\n");
    writeFileSync(piFile, piLines.join("\n") + "\n");
    for (const [from, to] of files) if (existsSync(from)) cpSync(from, to, { recursive: true });
    const meta = {
      ...fx.meta, id, title, titleSource: "manual", cwd: ws, workspaceId: null, piSessionFile: piFile,
      providerId: "bench", modelId: "bench-model", mode: "skip", completion: "open", unread: null, closedAt: null,
      pinned: false, archived: false, starred: false, updatedAt, thinkingLevel: "high", intentEnabled: false,
    };
    delete meta.importedFrom;
    writeFileSync(join(sessions, `${id}.meta.json`), JSON.stringify(meta, null, 2));
  };
  const tick = buildTick(fx, spec);
  const id = fx.meta.id;
  put(id, `bench-${fx.manifest.fixture}-${spec}`, tick, Date.now(), [
    [join(fx.dir, "attachments"), join(sessions, `${id}.attachments`)],
    [join(fx.dir, "snapshots"), join(sessions, `${id}.snapshots`)],
  ]);
  const homeId = "00000000-0000-4000-8000-00000000b001";
  put(homeId, "bench-home", homeSession(ws), Date.now() - 60_000, []);
  return { sessionId: id, title: `bench-${fx.manifest.fixture}-${spec}`, label: tick.label, turns: tick.turns, compactions: tick.compactions };
}

/** 素材体量（每个刻度开跑前记一笔：所有数都对齐到这条横轴） */
export function tickSizes(userData, sessionId) {
  const meta = JSON.parse(readFileSync(join(userData, "sessions", `${sessionId}.meta.json`), "utf8"));
  const orb = readFileSync(join(userData, "sessions", `${sessionId}.jsonl`), "utf8");
  return {
    sessionBytes: Buffer.byteLength(orb),
    piBytes: readFileSync(meta.piSessionFile).length,
    records: splitLines(orb).length,
  };
}
