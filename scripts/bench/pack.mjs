// 把本机 Orbita 的一条真实会话打成测量素材（目录），给 bench.mjs --fixture 用。
//
// 用法（在仓库根目录；读的是你自己的数据目录，只读不改）：
//   node scripts/bench/pack.mjs --list                    列出最重的 15 条会话（体量、轮数、压缩次数、子会话数）
//   node scripts/bench/pack.mjs --session <id 或前 8 位>  打成素材目录（默认 <仓库>/bench-fixtures/<前 8 位>/）
//   可选：--user-data <Orbita 数据目录>（默认 Windows %APPDATA%\orbita，macOS ~/Library/Application Support/orbita）
//         --out <目录>
//
// 素材目录与 zip 素材包同构：manifest.json、session.jsonl、session.meta.json、pi-session.jsonl、
// attachments/、snapshots/。素材是原样副本、未脱敏，只该留在本机。
//
// 为什么要人来跑：Orbita 里的 agent 被禁止读 sessions/ 与 pi-sessions/（会话文件不可变规则），
// 所以这一步由用户自己在终端里执行。
import { createHash } from "node:crypto";
import { createReadStream, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const defaultUserData =
  process.platform === "win32"
    ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "orbita")
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "orbita")
      : join(homedir(), ".config", "orbita");
const userData = resolve(opt("user-data", defaultUserData));
const sessionsDir = join(userData, "sessions");
if (!existsSync(sessionsDir)) {
  console.error(`找不到 ${sessionsDir}；用 --user-data 指向 Orbita 的数据目录`);
  process.exit(2);
}

const mb = (n) => Math.round((n / 1024 / 1024) * 10) / 10;
const sizeOf = (p) => (p && existsSync(p) ? statSync(p).size : 0);
const readMeta = (id) => JSON.parse(readFileSync(join(sessionsDir, `${id}.meta.json`), "utf8"));

/** 流式数一份会话记录里的用户消息（去掉被撤回的）与压缩界碑，不整份读进内存 */
async function countTurns(file) {
  let users = 0;
  let compactions = 0;
  let reverts = 0;
  let rest = "";
  for await (const chunk of createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 })) {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      if (line.includes('"role":"user"')) users++;
      else if (line.includes('"role":"compacted"')) compactions++;
      else if (line.includes('"role":"revert"')) reverts++;
    }
  }
  return { turns: users - reverts, compactions };
}

const metas = readdirSync(sessionsDir)
  .filter((f) => f.endsWith(".meta.json"))
  .map((f) => f.slice(0, -".meta.json".length))
  .flatMap((id) => {
    try {
      return [readMeta(id)];
    } catch {
      return [];
    }
  });
const childrenOf = (id) => metas.filter((m) => m.parentId === id).length;

if (argv.includes("--list")) {
  const rows = metas
    .map((m) => ({ m, bytes: sizeOf(join(sessionsDir, `${m.id}.jsonl`)), piBytes: sizeOf(m.piSessionFile) }))
    .sort((a, b) => b.bytes + b.piBytes - (a.bytes + a.piBytes))
    .slice(0, 15);
  console.log(`数据目录：${userData}；共 ${metas.length} 条会话（含子会话 ${metas.filter((m) => m.parentId).length} 条）\n`);
  console.log("id 前 8 位 | 会话 MB | pi MB | 轮数 | 压缩 | 子会话 | 是子会话 | 标题");
  for (const { m, bytes, piBytes } of rows) {
    const { turns, compactions } = await countTurns(join(sessionsDir, `${m.id}.jsonl`));
    console.log(`${m.id.slice(0, 8)} | ${mb(bytes)} | ${mb(piBytes)} | ${turns} | ${compactions} | ${childrenOf(m.id)} | ${m.parentId ? "是" : ""} | ${m.title}`);
  }
  process.exit(0);
}

const want = opt("session", "");
const hits = metas.filter((m) => m.id === want || m.id.startsWith(want));
if (want === "" || hits.length !== 1) {
  console.error(want === "" ? "要 --list 或 --session <id>" : `「${want}」对上 ${hits.length} 条会话，给完整一点的 id`);
  process.exit(2);
}
const meta = hits[0];
const name = meta.id.slice(0, 8);
const out = resolve(opt("out", join(process.cwd(), "bench-fixtures", name)));
if (existsSync(join(out, "manifest.json"))) {
  console.error(`${out} 已经有素材了；换 --out 或先删掉它`);
  process.exit(2);
}
if (!meta.piSessionFile || !existsSync(meta.piSessionFile)) {
  console.error(`这条会话没有 pi 会话本（meta.piSessionFile = ${meta.piSessionFile}），测不了`);
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const copies = [
  [join(sessionsDir, `${meta.id}.jsonl`), "session.jsonl"],
  [join(sessionsDir, `${meta.id}.meta.json`), "session.meta.json"],
  [meta.piSessionFile, "pi-session.jsonl"],
  [join(sessionsDir, `${meta.id}.attachments`), "attachments"],
  [join(sessionsDir, `${meta.id}.snapshots`), "snapshots"],
];
for (const [from, to] of copies) if (existsSync(from)) cpSync(from, join(out, to), { recursive: true });

const { turns, compactions } = await countTurns(join(out, "session.jsonl"));
// 刻度：压缩过的会话量「第 2 次压缩前 / 最后一次压缩前 / 整条」，没压缩过的量 10 / 30 / 60 / 整条
const defaultTicks =
  compactions >= 2
    ? [...new Set(["pre2", `pre${compactions}`, "end"])]
    : compactions === 1
      ? ["pre1", "end"]
      : [...[10, 30, 60].filter((n) => n < turns).map(String), "end"];
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const attachDir = join(sessionsDir, `${meta.id}.attachments`);
writeFileSync(
  join(out, "manifest.json"),
  JSON.stringify(
    {
      fixture: name,
      description: `本机会话「${meta.title}」原样副本（未脱敏，只留在本机），${turns} 轮、${compactions} 次压缩、${childrenOf(meta.id)} 条子会话`,
      sourceSessionId: meta.id,
      // 会话记录里附件的绝对路径按 JSON 文本里的写法存（Windows 的反斜杠在 JSON 里是成对的），铺实例时整段替换
      sourceAttachmentsDir: JSON.stringify(attachDir).slice(1, -1),
      createdAt: new Date().toISOString().slice(0, 10),
      defaultTicks,
      sha256: { "session.jsonl": sha(join(out, "session.jsonl")), "pi-session.jsonl": sha(join(out, "pi-session.jsonl")) },
    },
    null,
    2,
  ),
);
console.log(
  `素材 → ${out}\n「${meta.title}」：${turns} 轮、${compactions} 次压缩、会话 ${mb(sizeOf(join(out, "session.jsonl")))} MB、` +
    `pi ${mb(sizeOf(join(out, "pi-session.jsonl")))} MB、子会话 ${childrenOf(meta.id)} 条；默认刻度 ${defaultTicks.join(",")}`,
);
