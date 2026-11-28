import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { computerUseUiTexts } from "../../shared/computer-use-texts.ts";
import { cuLanguage, cuTexts, resetComputerUseUiLanguageForTests, setComputerUseUiLanguage } from "./ui-language.ts";

/**
 * 主进程那份「现在用哪种语言」的开关（2026-11-28）。
 *
 * 守的是三件事：设置里写 `zh` 用中文、写 `en`（或缺省 / 脏数据）用英文、以及**没接线时**
 * 维持改动前的中文原文（那一格是给单测与旧调用点的，不是生产状态）。
 */
describe("电脑使用界面语言：主进程侧的开关", () => {
  beforeEach(() => resetComputerUseUiLanguageForTests());

  test("缺省（没接线）是中文：改动前的原文，老测试与旧调用点不变", () => {
    assert.equal(cuLanguage(), "zh");
    assert.equal(cuTexts().sandboxAlreadyRunning, computerUseUiTexts("zh").sandboxAlreadyRunning);
  });

  test("设置写 zh → 中文；写 en → 英文", () => {
    setComputerUseUiLanguage("zh");
    assert.equal(cuTexts().sandboxAlreadyRunning, "沙箱已经在运行");
    setComputerUseUiLanguage("en");
    assert.equal(cuTexts().sandboxAlreadyRunning, "The sandbox is already running");
    assert.equal(cuLanguage(), "en");
  });

  test("脏数据 / 缺省按英文（与 effectiveLanguage 的兜底一致）", () => {
    setComputerUseUiLanguage(undefined);
    assert.equal(cuLanguage(), "en");
    setComputerUseUiLanguage("fr");
    assert.equal(cuLanguage(), "en");
    setComputerUseUiLanguage("");
    assert.equal(cuLanguage(), "en");
  });

  test("每次现取：切了语言下一条回执就跟上（不缓存整份表）", () => {
    setComputerUseUiLanguage("en");
    const first = cuTexts();
    setComputerUseUiLanguage("zh");
    const second = cuTexts();
    assert.notEqual(first, second);
    assert.match(second.sandboxAlreadyRunning, /[\u4e00-\u9fff]/);
  });
});
