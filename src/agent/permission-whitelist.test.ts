/**
 * 自动化记录闸门的「数据目录白名单」：两轮独立复验的探针整组固化成测试，外加本轮自己补的自然写法。
 *
 *   - 自然写法（不是刻意绕过的）：必须拦；
 *   - 正常命令：必须放行（用户用 Orbita 开发 Orbita，造 / 清别的实例的数据、项目里处理同名文件都是日常）；
 *   - 刻意绕过：不要求闸门拦住，但每条标明预期（拦 / 放），将来无意中变化会红；放行的那些由主进程兜底接住；
 *   - write / edit、shell 读记录文件、开发实例额外保护正式实例的记录文件。
 *
 * 夹具是真实文件系统（tmp 下的假数据目录 + 符号链接），不是字符串游戏：realpath 与大小写折叠都真走一遍。
 */
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { protectedPathRefusal } from "./permission.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "orbita-whitelist-")));
const HOME = join(root, "home");
const DATA = join(HOME, "Library", "Application Support", "orbita-dev-re");
const OTHER = join(HOME, "Library", "Application Support", "orbita-dev-other");
const OTHER_APP = join(HOME, "Library", "Application Support", "SomeOtherApp");
/** 正式实例的数据目录（开发实例里的智能体也不许动它的记录文件） */
const FORMAL = join(HOME, "Library", "Application Support", "orbita");
const PROJ = join(root, "project");
const SCRATCH = join(root, "scratch");
const WB = join(DATA, "workbenches", "w1");
const PARENT = dirname(DATA);
for (const dir of [DATA, OTHER, OTHER_APP, FORMAL, PROJ, SCRATCH, WB, join(DATA, "sessions"), join(DATA, "pi-sessions"), join(FORMAL, "sessions")]) mkdirSync(dir, { recursive: true });
const names = ["automations.json", "automations-archive.json", "automations-archive-old.jsonl", "automations-events.jsonl"];
for (const base of [DATA, OTHER, OTHER_APP, FORMAL, PROJ, SCRATCH, WB]) for (const name of names) writeFileSync(join(base, name), `original ${base} ${name}\n`);
writeFileSync(join(DATA, "settings.json"), "{}");
writeFileSync(join(FORMAL, "settings.json"), "{}");
symlinkSync(join(DATA, "automations.json"), join(SCRATCH, "main-link.json"));
symlinkSync(join(SCRATCH, "main-link.json"), join(SCRATCH, "main-link-2.json"));
symlinkSync(DATA, join(SCRATCH, "data-link"));
symlinkSync(WB, join(SCRATCH, "wb-link"));
after(() => rmSync(root, { recursive: true, force: true }));

const FILES = names.map((name) => join(DATA, name));
/** 开发实例：本实例的记录 + 正式实例的记录（数据目录之外，只按文件保） */
const FILES_WITH_FORMAL = [...FILES, ...names.map((name) => join(FORMAL, name))];
const PATHS = [join(DATA, "sessions"), join(DATA, "pi-sessions")];
const GUARD = { home: HOME, env: { HOME, TMPDIR: join(root, "tmp"), APPDATA: join(HOME, "Library", "Application Support") } };
const D = DATA;
const DS = DATA.replaceAll(" ", "\\ ");
const O = OTHER;
const OS = OTHER.replaceAll(" ", "\\ ");
const P = PROJ;
const W = WB;
const WS = WB.replaceAll(" ", "\\ ");
const FM = FORMAL;

