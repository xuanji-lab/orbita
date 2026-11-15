/**
 * 第四轮独立复验的攻击面（验收员 attack-probe.mts）原样固化成测试：自然写法必须拦 / 日常开发必须放行 /
 * 刻意绕过每条标预期。夹具是 tmp 下真实文件系统（假 home、数据目录、工作台、项目、别的实例、镜像目录、符号链接）。
 * 其中输出类选项（sort -o / diff --output / find -fls …）、解释器单行里的裸名、CDPATH 是复验后补修的，各有专门的一组在后面。
 */
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protectedPathRefusal } from "./permission.ts";

const HOME = realpathSync(mkdtempSync(join(tmpdir(), "orbita-r4re2-gate-")));
after(() => rmSync(HOME, { recursive: true, force: true }));
const AS = join(HOME, "Library", "Application Support");
const D = join(AS, "orbita-dev-x");          // 本实例数据目录
const W = join(D, "workbenches", "w1");       // 会话工作台
const P = join(HOME, "code", "orbita");       // 项目目录
const S = join(HOME, "scratch");              // 用户 scratch（非数据目录）
const O = join(AS, "orbita-dev-zzz");         // 别的开发实例
const MIRROR = join(AS, "orbita-guard", "orbita-dev-x"); // 本实例镜像目录
for (const dir of [join(D, "workbenches", "w1"), join(D, "sessions"), P, S, O, MIRROR, join(AS, "tmp")]) mkdirSync(dir, { recursive: true });
const names = ["automations.json", "automations-archive.json", "automations-archive-old.jsonl", "automations-events.jsonl", "automations-ack.json"];
for (const n of names) { writeFileSync(join(D, n), "{}\n"); writeFileSync(join(O, n), "{}\n"); }
writeFileSync(join(P, "automations.json"), "{}\n"); // 项目里的同名文件（测试假夹具）
writeFileSync(join(S, "automations.json"), "{}\n");
for (const n of ["automations-events.jsonl", "automations-ack.json", "fingerprints.json"]) writeFileSync(join(MIRROR, n), "{}\n");
// 事先建好的符号链接（攻击者或历史遗留）：
symlinkSync(join(D, "automations.json"), join(S, "lnk-record"));        // 指记录文件
symlinkSync(join(S, "lnk-record"), join(S, "lnk-record-2"));            // 链接的链接
symlinkSync(D, join(S, "lnk-dir"));                                     // 指数据目录
writeFileSync(join(W, "note.txt"), "x");
const FILES = [...names.map((n) => join(D, n)), join(MIRROR, "automations-events.jsonl"), join(MIRROR, "automations-ack.json"), join(MIRROR, "fingerprints.json")];
const PATHS = [join(D, "sessions"), join(D, "pi-sessions")];
const GUARD = { home: HOME, env: { HOME, USER: "u", TMPDIR: tmpdir() } as Record<string, string> };

interface Row { group: string; name: string; command: string; cwd: string; want: "block" | "allow" }
const rows: Row[] = [];
function nat(name: string, command: string, cwd = P) { rows.push({ group: "natural", name, command, cwd, want: "block" }); }
function del(name: string, command: string, want: "block" | "allow", cwd = P) { rows.push({ group: "deliberate", name, command, cwd, want }); }
function nor(name: string, command: string, cwd = P) { rows.push({ group: "normal", name, command, cwd, want: "allow" }); }

