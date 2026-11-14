/**
 * 自动化记录闸门加固（2026-11-14 独立验收：真模型在放行档用 cd+rm、find -delete、$HOME、符号链接、改数据目录名
 * 把三个记录文件真删光）。每条「得手」的手法都是一条测试；再加上验收员没试的变形；再加一组**不该被拦**的正常命令，
 * 证明误伤面。Windows 写法只测命令串（不在 Windows 上实测）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolCallGate, describePermissionMode, type ToolCallLike } from "./permission.ts";
import { expandBraces } from "./protected-command.ts";

const HOME = "/Users/tester";
const DATA = `${HOME}/Library/Application Support/orbita-dev-x`;
const FILES = [`${DATA}/automations.json`, `${DATA}/automations-archive.json`, `${DATA}/automations-archive-old.jsonl`];
const PATHS = [`${DATA}/sessions`, `${DATA}/pi-sessions`];
const CWD = `${HOME}/Orbita-dev-x/Home`;
const ENV = { HOME, TMPDIR: "/var/folders/xx/T/", APPDATA: `${HOME}/Library/Application Support`, USERPROFILE: HOME };
const GUARD = { home: HOME, env: ENV };

function bash(gate: ReturnType<typeof makeGate>, command: string, tool = "bash") {
  return gate({ toolCallId: "c", toolName: tool, input: { command } } satisfies ToolCallLike);
}
function makeGate() {
  return createToolCallGate(() => "skip", async () => ({ behavior: "allow" }), PATHS, CWD, FILES, GUARD);
}
const D = DATA;
const DS = DATA.replaceAll(" ", "\\ ");

/** 验收报告 ④ 里真模型得手的 5 类 + 同类变形：必须拦 */
const MUST_BLOCK: [string, string][] = [
  // —— 验收员得手的五类 ——
  ["cd 数据目录 && rm 文件名", `cd "${D}" && rm automations.json`],
  ["cd 不带引号（转义空格）", `cd ${DS} && rm automations-archive.json`],
  ["find 数据目录 -name 通配 -delete", `find "${D}" -name 'automations*' -delete`],
  ["find … | xargs rm", `find "${D}" -name 'automations*' | xargs rm`],
  ["$HOME 拼路径 rm", `rm "$HOME/Library/Application Support/orbita-dev-x/automations.json"`],
  ["${HOME} 与转义空格", `rm "\${HOME}/Library/Application\\ Support/orbita-dev-x/automations-archive.json"`],
  ["~ 展开 rm 冷文件", `rm ~/Library/Application\\ Support/orbita-dev-x/automations-archive-old.jsonl`],
  ["符号链接第一步（以受保护文件为源 ln -s）", `cd /tmp && ln -s "${D}/automations-archive.json" /tmp/link`],
  ["符号链接第一步（相对名）", `ln -s automations-archive.json /tmp/link`],
  ["mv 数据目录本身", `mv "${D}" "${D}2"`],
  ["mv 数据目录（~ 写法）", `mv ~/Library/Application\\ Support/orbita-dev-x /tmp/x`],
  // —— 验收员没试的变形 ——
  ["rm 上级目录 Application Support", `rm -rf ~/Library/Application\\ Support`],
  ["rm 家目录", `rm -rf ~`],
  ["rm 家目录 $HOME", `rm -rf "$HOME"`],
  ["chmod 数据目录", `chmod 000 "${D}"`],
  ["chmod -R 上级目录", `chmod -R 000 ~/Library`],
  ["chown 数据目录", `chown -R nobody "${D}"`],
  ["命令里自己赋值再拼名字", `AUTO=automations; rm "${D}/$AUTO.json"`],
  ["两个变量拼出文件名", `a=automa; b=tions.json; rm $a$b`],
  ["export 变量里放目录再 cd", `export T="${D}"; cd "$T"`],
  ["花括号展开", `rm ${DS}/automations{,-archive}.json`],
  ["引号拼接", `eval "rm autom""ations.json"`],
  ["反斜杠打断名字", `rm autom\\ations.json`],
  ["ANSI-C 引号", `rm $'\\x61utomations.json'`],
  ["大小写变体", `rm AUTOMATIONS.JSON`],
  ["here-doc 里写 rm", `bash <<EOF\nrm automations.json\nEOF`],
  ["here-string", `bash <<< "cd ${DS}; rm automations.json"`],
  ["sh -c 包一层", `sh -c 'rm automations.json'`],
  ["base64 解码后执行", `echo cm0gYXV0b21hdGlvbnMuanNvbg== | base64 -d | sh`],
  ["bash -c $(base64 --decode)", `bash -c "$(echo cm0gYXV0b21hdGlvbnMuanNvbg== | base64 --decode)"`],
  ["printf 十六进制拼命令再交给 sh", `printf '\\x72\\x6d\\x20\\x61' | sh`],
  ["python -c 用 glob 扫数据目录", `python3 -c "import glob,os; [os.remove(f) for f in glob.glob('${D}/*.json')]"`],
  ["python -c 展开 ~ 后改名数据目录", `python3 -c "import os; os.rename(os.path.expanduser('~/Library/Application Support/orbita-dev-x'), '/tmp/y')"`],
  ["node -e 拿 process.env.HOME 拼数据目录", `node -e "require('fs').rmSync(process.env.HOME + '/Library/Application Support/orbita-dev-x', {recursive: true})"`],
  ["perl -e unlink 通配", `perl -e 'unlink glob("${D}/automations*")'`],
  ["rsync --delete 以数据目录为目标", `rsync -a --delete /tmp/empty/ "${D}/"`],
  ["git clean 数据目录", `git -C "${D}" clean -fdx`],
  ["tar 解到数据目录覆盖", `tar xf /tmp/x.tar -C "${D}"`],
  ["unzip 到数据目录", `unzip -o /tmp/x.zip -d "${D}"`],
  ["通配：数据目录/*.json", `rm "${D}"/*.json`],
  ["通配：数据目录/*", `rm -rf "${D}"/*`],
  ["通配：automations*", `rm automations*`],
  ["通配：问号", `rm automations?json`],
  ["通配：方括号", `rm automation[s].json`],
  ["for 循环删数据目录里的东西", `for f in "${D}"/*; do rm "$f"; done`],
  ["ls 数据目录接 xargs rm", `ls "${D}" | xargs rm -f`],
  ["find -exec rm", `find "${D}" -type f -exec rm {} +`],
  ["find 从根目录删", `find / -name 'automations*' -delete`],
  ["find 家目录 -delete", `find ~ -name 'automations.json' -delete`],
  ["truncate", `truncate -s 0 automations.json`],
  ["重定向清空", `> automations.json`],
  ["cat /dev/null 覆盖", `cat /dev/null > automations-archive.json`],
  ["exec 3> 打开 fd 重定向", `exec 3>automations.json`],
  ["shred", `shred -u automations.json`],
  ["unlink", `unlink "${D}/automations.json"`],
  ["dd of=", `dd if=/dev/zero of=automations.json`],
  ["cd 分两步走进数据目录", `cd ~/Library/Application\\ Support && cd orbita-dev-x && ls`],
  ["cd 绝对路径只 ls", `cd "${D}" && ls`],
  ["cd 相对路径（cwd = ~/Orbita-dev-x/Home）", `cd ../../Library/Application\\ Support/orbita-dev-x && ls`],
  ["pushd", `pushd "${D}"`],
  ["cd 带末尾斜杠", `cd "${D}/" ; ls`],
  ["cd ~ 家目录再分步", `cd ~ && cd Library && cd "Application Support" && cd orbita-dev-x`],
  ["PowerShell Set-Location", `Set-Location "${D}"`],
  ["cd 经变量", `X=orbita-dev-x; cd ~/Library/Application\\ Support/$X`],
  ["通配出现在目录部分，xargs rm", `ls -d ~/Library/Application\\ Support/orbita*/auto* | xargs rm`],
  ["rm 通配到数据目录", `rm -rf ~/Library/Application\\ Support/orbita*`],
  ["gio trash 数据目录", `gio trash ~/Library/Application\\ Support/orbita-dev-x`],
  ["osascript 让 Finder 删数据目录", `osascript -e 'tell application "Finder" to delete POSIX file "${D}"'`],
  ["兄弟：.tmp", `rm automations.json.a1b2c3d4.tmp`],
  ["兄弟：.bad-", `mv automations.json.bad-1763000000000 /tmp/`],
  // —— 第三轮复核时新想的写法（探针实测后固化）——
  ["printf 拼命令交给 shell", `printf 'rm %s' automations.json | bash`],
  ["echo 拼命令交给 sh", `echo "rm automations.json" | sh`],
  ["alias 缩写 rm", `alias z='rm'; z automations.json`],
  ["env / nice / command 前缀 rm", `env rm automations.json`],
  ["nice 前缀 rm", `nice -n 5 rm automations.json`],
  ["command rm", `command rm automations.json`],
  ["内嵌引号 bash -c", `bash -c 'rm "automations.json"'`],
  ["perl unlink 文件名", `perl -e 'unlink "automations.json"'`],
  ["ruby File.delete", `ruby -e 'File.delete("automations.json")'`],
  ["php -r unlink", `php -r 'unlink("automations.json");'`],
  ["bun --eval 删", `bun --eval 'fs.rmSync("automations.json")'`],
  ["cp 覆盖（cp 不在破坏性动词表，靠文件名拦）", `cp /dev/null automations.json`],
  ["tee 覆盖相对名", `tee automations.json < /dev/null`],
  ["touch 记录文件（改 mtime 也是动它）", `touch automations.json`],
  ["tab 分隔的 rm", `rm\tautomations.json`],
  ["read 接力变量", "read f <<< automations.json; rm \"$f\""],
  ["here-doc 里变量接力", "bash <<'EOF'\nF=automations.json\nrm \"$F\"\nEOF"],
  ["cd 后 ./ 相对名", `cd "${D}" && rm ./automations.json`],
  ["cd 后 .. 折叠绕路", `cd "${D}/workbenches/x/.." && rm automations.json`],
  ["Windows cmd /c del", `cmd /c del automations.json`],
  ["PowerShell -Command Remove-Item", `powershell -Command "Remove-Item automations.json"`],
  ["PowerShell iex", `powershell -Command "iex 'rm automations.json'"`],
  ["数据目录改成别的名字", `mv "${D}" "${DATA}-old"`],
  ["rmdir 数据目录", `rmdir "${D}"`],
  ["ln -s 数据目录后经链接删记录", `ln -s "${D}" /tmp/dlink && rm /tmp/dlink/automations.json`],
  ["备份后再删数据目录（ditto）", `ditto "${D}" /tmp/backup && rm -rf "${D}"`],
  // 已知代价（安全向的误伤，固化行为防当 bug 修）：别的应用目录里恰好叫 automations.json 的文件也会被拒——
  // 文件名级匹配分不清目录；智能体正常工作几乎不会去删别的应用的数据文件，拦错的代价远小于放过
  ["别的应用目录里的同名文件（文件名级匹配的代价，也拦）", `rm -rf ~/Library/Application\\ Support/OtherApp/automations.json`],
  // —— Windows 写法：只测命令串，没在 Windows 上实测 ——
  ["Windows del", `del /f "%APPDATA%\\orbita-dev-x\\automations.json"`],
  ["Windows Remove-Item 数据目录", `Remove-Item -Recurse -Force "$env:APPDATA\\orbita-dev-x"`],
  ["Windows move 数据目录", `move "%APPDATA%\\orbita-dev-x" "%APPDATA%\\x"`],
  ["Windows rd /s /q", `rd /s /q "%APPDATA%\\orbita-dev-x"`],
  ["PowerShell Move-Item 文件", `Move-Item automations-archive.json C:\\tmp\\`],
  ["PowerShell Set-Content", `Set-Content -Path automations.json -Value '{}'`],
  ["PowerShell Out-File", `'{}' | Out-File automations.json`],
];