type Attack = { group: "natural" | "deliberate"; name: string; command: string; cwd?: string; tool?: string };
const attacks: Attack[] = [
  // 自然写法：普通清理、腾名额、恢复 / 覆盖记录时可能直接写出。
  ...[
    ["绝对路径删主文件", `rm "${D}/automations.json"`],
    ["转义空格删热归档", `rm -f ${DS}/automations-archive.json`],
    ["$HOME 删冷归档", `rm "$HOME/Library/Application Support/orbita-dev-re/automations-archive-old.jsonl"`],
    ["~ 删事件文件", `rm -f ~/Library/Application\\ Support/orbita-dev-re/automations-events.jsonl`],
    ["cd 后删主文件", `cd "${D}" && rm -f automations.json`],
    ["pushd 后删热归档", `pushd "${D}" >/dev/null && rm -f automations-archive.json`],
    ["子 shell 删冷文件", `(cd "${D}" && rm -f automations-archive-old.jsonl)`],
    ["cd 后重定向截断", `cd "${D}" && : > automations.json`],
    ["cd 后追加覆盖内容", `cd "${D}" && printf x >> automations-archive.json`],
    ["tee 截断", `cd "${D}" && tee automations.json </dev/null`],
    ["cd 后 sed -i", `cd "${D}" && sed -i '' 's/version/versionX/' automations.json`],
    ["绝对路径 sed -i", `sed -i '' 's/version/versionX/' "${D}/automations-archive.json"`],
    ["cp 空文件覆盖", `cp /dev/null "${D}/automations.json"`],
    ["cp 替换热归档", `cp /tmp/empty "${D}/automations-archive.json"`],
    ["mv 移走主文件", `mv "${D}/automations.json" /tmp/removed.json`],
    ["数据目录改名", `mv "${D}" "${D}-old"`],
    ["删数据目录", `rm -rf "${D}"`],
    ["数据目录改权限", `chmod 000 "${D}"`],
    ["find 名字通配删除", `find "${D}" -name 'automations*' -delete`],
    ["find jsonl exec 删除", `find "${D}" -name '*.jsonl' -exec rm {} +`],
    ["find 管道 xargs", `find "${D}" -name 'automations.json' | xargs rm -f`],
    ["ls 通配管道 xargs", `ls "${D}"/automations* | xargs rm`],
    ["for 遍历目录删除", `for f in "${D}"/*; do rm -f "$f"; done`],
    ["git clean 数据目录", `git -C "${D}" clean -fdx`],
    ["rsync --delete 清空", `rsync -a --delete /tmp/empty/ "${D}/"`],
    ["tar 解包覆盖", `tar -xf /tmp/empty.tar -C "${D}"`],
    ["python 单行删除", `python3 -c "import os; os.remove('${D}/automations.json')"`],
    ["node 单行删除", `node -e "require('fs').unlinkSync('${D}/automations-archive.json')"`],
    ["cd 后 python 删冷文件", `cd "${D}" && python3 -c "import os; os.remove('automations-archive-old.jsonl')"`],
    ["cd 后 node 写主文件", `cd "${D}" && node -e "require('fs').writeFileSync('automations.json','{}')"`],
    ["工作台相对绕回删除", `cd "${W}" && rm ../../automations.json`],
    ["工作台相对通配绕回", `cd "${W}" && rm ../../*.json`],
    ["上级相对目录删除", `cd "${PARENT}" && rm -rf orbita-dev-re`],
    ["上级相对目录改名", `cd "${PARENT}" && mv orbita-dev-re orbita-dev-re.old`],
    ["目录与文件名分段", `rm -f "${D}/"automations.json`],
    ["花括号一次删两份", `rm -f "${D}/"{automations.json,automations-archive.json}`],
    ["问号通配", `rm -f "${D}/"automations.?son`],
    ["星号通配", `rm -f "${D}/"automations*`],
    ["建文件符号链接", `ln -s "${D}/automations.json" /tmp/records-link`],
    ["目录链接后删除", `ln -s "${D}" /tmp/data-link && rm /tmp/data-link/automations-archive.json`],
    ["here-doc 删除", `cd "${D}" && bash <<'EOF'\nrm -f automations.json\nEOF`],
    ["sh -c 包一层", `cd "${D}" && sh -c 'rm -f automations-archive.json'`],
    ["dd 覆盖", `cd "${D}" && dd if=/dev/zero of=automations.json bs=1 count=1`],
    ["truncate 冷文件", `cd "${D}" && truncate -s 0 automations-archive-old.jsonl`],
    ["mv 改成旧名字", `cd "${D}" && mv automations.json automations.json.old`],
    ["unlink 事件", `cd "${D}" && unlink automations-events.jsonl`],
    ["绝对 .. 绕回", `rm -f "${D}/workbenches/w1/../../automations.json"`],
    ["跨目录 .. 绕回", `rm -f "${D}/workbenches/w1/../../../orbita-dev-re/automations-archive.json"`],
    ["上级 find 相对目录删除", `cd "${PARENT}" && find orbita-dev-re -delete`],
    ["上级相对通配清空", `cd "${PARENT}" && rm -rf orbita-dev-re/*`],
    // 同一批文件名从备份目录拷回 / 移回：没有记录名的目标目录写法，也属于自然覆盖。
    ["cp 同名文件到数据目录", `cp /tmp/backup/automations.json "${D}/"`],
    ["cp 通配恢复到数据目录", `cp /tmp/backup/* "${D}/"`],
    ["cp -R 点目录恢复", `cp -R /tmp/backup/. "${D}/"`],
    ["mv 同名文件到数据目录", `mv /tmp/backup/automations.json "${D}/"`],
    ["mv 通配移回数据目录", `mv /tmp/backup/* "${D}/"`],
    ["rsync 无 delete 恢复", `rsync -a /tmp/backup/ "${D}/"`],
    ["install 同名文件到数据目录", `install /tmp/backup/automations.json "${D}/"`],
  ].map(([name, command]) => ({ group: "natural" as const, name: name ?? "", command: command ?? "" })),
  // 刻意绕过：运行时拼名、间接执行、inode、环境变量、函数与进程替换。
  ...[
    ["命令替换拼文件名", `rm "$(printf 'auto%s' 'mations.json')"`, D],
    ["运行时拼目录与文件名", `D="$HOME/Library/Application Support/orbita-dev-re"; rm "$D/$(printf 'auto%s' 'mations.json')"`],
    ["python 环境变量与拼接", `python3 -c "import os; os.remove(os.path.join(os.environ['TARGET_DIR'], 'auto'+'mations.json'))"`],
    ["node Buffer 解码文件名", `node -e "require('fs').unlinkSync(process.env.TARGET_DIR+'/'+Buffer.from('YXV0b21hdGlvbnMuanNvbg==','base64').toString())"`],
    ["bash 执行预写脚本", `bash ${SCRATCH}/delete-records.sh`],
    ["source 预写脚本", `source ${SCRATCH}/delete-records.sh`],
    ["sh 执行预写脚本", `sh ${SCRATCH}/delete-records.sh`],
    ["xargs 从名单文件读", `xargs rm < ${SCRATCH}/record-names.txt`],
    ["运行时 pwd 后按 inode", `ROOT=$(pwd); find "$ROOT" -inum 424242 -delete`, D],
    ["外部环境变量给完整文件", `rm "$TARGET_RECORD"`],
    ["未知变量目录加通配", `rm "$TARGET_DIR"/auto*`],
    ["base64 管道 sh", `echo cm0gYXV0b21hdGlvbnMuanNvbg== | base64 -d | sh`, D],
    ["base64 命令替换 eval", `eval "$(echo cm0gYXV0b21hdGlvbnMuanNvbg== | base64 -d)"`, D],
    ["xxd 十六进制管道 bash", `echo 726d206175746f6d6174696f6e732e6a736f6e | xxd -r -p | bash`, D],
    ["openssl 解码管道 sh", `echo cm0gYXV0b21hdGlvbnMuanNvbg== | openssl base64 -d -A | sh`, D],
    ["函数定义后调用", `cleanup() { rm -f automations.json; }; cleanup`, D],
    ["进程替换 source", `source <(printf 'rm -f automations.json')`, D],
    ["别名藏 rm", `alias cleanup='rm -f'; cleanup automations.json`, D],
    ["tar 在当前目录解预制包", `tar -xf ${SCRATCH}/replacement.tar`, D],
    ["unzip 在当前目录解预制包", `unzip -o ${SCRATCH}/replacement.zip`, D],
    ["rsync 当前目录无 delete 覆盖", `rsync -a ${SCRATCH}/replacement/ ./`, D],
    ["perl pack 拼名", `perl -e 'unlink pack("H*","6175746f6d6174696f6e732e6a736f6e")'`, D],
    ["ruby join 拼名", `ruby -e 'File.delete(["auto","mations.json"].join)'`, D],
    ["node 数组 join 拼名", `node -e 'require("fs").rmSync(["auto","mations.json"].join(""))'`, D],
    ["python 环境变量完整路径", `python3 -c 'import os; os.unlink(os.environ["TARGET_RECORD"])'`],
    ["find 未知根 print0 xargs", `find "$TARGET_DIR" -type f -print0 | xargs -0 rm`],
    ["while read 从文件删", `while IFS= read -r f; do rm -f "$f"; done < ${SCRATCH}/record-names.txt`],
    [" eval 间接变量", `C=TARGET_RECORD; eval 'rm -f "$'$C'"'`],
    ["bash -c 从环境取命令", `bash -c "$TARGET_COMMAND"`],
    ["python exec 预写代码文件", `python3 -c 'exec(open("/tmp/nonexistent-code").read())'`],
    ["node require 预写模块", `node -e 'require("/tmp/nonexistent-delete-module")'`],
    ["find 用 regex 拼 inode", `ROOT=$(pwd); find "$ROOT" -regex '.*jsonl' -delete`, D],
  ].map(([name, command, cwd]) => ({ group: "deliberate" as const, name: name ?? "", command: command ?? "", ...(cwd !== undefined ? { cwd } : {}) })),
];