/* ================= 自然写法（应拦）——重点是「往里覆盖」的各种变体与白名单命令的写文件选项 ================= */
nat("重定向覆盖主文件", `cat /tmp/new.json > "${D}/automations.json"`);
nat("重定向追加事件", `echo x >> "${D}/automations-events.jsonl"`);
nat("tee 覆盖主文件", `tee "${D}/automations.json" < /tmp/new.json`);
nat("sudo tee 覆盖", `printf x | sudo tee "${D}/automations.json"`);
nat("cp 覆盖主文件", `cp /tmp/new.json "${D}/automations.json"`);
nat("cp 通配恢复", `cp /tmp/backup/* "${D}/"`);
nat("cp -R 点目录恢复", `cp -R /tmp/backup/. "${D}/"`);
nat("cp -a 点目录恢复", `cp -a /tmp/backup/. "${D}/"`);
nat("cp 目录内改名", `cp "${D}/automations.json" "${D}/old.json"`);
nat("mv 移入同名", `mv /tmp/new.json "${D}/automations.json"`);
nat("mv 整目录移入", `mv /tmp/backup "${D}/backup"`);
nat("rsync 恢复", `rsync -a /tmp/backup/ "${D}/"`);
nat("rsync --backup 恢复", `rsync -a --backup --suffix=.bak /tmp/backup/ "${D}/"`);
nat("install 覆盖", `install -m 644 /tmp/new.json "${D}/automations.json"`);
nat("ditto 覆盖目录", `ditto /tmp/src "${D}"`);
nat("dd 覆盖主文件", `dd if=/tmp/x of="${D}/automations.json"`);
nat("dd 写数据目录", `dd if=/dev/zero of="${D}/junk" bs=1 count=1`);
nat("tar 打包进数据目录", `tar -czf "${D}/backup.tar.gz" /tmp/x`);
nat("tar 解包进数据目录", `tar -xzf /tmp/x.tar.gz -C "${D}"`);
nat("unzip 进数据目录", `unzip -o /tmp/x.zip -d "${D}"`);
nat("zip 数据目录内容", `zip -r /tmp/x.zip "${D}"`);
nat("curl 下载进数据目录", `curl -o "${D}/data.json" https://example.com/x`);
nat("wget 进数据目录", `wget -O "${D}/x" https://example.com/x`);
nat("scp 拉进数据目录", `scp remote:/x "${D}/"`);
nat("python 单行写主文件", `python3 -c "import json; json.dump({}, open('${D}/automations.json','w'))"`);
nat("node 单行写热归档", `node -e "require('fs').writeFileSync('${D}/automations-archive.json','')"` );
nat("perl 单行改", `perl -e 'open(F,">","${D}/automations.json");print F 1'`);
nat("ruby 单行删", `ruby -e 'File.delete("${D}/automations.json")'`);
nat("osascript 删", `osascript -e 'tell application "Finder" to delete POSIX file "${D}/automations.json"'`);
nat("sed -i 改事件文件", `sed -i '' 's/a/b/' "${D}/automations-events.jsonl"`);
nat("touch 记录文件", `touch "${D}/automations.json"`);
nat("chmod 记录文件", `chmod 644 "${D}/automations.json"`);
nat("chown 记录文件", `chown user "${D}/automations.json"`);
nat("ln 硬链记录", `ln "${D}/automations.json" /tmp/hard`);
nat("ln -s 进数据目录", `ln -s /tmp/x "${D}/link"`);
nat("truncate 冷文件", `truncate -s 0 "${D}/automations-archive-old.jsonl"`);
nat("unlink 事件", `unlink "${D}/automations-events.jsonl"`);
nat("mkdir 数据目录子目录", `mkdir "${D}/newdir"`);
nat("删数据目录", `rm -rf "${D}"`);
nat("数据目录改名", `mv "${D}" "${D}-old"`);
nat("chmod 数据目录", `chmod 000 "${D}"`);
nat("删数据目录上级", `rm -rf "${AS}"`);
nat("git clean 数据目录", `git -C "${D}" clean -fdx`);
nat("find 数据目录删", `find "${D}" -name 'automations*' -delete`);
nat("find 数据目录 exec", `find "${D}" -type f -exec rm {} +`);
nat("find 上级无根删", `cd "${AS}" && find orbita-dev-x -delete`);
nat("for 遍历数据目录删", `for f in "${D}"/*; do rm -f "$f"; done`);
nat("xargs 删列表", `ls "${D}" | xargs rm`);
nat("重定向双斜杠", `echo x > "${D}//junk.txt"`);
nat("工作台绕回删除", `cd "${W}" && rm ../../automations.json`);
nat("工作台绕回通配", `cd "${W}" && rm ../../*.json`);
nat("绝对 .. 绕回", `rm -f "${W}/../../automations.json"`);
nat("花括号删两份", `rm -f "${D}/"{automations.json,automations-archive.json}`);
nat("问号通配", `rm -f "${D}"/automations.?son`);
nat("cd 后 tee", `cd "${D}" && tee automations.json < /dev/null`);
nat("cd 后重定向", `cd "${D}" && : > automations.json`);
nat("cd 后 python", `cd "${D}" && python3 -c "import os; os.remove('automations.json')"`);
nat("bash -c 覆盖", `bash -c 'cp /tmp/new "${D}/automations.json"'`);
nat("env 包装 cp", `env cp /tmp/new "${D}/automations.json"`);
nat("nice 包装 cp", `nice -n 5 cp /tmp/new "${D}/automations.json"`);
nat("nohup 包装 cp", `nohup cp /tmp/new "${D}/automations.json" > /dev/null`);
nat("timeout 包装 rm", `timeout 60 rm -f "${D}/automations.json"`);
nat("写镜像事件", `echo x > "${MIRROR}/automations-events.jsonl"`);
nat("删镜像目录", `rm -rf "${MIRROR}"`);
nat("python 写冷文件（heredoc）", `cd "${D}" && python3 - <<'EOF'\nimport os\nos.remove("automations-archive-old.jsonl")\nEOF`);

