import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { envRowsOf, type EnvRowTexts } from "./latex-settings-rows.ts";
import type { LatexEnvCheckResult, LatexProbeResult } from "../../../../shared/latex.ts";

const TEXTS: EnvRowTexts = {
  latexmk: "latexmk 编译器",
  synctex: "synctex（源码↔PDF 定位）",
  chktex: "chktex（行内检查）",
  pandoc: "pandoc ≥ 3.10.2（导出 Word）",
  probing: "探测中…",
  notFound: "未找到",
  synctexMissing: "本机没找到 synctex 命令",
  chktexMissing: "未安装（行内检查可选）",
  pandocMissing: "未安装",
  pandocTooOld: (version, min) => `${version} 太旧，需要 ${min} 或更新`,
  pandocReady: (version, path) => `${version} · ${path}`,
};

const probeOk = (latexmk = "/usr/local/bin/latexmk"): LatexProbeResult =>
  ({
    ok: true,
    latexmk,
    version: "Latexmk 4.8",
    engines: ["pdf"],
    source: "path",
    message: "",
    searched: [],
  }) as LatexProbeResult;

const envOf = (items: LatexEnvCheckResult["items"]): LatexEnvCheckResult => ({ items });

describe("envRowsOf —— 设置页自查清单的三行", () => {
  test("还在探测（probe / env 都是 null）：四行都写「探测中」，不是红的「没找到」", () => {
    const rows = envRowsOf({ probe: null, env: null }, TEXTS);
    assert.equal(rows.length, 4);
    for (const row of rows) assert.equal(row.detail, "探测中…");
    assert.equal(rows[0]?.ok, false);
  });

  test("都齐了：每行给路径；pandoc 给「版本 · 路径」", () => {
    const rows = envRowsOf(
      {
        probe: probeOk(),
        env: envOf([
          { id: "synctex", ok: true, path: "G:\\texlive\\2025\\bin\\windows\\synctex.exe" },
          { id: "chktex", ok: true, path: "G:\\texlive\\2025\\bin\\windows\\chktex.exe" },
          { id: "pandoc", ok: true, path: "C:\\app\\pandoc\\pandoc.exe", version: "3.12.1", minVersion: "3.10.2" },
        ]),
      },
      TEXTS,
    );
    assert.deepEqual(
      rows.map((row) => [row.id, row.ok]),
      [
        ["latexmk", true],
        ["synctex", true],
        ["chktex", true],
        ["pandoc", true],
      ],
    );
    assert.equal(rows[3]?.detail, "3.12.1 · C:\\app\\pandoc\\pandoc.exe");
  });

  test("pandoc 版本太低：说清「现在多少、要多少」，不把英文整段丢给中文界面", () => {
    const rows = envRowsOf(
      {
        probe: probeOk(),
        env: envOf([
          { id: "synctex", ok: true, path: "/opt/synctex" },
          { id: "chktex", ok: false, path: null },
          { id: "pandoc", ok: false, path: "C:\\app\\pandoc-3.9\\pandoc.exe", version: "3.9.0", minVersion: "3.10.2" },
        ]),
      },
      TEXTS,
    );
    assert.equal(rows[2]?.detail, "未安装（行内检查可选）");
    assert.equal(rows[3]?.detail, "3.9.0 太旧，需要 3.10.2 或更新");
  });

  test("pandoc 解析不出版本：按「未安装」说，不编一个版号", () => {
    const rows = envRowsOf(
      {
        probe: probeOk(),
        env: envOf([
          { id: "synctex", ok: false, path: null },
          { id: "chktex", ok: false, path: null },
          { id: "pandoc", ok: false, path: "/usr/bin/pandoc", version: null },
        ]),
      },
      TEXTS,
    );
    assert.equal(rows[1]?.detail, "本机没找到 synctex 命令");
    assert.equal(rows[3]?.detail, "未安装");
  });
});