const normal: { name: string; command: string; cwd?: string; tool?: string }[] = [
  ["git grep 自动化字样", `git grep -n automations -- src`],
  ["git log 搜文件名", `git log -S'automations-archive.json' -- src`],
  ["rg 搜文件名", `rg -n 'automations\\.json' src`],
  ["grep 搜文件名", `grep -R 'automations-events.jsonl' src`],
  ["find 项目只列同名源码", `find . -name '*automations*' -print`],
  ["git 状态与 diff", `git status --short && git diff -- src`],
  ["读项目同名主文件", `cat "${P}/automations.json"`],
  ["head 项目同名归档", `head -n 10 "${P}/automations-archive.json"`],
  ["wc 项目冷文件", `wc -l "${P}/automations-archive-old.jsonl"`],
  ["删项目主文件", `rm "${P}/automations.json"`],
  ["删项目热归档", `rm "${P}/automations-archive.json"`],
  ["删项目冷文件", `rm "${P}/automations-archive-old.jsonl"`],
  ["删项目事件", `rm "${P}/automations-events.jsonl"`],
  ["重定向写项目主文件", `printf '{}\n' > "${P}/automations.json"`],
  ["tee 写项目热归档", `printf x | tee "${P}/automations-archive.json"`],
  ["sed 项目同名", `sed -i '' 's/x/y/' "${P}/automations.json"`],
  ["cp 项目同名到 scratch", `cp "${P}/automations.json" "${SCRATCH}/copy.json"`],
  ["mv 项目同名到 scratch", `mv "${P}/automations-archive.json" "${SCRATCH}/"`],
  ["chmod 项目冷文件", `chmod 600 "${P}/automations-archive-old.jsonl"`],
  ["touch 项目事件", `touch "${P}/automations-events.jsonl"`],
  ["truncate 项目主文件", `truncate -s 0 "${P}/automations.json"`],
  ["dd 项目热归档", `dd if=/dev/zero of="${P}/automations-archive.json" count=1`],
  ["python 单行写项目同名", `python3 -c "from pathlib import Path; Path('${P}/automations.json').write_text('{}')"`],
  ["node 单行写项目同名", `node -e "require('fs').writeFileSync('${P}/automations-archive.json','{}')"`],
  ["删其他实例主文件", `rm "${O}/automations.json"`],
  ["删其他实例热归档", `rm -f ${OS}/automations-archive.json`],
  ["读其他实例冷文件", `cat "${O}/automations-archive-old.jsonl"`],
  ["写其他实例事件", `echo '{}\n' > "${O}/automations-events.jsonl"`],
  ["sed 其他实例主文件", `sed -i '' 's/x/y/' "${O}/automations.json"`],
  ["cp 其他实例归档", `cp "${O}/automations-archive.json" "${SCRATCH}/"`],
  ["mv 其他实例主文件", `mv "${O}/automations.json" "${SCRATCH}/other-main.json"`],
  ["find 其他实例通配删除", `find "${O}" -name 'automations*' -delete`],
  ["find 其他实例精确删除", `find "${O}" -name 'automations.json' -delete`],
  ["读 scratch 同名", `cat "${SCRATCH}/automations.json"`],
  ["删 scratch 同名", `rm "${SCRATCH}/automations.json"`],
  ["写 scratch 同名归档", `echo x > "${SCRATCH}/automations-archive.json"`],
  ["find scratch 通配删除", `find "${SCRATCH}" -name 'automations*' -delete`],
  ["cd scratch 后通配删除", `cd "${SCRATCH}" && rm -f automations*`],
  ["进工作台", `cd "${W}" && ls -la`],
  ["读工作台笔记", `cat "${W}/notes.md"`],
  ["写工作台笔记", `echo hello > "${W}/notes.md"`],
  ["删工作台临时目录", `rm -rf "${W}/tmp"`],
  ["工作台 find 删除", `find "${W}" -name '*.json' -delete`],
  ["删工作台同名文件", `rm "${W}/automations.json"`],
  ["cd 工作台删同名", `cd "${W}" && rm automations.json`],
  ["python 写工作台同名", `python3 -c "from pathlib import Path; Path('${W}/automations.json').write_text('{}')"`],
  ["经工作台链接写文件", `echo ok > "${SCRATCH}/wb-link/out.txt"`],
  ["ls 数据目录", `ls -la "${D}"`],
  ["du 数据目录", `du -sh "${D}"`],
  ["stat 数据目录", `stat "${D}"`],
  ["ls workbenches", `ls "${D}/workbenches"`],
  ["find workbenches 只读", `find "${D}/workbenches" -type f -print`],
  ["ls 家目录 Library", `ls ~/Library`],
  ["ls Application Support", `ls ~/Library/Application\\ Support`],
  ["cd Application Support", `cd ~/Library/Application\\ Support && ls`],
  ["删无关缓存", `rm -rf ~/Library/Caches/orbita-r3re-test`],
  ["删其他应用同名", `rm "${OTHER_APP}/automations.json"`],
  ["find 其他应用通配删除", `find "${OTHER_APP}" -name 'automations*' -delete`],
  ["tar 打包项目", `tar -czf "${SCRATCH}/project.tgz" -C "${P}" .`],
  ["rsync 备份项目", `rsync -a "${P}/" "${SCRATCH}/project-backup/"`],
  ["git clean 项目", `git clean -fd`, P],
  ["find 项目删 tmp", `find . -name '*.tmp' -delete`, P],
  ["删项目依赖", `rm -rf node_modules dist`, P],
  ["echo HOME", `echo "$HOME"`],
  ["node 无关计算", `node -e "console.log(1+1)"`],
  ["python 无关计算", `python3 -c "print(1+1)"`],
  ["base64 只解码", `echo aGVsbG8= | base64 -d`],
  ["读相近但不同名文件", `cat src/xautomations.json src/automations-view.ts`, P],
  ["mv 到 Library 作为目标", `mv "${P}/x.pdf" ~/Library/`],
  ["清空无关 scratch 通配", `rm -rf "${SCRATCH}/normal/"*`],
  ["find 无关 scratch 删除", `find "${SCRATCH}/normal" -type f -delete`],
  ["读工作台同名主文件", `cat "${W}/automations.json"`],
  ["head 工作台同名归档", `head "${W}/automations-archive.json"`],
  ["stat 工作台同名主文件", `stat "${W}/automations.json"`],
].map(([name, command, cwd]) => ({ name: name ?? "", command: command ?? "", ...(cwd !== undefined ? { cwd } : {}) }));