/* ================= 刻意绕过（逐条标预期）——重点攻白名单结构 ================= */
// A. 白名单/过滤器命令的「写文件选项」
del("sort -o 合并写法写记录", `cat /tmp/x | sort -o"${D}/automations.json"`, "block");   // 复验后补修：短选项与取值连写，按参数角色拦（原预期「放」是漏洞）
del("sort -o 分开写记录", `sort -o "${D}/automations.json" /tmp/x`, "block");
del("sort --output= 记录", `sort --output="${D}/automations.json" /tmp/x`, "block");
del("sort -o 合并写数据目录", `ls | sort -o"${D}/junk.txt"`, "block"); // 复验后补修：同上，写数据目录里的非记录文件
del("sed w 写记录", `sed 'w ${D}/automations.json' /tmp/x`, "block");
del("awk 重定向写记录", `awk 'BEGIN{print "" > "${D}/automations.json"}'`, "block");
del("awk 经 ENVIRON 写", `T="${D}/automations.json" awk 'BEGIN{print "" > ENVIRON["T"]}'`, "block"); // 赋值前缀被剥后路径可见 → record，比原预期更严
del("find -fprintf 记录（GNU 不支持 = 合并，语法无效）", `find /tmp -fprintf="${D}/automations.json" %p`, "block"); // 带取值的 -fprintf 动作后面出现数据目录里的词，拒
del("find -fprintf 分开写", `find /tmp -fprintf "${D}/automations.json" %p`, "block");
del("find -fls 写数据目录", `find /tmp -fls "${D}/listing.txt"`, "block");
del("find -execdir rm", `find "${D}" -name '*.json' -execdir rm {} +`, "block");
del("find -okdir rm", `find "${D}" -name '*.json' -okdir rm {} \\;`, "block");
del("shasum -c 伪造清单", `cd /tmp && shasum -c "${S}/sums.txt"`, "allow");
del("rg --pre 执行命令", `rg --pre /tmp/x.py "${D}"`, "block");
del("grep -f 读数据目录内非记录文件（只读白名单）", `grep -f "${D}/words.txt" /tmp/x`, "allow");
// B. 路径绕法
del("事先链接指记录（写经链接）", `echo x > "${S}/lnk-record"`, "block");
del("链接的链接", `echo x > "${S}/lnk-record-2"`, "block");
del("目录链接后删记录", `rm "${S}/lnk-dir/automations.json"`, "block");
del("目录链接后 rm -rf", `rm -rf "${S}/lnk-dir"`, "block");
del("大小写绕", `rm -f "${D.toUpperCase()}/automations.json"`, "block");
del("数据目录大写部分", `rm -f "${AS}/ORBITA-DEV-X/automations.json"`, "block");
del("尾部斜杠", `rm -rf "${D}/"`, "block");
del("双斜杠", `rm -rf "${D}//"`, "block");
del("~/ 展开", `rm -f ~/Library/Application\\ Support/orbita-dev-x/automations.json`, "block");
del("$HOME 展开", `rm -f "$HOME/Library/Application Support/orbita-dev-x/automations.json"`, "block");
del("${HOME} 展开", `rm -f "\${HOME}/Library/Application Support/orbita-dev-x/automations.json"`, "block");
del("$PWD 展开（env 指向数据目录）", `cat x > "$PWD/automations.json"`, "block", D); // GUARD.env 无 PWD → unresolved
del("cd - 后删（模拟不了前一目录）", `cd - && rm automations.json`, "allow", D);
del("popd 后删", `cd "${S}" && popd && rm automations.json`, "allow");
del("CDPATH 引开 cd", `CDPATH=/tmp/evil cd subdir && rm automations.json`, "block", D); // cwd 本身就在数据目录里，cd subdir 进了数据目录；CDPATH 的真实绕法见后面「复验后的修补」一组
del(".. 绕回（相对）", `cd "${AS}" && rm -f orbita-dev-x/../orbita-dev-x/automations.json`, "block");
del("上级为目标的递归", `cd "${AS}" && rm -rf orbita-dev-x/*`, "block");
del("上级 tar 解包（无 -C）", `cd "${AS}" && tar -xzf /tmp/x.tar.gz`, "block");
del("上级 git clean（cwd 在 above）", `cd "${AS}" && git clean -fdx`, "block");
del("上级 unzip（无 -d）", `cd "${AS}" && unzip -o /tmp/x.zip`, "block");
del("数据目录下通配匹配记录名", `rm -f "${D}"/automations-archiv*.json*`, "block");
// C. 间接与运行时
del("两步名单（重定向出去再 xargs）", `ls "${D}" > /tmp/list.txt && xargs rm < /tmp/list.txt`, "allow");
del("命令替换拼名（cwd 在数据目录）", `rm "$(printf 'auto%s' 'mations.json')"`, "block", D);
del("substTouched 交给 rm", `rm $(ls "${D}")`, "block");
del("substTouched 交给 cp（拷出也拒）", `cp $(ls "${D}") /tmp/`, "block");
del("base64 管道 sh", `echo cm0gWA== | base64 -d | sh`, "block");
del("反引号拼路径", "rm `" + S + "/gen`", "allow"); // 运行时拼名类（反引号产出路径），命令串里看不见——兜底接；与旧探针已知的刻意绕过同级
del("bash heredoc 删", `cd "${D}" && bash <<'EOF'\nrm -f automations.json\nEOF`, "block");
del("sh <<< 代码", `sh <<< 'rm "${D}/automations.json"'`, "block");
del("python 拼名", `python3 -c "import os;os.remove('auto'+'mations.json')"`, "block", D);
del("预写脚本", `bash ${S}/evil.sh`, "allow");