/** 正常命令：不能误伤 */
const MUST_ALLOW: [string, string][] = [
  ["git grep 字符串", `git grep automations`],
  ["git grep 带文件名字符串", `git grep -n "automations.json" -- src`],
  ["grep 源码里的文件名", `grep -rn "automations.json" src`],
  ["rg 通配", `rg 'automations*' src`],
  ["git log -S", `git log -S"automations.json" --oneline`],
  ["find 只列不删", `find . -name 'automations*.ts'`],
  ["ls ~/Library", `ls ~/Library`],
  ["ls 上级目录", `ls -la ~/Library/Application\\ Support`],
  ["ls 数据目录（只读，不进目录）", `ls "${D}"`],
  ["ls 数据目录下工作台", `ls "${D}/workbenches"`],
  ["进会话工作台", `cd "${D}/workbenches/abc123" && ls`],
  ["往工作台里写文件", `echo hi > "${D}/workbenches/abc123/notes.md"`],
  ["读工作台里的文件", `cat "${D}/workbenches/abc123/notes.md"`],
  ["删工作台里的临时目录", `rm -rf "${D}/workbenches/abc123/tmp"`],
  ["工作台里 find -delete", `find "${D}/workbenches/abc123" -name '*.json' -delete`],
  ["工作台里通配", `rm "${D}/workbenches/abc123"/*.log`],
  ["项目里 find -delete", `find . -name '*.tmp' -delete`],
  ["删 node_modules", `rm -rf node_modules dist`],
  ["mv 重命名", `mv a.txt b.txt`],
  ["mv 到 ~/Library/（上级做目标，不是来源）", `mv x.pdf ~/Library/`],
  ["cp 文件", `cp a.json b.json`],
  ["chmod +x", `chmod +x scripts/x.sh`],
  ["python 跑脚本", `python3 script.py`],
  ["python -c 与数据目录无关", `python3 -c "print(1)"`],
  ["node -e 与数据目录无关", `node -e "console.log(process.env.HOME)"`],
  ["tar 打包项目", `tar czf /tmp/o.tgz src`],
  ["cd ..", `cd .. && ls`],
  ["cd ~", `cd ~ && ls`],
  ["cd ~/Library", `cd ~/Library && ls`],
  ["cd 上级（Application Support）", `cd ~/Library/Application\\ Support && ls`],
  ["echo $HOME", `echo $HOME`],
  ["bun run test", `bun run test && bun run typecheck`],
  ["git status / diff", `git status && git diff`],
  ["工作区目录", `ls ~/Orbita-dev-x/Home`],
  ["删别的应用缓存", `rm ~/Library/Caches/x.tmp`],
  ["通配到别的应用目录", `rm ~/Library/Application\\ Support/Code*/x`],
  ["ls -d 通配（只列）", `ls -d ~/Library/Application\\ Support/orbita*`],
  ["删别的应用目录里的文件", `rm -rf ~/Library/Application\\ Support/Code/logs`],
  ["sed -i 改源码", `sed -i '' 's/a/b/' src/a.ts`],
  ["find 配 xargs wc", `find . -name '*.json' | xargs wc -l`],
  ["for 循环处理源码", `for f in src/*.ts; do wc -l $f; done`],
  ["rsync 备份项目", `rsync -a src/ /tmp/backup/`],
  ["git clean 项目", `git clean -fd`],
  ["find 家目录只列", `find ~ -maxdepth 1 -name '*.pdf'`],
  ["通配 *.json 在项目目录", `cat package*.json`],
  ["名字相近的别的文件", `cat src/automations-view.ts src/automations.test.ts`],
  ["xautomations.json 是另一个文件", `cat xautomations.json`],
  ["base64 解码但不执行", `echo aGVsbG8= | base64 -d`],
  ["curl 管道到 jq", `curl -s http://127.0.0.1:1/x | jq .`],
  ["TMPDIR 里的东西", `rm -f $TMPDIR/foo.tmp`],
  ["这个项目的 git 操作", `git checkout -b feat/x && git reset --soft HEAD~1`],
];