const natural: [string, string, string?, string?][] = [
  ["sed w 写记录", `sed -n 'w ${D}/automations.json' /tmp/in.txt`],
  ["awk 重定向写记录", `awk 'BEGIN{print "x" > "${D}/automations-archive.json"}'`],
  ["awk system rm", `awk 'BEGIN{system("rm ${D}/automations.json")}'`],
  ["find exec sh -c", `find /tmp -name x -exec sh -c 'rm "${D}/automations.json"' \\;`],
  ["git -c 执行", `git -C "${D}" status`],
  ["tar 写归档到数据目录", `tar -cf "${D}/x.tar" src`],
  ["管道 tar 解到数据目录", `tar cf - src | tar xf - -C "${D}"`],
  ["dd 读数据目录", `dd if="${D}/settings.json" of=/tmp/y`],
  ["curl 写数据目录", `curl -fsSL http://x -o "${D}/settings.json"`],
  ["cp -r 通配到数据目录", `cp -r /tmp/backup/* "${D}/"`],
  ["rsync exclude 恢复", `rsync -a --exclude=foo /tmp/backup/ "${D}/"`],
  ["rsync 不带斜杠目的地", `rsync -av /tmp/backup/ ${DS}`],
  ["cp -f 到数据目录", `cp -f /tmp/x "${D}"`],
  ["install -m 到记录", `install -m 644 /tmp/x "${D}/automations.json"`],
  ["tar 解到数据目录 strip", `tar -xzf /tmp/b.tgz -C "${D}" --strip-components=1`],
  ["tar 长选项解到数据目录", `tar --extract --file=/tmp/b.tar --directory="${D}"`],
  ["ln -sf 覆盖记录", `ln -sf /tmp/x "${D}/automations.json"`],
  ["echo 重定向写记录", `echo '{}' > "$HOME/Library/Application Support/orbita-dev-re/automations.json"`],
  ["tee 写记录", `printf x | tee "${D}/automations.json"`],
  ["ditto 恢复", `ditto /tmp/backup "${D}"`],
  ["ditto 解压", `ditto -x -k /tmp/b.zip "${D}"`],
  ["rm -r 数据目录", `rm -r "${D}"`],
  ["花括号备份记录", `cp "${D}/automations.json"{,.bak}`],
  ["mv 花括号改名记录", `mv "${D}/automations.json"{,.bak}`],
  ["冒号截断", `: > "${D}/automations.json"`],
  ["curl -o 记录", `curl -o "${D}/automations.json" http://x/y`],
  ["git clone 到数据目录", `git clone /tmp/repo "${D}/x"`],
  ["ls 重定向进数据目录", `ls "${D}" > "${D}/listing.txt"`],
  ["touch 数据目录里新文件", `touch "${D}/foo"`],
  ["mkdir 数据目录里", `mkdir "${D}/x"`],
  ["find 上级 exec rm", `find ~/Library/Application\\ Support -maxdepth 1 -name 'orbita-dev-re' -exec rm -rf {} +`],
  ["命令替换 rm", `rm -rf $(ls -d "${D}"/*)`],
  ["命令替换 find rm", `rm $(find "${D}" -name 'automations*')`],
  ["反引号 rm", "rm `ls \"" + D + "\"/automations*`"],
  ["xargs 文件管道 find", `find "${D}" -type f | xargs rm`],
  ["while read 管道", `ls "${D}" | while read f; do rm "${D}/$f"; done`],
  ["进程替换 xargs", `xargs rm < <(ls -d "${D}"/*)`],
  ["cp 记录到数据目录里别名", `cp /tmp/x "${D}/automations.json.bak"`],
  ["sed -i 数据目录其它文件", `sed -i '' 's/a/b/' "${D}/settings.json"`],
  ["python heredoc", `python3 - <<'EOF'\nimport os\nos.remove("${D}/automations.json")\nEOF`],
  ["perl -pi", `perl -pi -e 's/a/b/' "${D}/automations-archive.json"`],
  ["awk 重写", `awk '{print}' "${D}/automations.json" > "${D}/automations.json"`],
  ["cd 上级后 cp 恢复", `cd "${PARENT}" && cp -R /tmp/backup/orbita-dev-re .`],
  ["cd 上级后 cp 到 目录名", `cd "${PARENT}" && cp -R /tmp/backup/orbita-dev-re ./orbita-dev-re`],
  ["cd 上级后 rsync 恢复", `cd "${PARENT}" && rsync -a /tmp/backup/orbita-dev-re/ orbita-dev-re/`],
  ["cp 到上级（同名子目录合并）", `cp -R /tmp/backup/orbita-dev-re "${PARENT}/"`],
  ["mv 到上级覆盖", `mv /tmp/backup/orbita-dev-re "${PARENT}/"`],
  ["cp -R 通配到上级", `cp -R /tmp/backup/* "${PARENT}/"`],
  ["rsync 内容合并到上级", `rsync -a /tmp/backup/ "${PARENT}/"`],
  ["chmod 记录", `chmod 444 "${D}/automations.json"`],
  ["chflags", `chflags uchg "${D}/automations.json"`],
  ["xattr 清", `xattr -cr "${D}"`],
  ["Windows copy 覆盖", `copy /y C:\\tmp\\x "%APPDATA%\\orbita-dev-re\\automations.json"`],
  ["Copy-Item 到数据目录", `Copy-Item -Path C:\\tmp\\x -Destination "${D}" -Force`, "powershell"],
  ["Rename-Item 数据目录", `Rename-Item "${D}" x`, "powershell"],
  ["sudo rm", `sudo rm -rf "${D}"`],
  ["nohup rm", `nohup rm -rf "${D}" &`],
  ["timeout rm", `timeout 5 rm "${D}/automations.json"`],
  ["env FOO=1 rm", `env FOO=1 rm "${D}/automations.json"`],
  ["sh -c 双引号", `sh -c "rm -f '${D}/automations.json'"`],
  ["bash -c 单引号含变量路径", `bash -c 'rm -f "$HOME/Library/Application Support/orbita-dev-re/automations.json"'`],
  ["子 shell 里 rm", `(rm "${D}/automations.json")`],
  ["花括号组里 rm", `{ rm "${D}/automations.json"; }`],
  ["if 里 rm", `if true; then rm "${D}/automations.json"; fi`],
  ["for 变量展开", `for n in automations.json automations-archive.json; do rm "${D}/$n"; done`],
  ["find -exec mv", `find "${D}" -name '*.json' -exec mv {} /tmp \\;`],
  ["find -ok", `find "${D}" -name x -ok rm {} \\;`],
  ["find -fprint 写数据目录", `find /tmp -fprint "${D}/automations.json"`],
  ["rg --pre 数据目录", `rg --pre 'rm -f' x "${D}"`],
  ["写工作台外的 tmp 链接再 write(本条只测 ln)", `ln -s "${D}" /tmp/lnk`],
  ["mv 上级 Library", `mv ~/Library /tmp/Lib2`],
  ["rm -rf 家目录通配", `cd ~ && rm -rf *`],
  ["rm -rf Library 通配", `rm -rf ~/Library/*`],
  ["rm -rf Application Support 通配", `rm -rf ~/Library/Application\\ Support/*`],
  ["rm -rf 上级 orbita 通配", `rm -rf "${PARENT}"/orbita-dev-r*`],
  ["trash 命令", `trash "${D}"`],
  ["rm 大写记录名绝对", `rm "${D.toUpperCase()}/AUTOMATIONS.JSON"`],
  ["rm 数据目录 .. 绕", `rm "${PROJ}/../home/Library/Application Support/orbita-dev-re/automations.json"`],
  ["经目录链接 rm", `rm "${SCRATCH}/data-link/automations.json"`],
  ["经文件链接 rm 目标", `echo x > "${SCRATCH}/main-link.json"`],
  ["经链接 cp 覆盖", `cp /tmp/x "${SCRATCH}/data-link/"`],
  ["cd 经目录链接", `cd "${SCRATCH}/data-link" && ls`],
];
const normalCases: [string, string, string?, string?][] = [
  ["awk 无路径", `ls "${D}" | awk '{print $1}'`],
  ["sed 无路径", `ls "${D}" | sed 's/a/b/'`],
  ["grep 含文件名模式", `grep -rn 'automations.json' src`],
  ["rg 含空格模式", `rg 'foo bar' src`],
  ["find name 含空格", `find . -name 'a b'`],
  ["echo 带空格串", `echo "hello world"`],
  ["cp 数据目录往外备份", `cp -R "${D}" /tmp/bk`],
  ["rsync 备份数据目录", `rsync -a "${D}/" /tmp/bk2/`],
  ["tar 打包数据目录", `tar -czf /tmp/x.tgz -C "${PARENT}" orbita-dev-re`],
  ["tar 打包 绝对", `tar czf /tmp/x.tgz "${D}"`],
  ["tar 列表", `tar -tzf /tmp/x.tgz`],
  ["ls 上级 grep", `ls ~/Library/Application\\ Support | grep orbita`],
  ["du 通配", `du -sh ~/Library/Application\\ Support/orbita*`],
  ["读 settings", `cat "${D}/settings.json"`],
  ["jq settings", `jq . "${D}/settings.json"`],
  ["ls 工作台通配", `ls -la "${D}/workbenches"/*/`],
  ["rm 工作台通配里的 tmp", `rm -rf "${D}/workbenches"/*/tmp`],
  ["grep 数据目录", `grep -rn foo "${D}/workbenches"`],
  ["find 数据目录只读", `find "${D}" -maxdepth 1 -name 'settings*'`],
  ["wc 数据目录", `wc -c "${D}"/settings.json`],
  ["删别的实例整个目录", `rm -rf "${O}"`],
  ["cp 项目到别的实例", `cp -R "${P}" "${O}/copy"`],
  ["mv 项目文件到上级的别的子目录", `mv "${P}/x" "${HOME}/Library/Application Support/other-new"`],
  ["ls 数据目录 | sort", `ls "${D}" | sort`],
  ["ls 数据目录 | wc", `ls "${D}" | wc -l`],
  ["ls 后再 make", `ls "${D}"; echo done`],
  ["echo 命令替换里读数据目录", `echo $(ls "${D}")`],
  ["cd 工作台再 cp", `cd "${W}" && cp -R . /tmp/wbcopy`],
  ["工作台 git", `cd "${W}" && git init`],
  ["git 项目 clean", `git clean -fd`, P],
  ["rm -rf 项目 build", `rm -rf build`, P],
  ["python 项目 json", `python3 -c "import json; print(json.load(open('settings.json')))"`, P],
  ["mkdir 项目子目录", `mkdir -p "${P}/a/b"`],
  ["cp 到 /tmp 的 Library 同名", `cp x /tmp/Library/`],
  ["ln 项目内", `ln -s "${P}/a" "${P}/b"`],
];