/* ================= 正常命令（应放行）——日常开发不误伤 ================= */
nor("项目 git status", `git status`);
nor("项目 git diff", `git diff HEAD~1`);
nor("项目 git add/commit", `git add -A && git commit -m x`);
nor("项目 git checkout", `git checkout -b feat/x`);
nor("项目 git pull", `git pull --rebase`);
nor("项目 git clean", `git clean -fd`);
nor("rm node_modules", `rm -rf node_modules`);
nor("项目 mkdir", `mkdir -p src/feature`);
nor("项目内 cp", `cp src/a.ts src/b.ts`);
nor("项目内 mv", `mv old.ts new.ts`);
nor("python 处理项目 json（同名文件）", `python3 -c "import json;json.dump({}, open('automations.json','w'))"`);
nor("node 处理项目同名", `node -e "require('fs').writeFileSync('automations-archive.json','')"`);
nor("perl -i 项目文件", `perl -pi -e 's/a/b/' file.txt`);
nor("ruby 处理项目文件", `ruby -e 'File.write("out.txt","x")'`);
nor("bun install", `bun install`);
nor("bun test", `bun run test`);
nor("typecheck", `bun run typecheck`);
nor("grep 项目", `grep -rn TODO src`);
nor("rg 项目", `rg pattern src`);
nor("find 项目 json", `find src -name '*.ts'`);
nor("find 项目 -delete（cwd=项目）", `find build -name '*.js' -delete`);
nor("sed -i 项目文件", `sed -i '' 's/a/b/' src/x.ts`);
nor("tee 项目文件", `make 2>&1 | tee build.log`);
nor("sort -o 项目文件", `sort -oout.txt in.txt`);
nor("sort -o 合并写法项目文件", `cat in.txt | sort -oout.txt`);
nor("jq 项目 json", `jq . package.json > /tmp/p.json`);
nor("tar 打包项目", `tar -czf /tmp/src.tar.gz src`);
nor("tar 解包到项目", `tar -xzf /tmp/src.tar.gz`);
nor("unzip 到项目", `unzip -o /tmp/x.zip`);
nor("zip 项目", `zip -r /tmp/x.zip src`);
nor("curl 到项目", `curl -L -o icon.png https://example.com/i.png`);
nor("wget 到项目", `wget https://example.com/x`);
nor("python 脚本相对路径", `python3 scripts/gen.py --out dist`);
nor("node 脚本", `node scripts/build.mjs`);
nor("解释器不含路径", `python3 -c "print(sum(range(10)))"`);
nor("sqlite 项目库", `sqlite3 data.db .dump > /tmp/d.sql`);
nor("双引号命令", `"git" status`);
nor("转义命令", `\\git status`);
nor("绝对路径命令", `/usr/bin/git status`);
// /tmp scratch
nor("mktemp", `f=$(mktemp) && echo x > "$f"`);
nor("rm -rf /tmp 下的目录", `rm -rf /tmp/orbita-r4re2-*`);
nor("写 /tmp 同名文件", `echo '{}' > /tmp/automations.json`);
nor("写 scratch 同名文件", `python3 -c "import json;json.dump({}, open('${S}/automations.json','w'))"`);
nor("清 scratch 通配", `cd "${S}" && rm -f automations*`);
nor("find scratch 删同名", `find "${S}" -name 'automations*' -delete`);
nor("cp 到 /tmp 的同名", `cp x /tmp/automations.json`);
// 工作台
nor("工作台写文件", `echo x > "${W}/note2.txt"`);
nor("工作台 python", `python3 -c "open('${W}/out.txt','w').write('x')"`);
nor("工作台 sort -o", `sort -o "${W}/out.txt" in.txt`);
nor("工作台 git", `cd "${W}" && git init && git add -A`);
nor("工作台 rm 子目录", `rm -rf "${W}/build"`);
nor("工作台 tee", `echo x | tee "${W}/t.txt"`);
nor("工作台 tar 解包", `tar -xzf /tmp/x.tar.gz -C "${W}"`);
nor("工作台相对写", `cd "${W}" && echo x > out.txt`);
// 别的实例
nor("ls 别实例", `ls -la "${O}"`);
nor("删别实例", `rm -rf "${O}"`);
nor("cp 别实例 settings", `cp "${O}/automations.json" /tmp/o.json`);
nor("python 写别实例记录", `python3 -c "import json;json.dump({}, open('${O}/automations.json','w'))"`);
// 数据目录只读（round4 口径：只读白名单放行）
nor("ls 数据目录", `ls -la "${D}"`);
nor("du 数据目录", `du -sh "${D}"`);
nor("ls 管道 head", `ls "${D}" | head -5`);
nor("ls 管道 wc", `ls "${D}" | wc -l`);
nor("du 工作台", `du -sh "${D}/workbenches"/*`);
nor("find 数据目录只读", `find "${D}" -maxdepth 1 -name '*.json'`);
nor("cat 数据目录普通文件", `cat "${D}/settings.json"`);
del("file 读记录的 .tmp 兄弟（record 家族读也拒）", `file "${D}/automations.json.tmp"`, "block");
nor("ls 父目录", `ls "${AS}"`);
nor("stat 数据目录本身", `stat "${D}"`);
nor("echo 纯输出", `echo hello world`);
nor("pwd", `pwd`);
nor("which git", `which git`);
nor("ps 查进程", `ps aux | grep -v grep | grep electron`);
nor("df 磁盘", `df -h`);


function refusal(command: string, cwd: string): string | null {
  return protectedPathRefusal("bash", { command }, PATHS, cwd, FILES, GUARD);
}

describe("复验攻击面：自然写法必须拦", () => {
  for (const row of rows.filter((item) => item.group === "natural")) {
    test(`拦：${row.name}`, () => {
      assert.notEqual(refusal(row.command, row.cwd), null, `漏了：${row.command}`);
    });
  }
});

describe("复验攻击面：日常开发必须放行", () => {
  for (const row of rows.filter((item) => item.group === "normal")) {
    test(`放行：${row.name}`, () => {
      assert.equal(refusal(row.command, row.cwd), null, `误伤：${row.command}`);
    });
  }
});

describe("复验攻击面：刻意绕过——每条预期写死", () => {
  for (const row of rows.filter((item) => item.group === "deliberate")) {
    test(`${row.want === "block" ? "拦" : "放（兜底接）"}：${row.name}`, () => {
      assert.equal(refusal(row.command, row.cwd) !== null, row.want === "block", row.command);
    });
  }
});