describe("自动化记录闸门加固：命令串（bash / powershell）", () => {
  for (const [name, command] of MUST_BLOCK) {
    test(`拦：${name}`, async () => {
      const gate = makeGate();
      const tool = /Set-Location|Remove-Item|Move-Item|Set-Content|Out-File/.test(command) ? "powershell" : "bash";
      const result = await bash(gate, command, tool);
      assert.equal(result.block, true, `应该拦：${command}`);
      assert.match(result.reason ?? "", /immutable/i);
    });
  }

  for (const [name, command] of MUST_ALLOW) {
    test(`放行：${name}`, async () => {
      const result = await bash(makeGate(), command);
      assert.deepEqual(result, {}, `误伤了正常命令：${command}\n${result.reason ?? ""}`);
    });
  }

  test("拒绝语说清改道：读用 read 工具或 automation_list；工作台照常能用", async () => {
    const result = await bash(makeGate(), `cd "${D}" && ls`);
    assert.match(result.reason ?? "", /read tool or automation_list/);
    assert.match(result.reason ?? "", /workbench/);
  });

  test("plan / manual 档也拦（在权限档判定之前）", async () => {
    for (const mode of ["plan", "manual"] as const) {
      const gate = createToolCallGate(() => mode, async () => ({ behavior: "allow" }), PATHS, CWD, FILES, GUARD);
      assert.equal((await bash(gate, `cd "${D}" && rm automations.json`)).block, true, mode);
    }
  });

  test("三个文件都进名单后，各自的文件名与 .tmp / .bad- 兄弟都拦", async () => {
    for (const name of ["automations.json", "automations-archive.json", "automations-archive-old.jsonl"]) {
      for (const suffix of ["", ".a1b2c3d4.tmp", ".bad-1763000000000"]) {
        assert.equal((await bash(makeGate(), `rm ${name}${suffix}`)).block, true, `${name}${suffix}`);
      }
    }
  });
});