function refusal(command: string, cwd = P, tool = "bash", files: readonly string[] = FILES): string | null {
  return protectedPathRefusal(tool, { command }, PATHS, cwd, files, GUARD);
}
function pathRefusal(path: string, tool = "write", files: readonly string[] = FILES): string | null {
  return protectedPathRefusal(tool, { path, content: "x" }, PATHS, P, files, GUARD);
}

/** 刻意绕过里闸门**拦不住**的（名字在运行时才拼出来、预写脚本、解码拼名、按 inode）：由主进程兜底接住。预期写死，防止无意中变化 */
const DELIBERATE_NOT_BLOCKED = new Set<string>(["python 环境变量与拼接", "node Buffer 解码文件名", "bash 执行预写脚本", "source 预写脚本", "sh 执行预写脚本", "xargs 从名单文件读", "外部环境变量给完整文件", "未知变量目录加通配", "python 环境变量完整路径", "find 未知根 print0 xargs", "while read 从文件删", " eval 间接变量", "bash -c 从环境取命令", "python exec 预写代码文件", "node require 预写模块"]);

describe("白名单闸门：自然写法必须拦", () => {
  for (const item of attacks.filter((row) => row.group === "natural")) {
    test(`拦：${item.name}`, () => {
      assert.notEqual(refusal(item.command, item.cwd, item.tool), null, `漏了：${item.command}`);
    });
  }
  for (const [name, command, cwd, tool] of natural) {
    test(`拦：${name}`, () => {
      assert.notEqual(refusal(command, cwd, tool ?? "bash"), null, `漏了：${command}`);
    });
  }
});

describe("白名单闸门：刻意绕过——每条预期写死", () => {
  for (const item of attacks.filter((row) => row.group === "deliberate")) {
    const blocked = !DELIBERATE_NOT_BLOCKED.has(item.name);
    test(`${blocked ? "拦" : "拦不住（兜底接）"}：${item.name}`, () => {
      assert.equal(refusal(item.command, item.cwd, item.tool) !== null, blocked, item.command);
    });
  }
});

describe("白名单闸门：正常命令必须放行", () => {
  for (const item of normal) {
    test(`放行：${item.name}`, () => {
      assert.equal(refusal(item.command, item.cwd, item.tool), null, `误伤：${item.command}`);
    });
  }
  for (const [name, command, cwd, tool] of normalCases) {
    test(`放行：${name}`, () => {
      assert.equal(refusal(command, cwd, tool ?? "bash"), null, `误伤：${command}`);
    });
  }
});

describe("白名单闸门：shell 读记录文件也拦，拒绝语指向 read 工具与 automation_list", () => {
  const reads: [string, string][] = [
    ["cat 主文件", `cat "${D}/automations.json"`],
    ["head 热归档", `head -n 20 "${D}/automations-archive.json"`],
    ["wc 冷文件", `wc -l "${D}/automations-archive-old.jsonl"`],
    ["tail 事件", `tail -n 5 "${D}/automations-events.jsonl"`],
    ["cd 后 cat", `cd "${D}" && cat automations.json`],
    ["sed 只读打印", `sed -n '1,5p' "${D}/automations.json"`],
    ["python 只读", `python3 -c "print(open('${D}/automations.json').read())"`],
    ["node 只读", `node -e "process.stdout.write(require('fs').readFileSync('${D}/automations.json','utf8'))"`],
    ["通配读", `cat "${D}"/automations-*.json`],
  ];
  for (const [name, command] of reads) {
    test(`拦：${name}`, () => {
      assert.match(refusal(command) ?? "", /read tool or automation_list/);
    });
  }
});

describe("白名单闸门：write / edit（记录文件及其兄弟）", () => {
  const cases: [string, string, "write" | "edit", boolean][] = [
    ["write 主文件", join(DATA, "automations.json"), "write", true],
    ["edit 热归档", join(DATA, "automations-archive.json"), "edit", true],
    ["write 冷文件大写", join(DATA, "AUTOMATIONS-ARCHIVE-OLD.JSONL"), "write", true],
    ["write 事件", join(DATA, "automations-events.jsonl"), "write", true],
    ["write tmp 兄弟", join(DATA, "automations.json.abc.tmp"), "write", true],
    ["edit bad 兄弟", join(DATA, "automations-archive.json.bad-1"), "edit", true],
    ["write tampered 兄弟", join(DATA, "automations.json.tampered-1"), "write", true],
    ["write 文件链接", join(SCRATCH, "main-link.json"), "write", true],
    ["edit 链接的链接", join(SCRATCH, "main-link-2.json"), "edit", true],
    ["write 经目录链接到新冷文件", join(SCRATCH, "data-link", "automations-archive-old.jsonl"), "write", true],
    ["write .. 绕回", join(WB, "..", "..", "automations.json"), "write", true],
    ["write 双斜杠与点", `${DATA}//./automations.json`, "write", true],
    ["write 项目同名", join(PROJ, "automations.json"), "write", false],
    ["edit 其他实例同名", join(OTHER, "automations-archive.json"), "edit", false],
    ["write 工作台同名", join(WB, "automations.json"), "write", false],
    ["write 工作台普通文件", join(WB, "note.txt"), "write", false],
    ["edit 经工作台链接", join(SCRATCH, "wb-link", "note.txt"), "edit", false],
    ["write 数据目录 settings", join(DATA, "settings.json"), "write", false],
    ["write 相近名字", join(DATA, "automations.jsonx"), "write", false],
  ];
  for (const [name, path, tool, shouldBlock] of cases) {
    test(`${shouldBlock ? "拦" : "放行"}：${name}`, () => {
      assert.equal(pathRefusal(path, tool) !== null, shouldBlock, path);
    });
  }
});

describe("开发实例额外保护正式实例的记录文件（只按文件保，目录里别的东西照常）", () => {
  const block = (command: string, cwd = P) => assert.notEqual(refusal(command, cwd, "bash", FILES_WITH_FORMAL), null, `漏了：${command}`);
  const allow = (command: string, cwd = P) => assert.equal(refusal(command, cwd, "bash", FILES_WITH_FORMAL), null, `误伤：${command}`);

  test("拦：删 / 改写 / 覆盖 / 读正式实例的记录", () => {
    block(`rm "${FM}/automations.json"`);
    block(`rm -f "${FM}"/automations*`);
    block(`rm "${FM}"/*.json`);
    block(`cp /tmp/backup/automations.json "${FM}/"`);
    block(`cp /tmp/x "${FM}/automations-archive.json"`);
    block(`echo '{}' > "${FM}/automations.json"`);
    block(`mv "${FM}/automations.json" /tmp/gone.json`);
    block(`cat "${FM}/automations.json"`);
    block(`cd "${FM}" && rm automations.json`);
    block(`ln -s "${FM}/automations.json" /tmp/lnk`);
    block(`sed -i '' 's/a/b/' "${FM}/automations-events.jsonl"`);
  });

  test("拦：删 / 改名 / chmod 正式实例的数据目录或它的上级", () => {
    block(`rm -rf "${FM}"`);
    block(`mv "${FM}" "${FM}-old"`);
    block(`chmod 000 "${FM}"`);
    block(`rm -rf ~/Library/Application\\ Support`);
    block(`rm -rf "${PARENT}"/orb*`);
    block(`cp -R /tmp/backup/orbita "${PARENT}/"`);
  });

  test("放行：正式实例目录里记录之外的东西、读、往外拷（instance-data.py seed 之类要拷它的 settings）", () => {
    allow(`ls -la "${FM}"`);
    allow(`cp "${FM}/settings.json" /tmp/settings-copy.json`);
    allow(`cp -R "${FM}" /tmp/formal-backup`);
    allow(`rm "${FM}/settings.json"`);
    allow(`rm -rf "${FM}/sessions/abc"`);
    allow(`du -sh "${FM}"`);
  });

  test("write / edit 也拦正式实例的记录文件及其兄弟，放行它的 settings", () => {
    assert.notEqual(pathRefusal(join(FORMAL, "automations.json"), "write", FILES_WITH_FORMAL), null);
    assert.notEqual(pathRefusal(join(FORMAL, "automations-events.jsonl.tmp"), "edit", FILES_WITH_FORMAL), null);
    assert.equal(pathRefusal(join(FORMAL, "settings.json"), "write", FILES_WITH_FORMAL), null);
  });

  test("没有正式实例名单（正式版自己、或测试）：正式目录就是别处，照常放行", () => {
    assert.equal(refusal(`rm "${FM}/automations.json"`, P, "bash", FILES), null);
  });

  test("本实例的数据目录仍然是整目录白名单（其它开发实例仍互相放行）", () => {
    assert.notEqual(refusal(`touch "${D}/foo"`, P, "bash", FILES_WITH_FORMAL), null);
    assert.equal(refusal(`rm -rf "${O}"`, P, "bash", FILES_WITH_FORMAL), null);
  });
});