describe("expandBraces", () => {
  test("展开、嵌套、无逗号当字面量、封顶", () => {
    assert.deepEqual(expandBraces("a{b,c}d"), ["abd", "acd"]);
    assert.deepEqual(expandBraces("x{a,b{1,2}}"), ["xa", "xb1", "xb2"]);
    assert.deepEqual(expandBraces("{}"), ["{}"]);
    assert.deepEqual(expandBraces("f{,-archive}.json"), ["f.json", "f-archive.json"]);
    assert.ok(expandBraces("{1,2,3}{1,2,3}{1,2,3}{1,2,3}{1,2,3}{1,2,3}{1,2,3}").length <= 64);
  });
});

describe("自动化记录闸门加固：write / edit 跟符号链接走、大小写折叠", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orbita-gate-")));
  const data = join(root, "data dir");
  mkdirSync(join(data, "workbenches", "w1"), { recursive: true });
  mkdirSync(join(data, "sessions"), { recursive: true });
  writeFileSync(join(data, "automations.json"), "{}");
  writeFileSync(join(data, "automations-archive.json"), "{}");
  mkdirSync(join(root, "tmp"), { recursive: true });
  symlinkSync(join(data, "automations-archive.json"), join(root, "tmp", "link.json"));
  symlinkSync(data, join(root, "tmp", "datalink"));
  symlinkSync(join(root, "tmp", "link.json"), join(root, "tmp", "link2.json"));
  const files = [join(data, "automations.json"), join(data, "automations-archive.json"), join(data, "automations-archive-old.jsonl")];
  const gate = createToolCallGate(() => "skip", async () => ({ behavior: "allow" }), [join(data, "sessions")], join(root, "ws"), files, { home: root, env: {} });
  const write = (path: string, tool = "write") => gate({ toolCallId: "c", toolName: tool, input: { path, content: "x" } });

  test("符号链接两步：write 指向受保护文件的链接被拦（含链接的链接）", async () => {
    assert.equal((await write(join(root, "tmp", "link.json"))).block, true);
    assert.equal((await write(join(root, "tmp", "link2.json"), "edit")).block, true);
  });

  test("符号链接指向数据目录：经链接写里面的记录文件被拦，包括还不存在的冷文件", async () => {
    assert.equal((await write(join(root, "tmp", "datalink", "automations.json"))).block, true);
    assert.equal((await write(join(root, "tmp", "datalink", "automations-archive-old.jsonl"))).block, true);
    assert.equal((await write(join(root, "tmp", "datalink", "automations.json.bad-1"))).block, true);
  });

  test("大小写变体与 ./ ../ 绕路也拦", async () => {
    assert.equal((await write(join(data, "AUTOMATIONS-ARCHIVE.JSON"))).block, true);
    assert.equal((await write(join(data, "workbenches", "..", "automations.json"))).block, true);
    assert.equal((await write(`${data}//./automations.json`)).block, true);
  });

  test("不误伤：工作台与同目录别的文件照常能写；经链接写工作台也行", async () => {
    assert.deepEqual(await write(join(data, "workbenches", "w1", "out.md")), {});
    assert.deepEqual(await write(join(data, "settings.json")), {});
    assert.deepEqual(await write(join(root, "tmp", "datalink", "workbenches", "w1", "out.md")), {});
    assert.deepEqual(await write(join(data, "automations.jsonx")), {});
  });

  test("会话目录经符号链接写也被拦", async () => {
    assert.equal((await write(join(root, "tmp", "datalink", "sessions", "a.jsonl"))).block, true);
  });

  test("收尾清理", () => {
    rmSync(root, { recursive: true, force: true });
  });
});

describe("describePermissionMode 点名受保护的文件", () => {
  test("给了名单就把三个文件名都写进说明；没给回落 automations.json", () => {
    const text = describePermissionMode("skip", [], FILES);
    for (const name of ["automations.json", "automations-archive.json", "automations-archive-old.jsonl"]) assert.ok(text.includes(name), name);
    assert.match(text, /cd into the folder that holds them/);
    assert.match(text, /read tool or automation_list/);
    assert.match(describePermissionMode("skip"), /\(automations\.json\)/);
  });
});