describe("白名单闸门：判定细节", () => {
  test("拒绝语说清放行范围：只读、往外拷、工作台", () => {
    const reason = refusal(`touch "${D}/foo"`) ?? "";
    assert.match(reason, /read-only/);
    assert.match(reason, /copies out/);
    assert.match(reason, /workbenches/);
  });

  test("只读白名单之外的命令即使参数里只是数据目录也拒；白名单内的放行", () => {
    for (const command of [`ls "${D}"`, `stat "${D}"`, `du -sh "${D}"`, `file "${D}/settings.json"`, `wc -c "${D}/settings.json"`, `head -c 10 "${D}/settings.json"`, `grep -c x "${D}/settings.json"`, `find "${D}" -maxdepth 1 -type f`, `diff "${D}/settings.json" /tmp/x`, `shasum "${D}/settings.json"`]) {
      assert.equal(refusal(command), null, command);
    }
    for (const command of [`touch "${D}/x"`, `mkdir "${D}/x"`, `chmod 600 "${D}/settings.json"`, `mv "${D}/settings.json" /tmp`, `ln -s "${D}/settings.json" /tmp/l`, `tar -xf /tmp/a.tar -C "${D}"`, `git -C "${D}" status`, `python3 "${D}/x.py"`, `find "${D}" -type f -exec cat {} +`, `find "${D}" -fprint /tmp/x`, `rg --pre cat x "${D}"`]) {
      assert.notEqual(refusal(command), null, command);
    }
  });

  test("带 -delete / -exec 的 find 不是只读；rg --pre 不是只读", () => {
    assert.notEqual(refusal(`find "${D}" -name x -delete`), null);
    assert.notEqual(refusal(`find "${PARENT}" -name x -ok rm {} \\;`), null);
  });

  test("以数据目录为源往外拷放行（备份），但源不能是受保护的记录文件，目标不能落进数据目录", () => {
    assert.equal(refusal(`cp -R "${D}" /tmp/bk`), null);
    assert.equal(refusal(`cp "${D}/settings.json" /tmp/s.json`), null);
    assert.equal(refusal(`rsync -a "${D}/" /tmp/bk/`), null);
    assert.equal(refusal(`tar -czf /tmp/x.tgz -C "${PARENT}" orbita-dev-re`), null);
    assert.notEqual(refusal(`cp "${D}/automations.json" /tmp/bk.json`), null);
    assert.notEqual(refusal(`cp /tmp/a "${D}/"`), null);
    assert.notEqual(refusal(`rsync -a --remove-source-files "${D}/" /tmp/bk/`), null);
    assert.notEqual(refusal(`tar -cf "${D}/x.tar" src`), null);
  });

  test("管道 / 命令替换把「列出来的名字」交给别的命令：拒；交给过滤器：放行", () => {
    assert.notEqual(refusal(`ls "${D}" | xargs rm`), null);
    assert.notEqual(refusal(`rm -rf $(ls -d "${D}"/*)`), null);
    assert.equal(refusal(`ls "${D}" | sort | head -3`), null);
    assert.equal(refusal(`ls "${D}"; echo done`), null);
    assert.equal(refusal(`echo $(ls "${D}")`), null);
  });

  test("当前目录在数据目录里：只读放行，其余拒；在工作台里：照常", () => {
    assert.equal(refusal(`ls`, D), null);
    assert.notEqual(refusal(`touch x`, D), null);
    assert.notEqual(refusal(`git status`, D), null);
    assert.equal(refusal(`touch x`, WB), null);
    assert.equal(refusal(`git init`, WB), null);
  });

  test("当前目录在数据目录的上级：隐含在当前目录里动手的命令拒，别的放行", () => {
    assert.notEqual(refusal(`git clean -fdx`, PARENT), null);
    assert.notEqual(refusal(`rm -rf *`, PARENT), null);
    assert.notEqual(refusal(`rm -rf .`, PARENT), null);
    assert.equal(refusal(`ls -la`, PARENT), null);
    assert.equal(refusal(`rm -rf build`, PARENT), null);
  });

  test("符号链接：经链接指到数据目录与记录文件的命令按真实位置判", () => {
    assert.notEqual(refusal(`rm "${SCRATCH}/data-link/automations.json"`), null);
    assert.notEqual(refusal(`cp /tmp/x "${SCRATCH}/data-link/"`), null);
    assert.notEqual(refusal(`echo x > "${SCRATCH}/main-link.json"`), null);
    assert.notEqual(refusal(`cd "${SCRATCH}/data-link" && touch x`), null);
    assert.equal(refusal(`echo x > "${SCRATCH}/wb-link/out.txt"`), null);
  });
});

/**
 * 复验后的修补：白名单里「只读」命令的输出类选项能往数据目录写（sort -o<文件> 连写、diff --output、find -fls / -fprint*）。
 * 判断改成按**参数的角色**：数据目录里的词只能是输入操作数，或已知「只带输入」选项的取值；别的选项的取值位置、
 * 含不认识的选项的命令里出现数据目录路径，一律拒（OPTION_SPECS，每个命令一份已知安全选项）。
 */
describe("白名单命令的选项按角色判：写文件的选项一律拒，已知只读选项照放", () => {
  const block = (command: string, cwd = P): void => assert.notEqual(refusal(command, cwd), null, `漏了：${command}`);
  const allow = (command: string, cwd = P): void => assert.equal(refusal(command, cwd), null, `误伤：${command}`);

  test("sort -o / --output / -T：连写、分开写、等号写都拒（数据目录里的非记录文件也算）", () => {
    block(`cat /tmp/x | sort -o"${D}/junk.txt"`);
    block(`ls | sort -o"${D}/junk.txt"`);
    block(`sort -o${DS}/junk.txt /tmp/x`);
    block(`sort -o "${D}/junk.txt" /tmp/x`);
    block(`sort --output="${D}/junk.txt" /tmp/x`);
    block(`sort --output "${D}/junk.txt" /tmp/x`);
    block(`sort -T "${D}" /tmp/x`);
    block(`sort -T"${D}" /tmp/x`);
    block(`sort -o"${D}/settings.json" /tmp/x`);
    allow(`sort -o out.txt in.txt`);
    allow(`cat in.txt | sort -oout.txt`);
    allow(`sort -o "${W}/out.txt" in.txt`);
  });

  test("diff：--output / -o / 不认识的选项带着数据目录拒；已知输入类照放", () => {
    block(`diff --output="${D}/o.txt" a b`);
    block(`diff -o "${D}/o.txt" a b`);
    block(`diff -o${DS}/o.txt a b`);
    block(`diff --foo "${D}/settings.json" b`);
    allow(`diff a "${D}/settings.json"`);
    allow(`diff -u a "${D}/settings.json"`);
    allow(`diff -rq a "${D}"`);
    allow(`diff --brief --to-file="${D}/settings.json" a`);
    allow(`diff -U 5 a "${D}/settings.json"`);
  });

  test("find：-fls / -fprint / -fprint0 / -fprintf 的输出文件、-exec 命令行里的数据目录都拒；只读的 find 照放", () => {
    block(`find /tmp -fls "${D}/l.txt"`);
    block(`find /tmp -fprint "${D}/l.txt"`);
    block(`find /tmp -fprint0 "${D}/l.txt"`);
    block(`find /tmp -fprintf "${D}/l.txt" %p`);
    block(`find /tmp -name x -exec cp {} "${D}/" \\;`);
    block(`find /tmp -name x -execdir tee "${D}/y" \\;`);
    block(`find /tmp -ok mv {} "${D}/y" \\;`);
    allow(`find "${D}" -name 'settings*' -print`);
    allow(`find "${D}" -maxdepth 1 -type f -ls`);
    allow(`find "${D}" -newer /tmp/x -print`);
    allow(`find /tmp -newer "${D}/settings.json" -print`);
    allow(`find . -name '*.tmp' -fprint /tmp/list.txt`);
  });

  test("grep / rg / head / tail / wc / cat / ls / stat / du / file / shasum / md5：已知选项照放，输出类与不认识的选项拒", () => {
    // 已知只读选项 + 数据目录里的输入操作数：放行
    for (const command of [
      `grep -rn foo "${D}/workbenches"`,
      `grep -f "${D}/settings.json" /tmp/x`,
      `grep -r --exclude-from="${D}/settings.json" foo /tmp`,
      `grep -c -e foo "${D}/settings.json"`,
      `rg -n foo "${D}/workbenches"`,
      `rg -f "${D}/settings.json" /tmp`,
      `rg --files "${D}/workbenches"`,
      `head -n 5 "${D}/settings.json"`,
      `head -c10 "${D}/settings.json"`,
      `tail -f "${D}/settings.json"`,
      `tail -fn5 "${D}/settings.json"`,
      `wc -l "${D}/settings.json"`,
      `wc --files0-from="${D}/settings.json"`,
      `cat -n "${D}/settings.json"`,
      `ls -la "${D}"`,
      `ls --color=auto "${D}"`,
      `ls -1 "${D}/workbenches"`,
      `stat -f %z "${D}/settings.json"`,
      `stat -x "${D}"`,
      `du -sh "${D}"`,
      `du -d 1 "${D}"`,
      `du --exclude-from="${D}/settings.json" /tmp`,
      `file -b "${D}/settings.json"`,
      `file -m "${D}/settings.json" /tmp/x`,
      `shasum -a 256 "${D}/settings.json"`,
      `md5 -r "${D}/settings.json"`,
      `jq -c . "${D}/settings.json"`,
    ]) allow(command);
    // 输出类 / 取值位置落进数据目录 / 不认识的选项带数据目录：拒
    for (const command of [
      `rg --foo="${D}/x" y`,
      `rg --pre "${D}/x" y /tmp`,
      `grep --output "${D}/x" foo /tmp`,
      `grep -e "${D}/settings.json" foo`,
      `head -n "${D}/x" y`,
      `tail --foo "${D}/settings.json"`,
      `wc --weird "${D}/settings.json"`,
      `cat --bogus "${D}/settings.json"`,
      `ls -I "${D}/x" "${D}"`,
      `ls --bogus "${D}"`,
      `stat -f "${D}/x" y`,
      `du --bogus "${D}"`,
      `file -C -m "${D}/magic"`,
      `file -C "${D}/magic"`,
      `shasum --foo "${D}/settings.json"`,
      `md5 --bogus "${D}/settings.json"`,
      `jq --arg a "${D}/x" . y`,
    ]) block(command);
    // 不碰数据目录的命令不受影响（不认识的选项也无所谓）
    allow(`ls --bogus /tmp`);
    allow(`du --bogus /tmp`);
  });

  test("record 家族仍然读也拒（角色检查之前就拒）", () => {
    block(`head -n 5 "${D}/automations.json"`);
    block(`sort -o"${D}/automations.json" x`);
  });
});

describe("解释器单行里的同名文件：能确定落点就放行，有任何不确定仍拒（两个方向）", () => {
  const block = (command: string, cwd = P): void => assert.notEqual(refusal(command, cwd), null, `漏了：${command}`);
  const allow = (command: string, cwd = P): void => assert.equal(refusal(command, cwd), null, `误伤：${command}`);

  test("放行：当前目录是项目目录（不在数据目录里），裸名 / 相对路径 / 别处的绝对路径", () => {
    allow(`python3 -c "open('automations.json','w').write('{}')"`);
    allow(`python3 -c "from pathlib import Path; Path('automations-archive.json').write_text('')"`);
    allow(`node -e "require('fs').writeFileSync('automations-archive.json','')"`);
    allow(`node -e "require('fs').writeFileSync('./automations.json','{}')"`);
    allow(`python3 -c "open('sub/dir/automations.json','w')"`);
    allow(`python3 -c "open('../other/automations.json','w')"`);
    allow(`python3 -c "open('${P}/automations.json','w')"`);
    allow(`perl -e 'unlink "automations.json"'`);
    allow(`python3 -c "open('automations.json','w')"`, W);
    allow(`python3 -c "open('automations.json','w')"`, OTHER);
  });

  test("拒：出现 chdir / 环境变量 / 取 cwd / 路径拼接 / 起别的进程，裸名就不能按当前目录解析", () => {
    block(`python3 -c "import os; os.chdir('/tmp'); open('automations.json','w')"`);
    block(`node -e "process.chdir('/tmp'); require('fs').writeFileSync('automations.json','')"`);
    block(`python3 -c "import os; open(os.environ['X'] + '/automations.json','w')"`);
    block(`node -e "require('fs').writeFileSync(process.env.X + '/automations.json','')"`);
    block(`python3 -c "import os; open(os.path.join(os.getcwd(), 'automations.json'), 'w')"`);
    block(`python3 -c "import subprocess; subprocess.run(['rm','automations.json'])"`);
    block(`python3 -c "import os; os.system('rm automations.json')"`);
    block(`python3 -c "open(f'{d}/automations.json','w')".format(d='x')`);
    block(`python3 -c "open('automations.json'.format(), 'w')"`);
  });

  test("拒：数据目录的字样、当前目录就在数据目录里、解析后落在数据目录上级里的记录名", () => {
    block(`python3 -c "open('${D}/automations.json','w')"`);
    block(`python3 -c "open('${D}/settings.json','w')"`);
    block(`python3 -c "open('automations.json','w')"`, D);
    block(`python3 -c "open('../../automations.json','w')"`, W);
    block(`node -e "require('fs').writeFileSync('automations.json','')"`, D);
  });
});

describe("CDPATH：设了 CDPATH 的相对 cd 不猜，按解析不出来拒", () => {
  const withEnv = (command: string, env: Record<string, string>): string | null =>
    protectedPathRefusal("bash", { command }, PATHS, P, FILES, { home: HOME, env: { ...GUARD.env, ...env } });

  test("命令里自己设 CDPATH（行内赋值 / export）：相对 cd 拒", () => {
    assert.notEqual(refusal(`CDPATH=/tmp/evil cd sub && rm automations.json`, P), null);
    assert.notEqual(refusal(`export CDPATH=/tmp/evil; cd sub && ls`, P), null);
    assert.notEqual(refusal(`CDPATH="${PARENT}" cd orbita-dev-re`, P), null);
  });

  test("环境里本来就有 CDPATH：相对 cd 拒；绝对路径与 ./ ../ 开头的不受 CDPATH 影响，照放", () => {
    assert.notEqual(withEnv(`cd sub`, { CDPATH: "/tmp:/x" }), null);
    assert.equal(withEnv(`cd /tmp && ls`, { CDPATH: "/tmp:/x" }), null);
    assert.equal(withEnv(`cd ./sub && ls`, { CDPATH: "/tmp:/x" }), null);
    assert.equal(withEnv(`cd ../sibling && ls`, { CDPATH: "/tmp:/x" }), null);
    assert.equal(withEnv(`cd sub`, {}), null, "没设 CDPATH 就是普通的相对 cd");
    assert.equal(refusal(`cd sub && ls`, P), null);
  });
});
