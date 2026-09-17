"use strict";

// Requires Playwright. Cloud calls are intercepted; no shared records are changed.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.TEST_BROWSER_CHANNEL || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 1000 } });
    const errors = [];
    const calls = [];
    const records = {};
    let failGet = false;
    let holdGet = null;
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://script.google.com/**", async route => {
      const url = new URL(route.request().url());
      const action = url.searchParams.get("action");
      calls.push({ action, method: route.request().method() });
      if (holdGet && action === "get") { await holdGet; }
      const response = failGet && action === "get"
        ? { ok: false, error: { message: "test offline" } }
        : { ok: true, data: action === "list" ? { characters: Object.values(records) }
          : { character: records[url.searchParams.get("id")] } };
      await route.fulfill({ json: response, headers: { "access-control-allow-origin": "*" } });
    });
    await page.goto(pathToFileURL(path.join(__dirname, "index.html")).href);
    await page.evaluate(() => {
      const state = window.characterSheetBuilder.getState();
      state.name = "試験PC";
      state.characterSetting = "慎重な旅人。本人の判断を待つ。";
      state.skills = [{ id: "test-skill", name: "試験技", description: "追加効果の全文を保持する", cost: 1 }];
      window.characterSheetBuilder.replaceState(state);
    });
    const original = await page.evaluate(() => window.characterSheetBuilder.getState());
    for (let i = 1; i <= 4; i++) {
      const state = JSON.parse(JSON.stringify(original));
      state.name = i === 4 ? "同行獣" : "保存PC" + i;
      state.targetType = i === 4 ? "monster" : "character";
      state.characterSetting = "保存人物設定" + i;
      records["test-" + i] = { id: "test-" + i, name: state.name, state, revision: 2 };
    }
    const snapshot = await page.evaluate(source => {
      const before = JSON.stringify(window.characterSheetBuilder.getState());
      const saved = localStorage.getItem("hoshimichi-character-sheet-builder");
      const result = window.characterSheetBuilder.exportPlaySnapshot(source);
      let caught = false;
      try { window.characterSheetBuilder.exportPlaySnapshot({ version: -1 }); } catch (_) { caught = true; }
      return { result, caught, unchanged: before === JSON.stringify(window.characterSheetBuilder.getState()),
        savedUnchanged: saved === localStorage.getItem("hoshimichi-character-sheet-builder") };
    }, records["test-4"].state);
    assert(snapshot.unchanged && snapshot.savedUnchanged && snapshot.caught);
    assert.equal(snapshot.result.state.targetType, "monster");
    assert(!("kpSettings" in snapshot.result.state));
    assert(!("thumbnailDataUrl" in snapshot.result.state));

    await page.locator("#play-tab").click();
    assert.equal(await page.locator("[data-play-tag]").count(), 44);
    const catalog = await page.locator("#play-scenario-catalog option").allTextContents();
    assert.deepEqual(catalog.slice(1), ["銅色の初仕事 ｜ 推奨CP：未設定", "森に満ちる足音 ｜ 推奨CP：4", "約束の続きを探して ｜ 推奨CP：未設定"]);
    await page.locator("#play-scenario-catalog").selectOption("SCN-0002");
    await page.locator("#play-difficulty").selectOption("challenge");
    await page.locator('[data-play-tag="雰囲気"]').first().check();
    let catalogText = await page.locator("#play-request-preview").inputValue();
    assert(catalogText.includes("canon/game_rules/SCN-0002_森に満ちる足音.md / F-000098"));
    assert(catalogText.includes("推奨CP（1人あたり）：4"));
    assert(catalogText.includes("ユーザーPC 4名 / AI代理PC 1名"));
    assert(catalogText.includes("難易度の希望（仮）：挑戦"));
    assert(catalogText.includes("今回の卓だけ調整してよい"));
    assert(catalogText.includes("元の正本は変更せず"));
    assert(catalogText.includes("すべて同じ重み"));
    assert(catalogText.includes("雰囲気：明るい雰囲気"));
    assert(!(await page.locator("#play-scenario").isVisible()));
    await page.reload();
    await page.locator("#play-tab").click();
    assert.equal(await page.locator("#play-difficulty").inputValue(), "challenge");
    assert.equal(await page.locator("#play-scenario-catalog").inputValue(), "SCN-0002");
    assert(await page.locator('[data-play-tag="雰囲気"]').first().isChecked());
    await page.locator("#play-scenario-catalog").selectOption("SCN-0001");
    assert((await page.locator("#play-request-preview").inputValue()).includes("推奨CP（1人あたり）：未設定。推測で補わない。"));
    await page.locator("#play-scenario-catalog").selectOption("custom");
    await page.locator("#play-scenario").fill("SCN-0002 森に満ちる足音");
    await page.locator("#play-load-library").click();
    await page.waitForFunction(() => document.querySelectorAll("#play-library-options input").length === 4);
    for (let i = 0; i < 4; i++) {
      await page.locator("#play-library-options input").nth(i).check();
      await page.waitForFunction(() => !document.getElementById("copy-play-request").disabled);
    }
    assert.equal(await page.locator("#play-roster select").count(), 5);
    await page.locator("#play-roster select").nth(4).selectOption("npc");
    let text = await page.locator("#play-request-preview").inputValue();
    assert(text.startsWith("/シナリオ準備"));
    for (const keyword of ["SCN-0002", "WORKSET.json", "BOOTSTRAP.json", "start_from_workset",
      "CODEX_DESKTOP_STANDARD", "追加効果の全文を保持する", "保存人物設定4", "同行NPC",
      "固定fixtureのPASSだけで実卓のREADYとしない", "開始合図", "C-1からC-5"]) {
      assert(text.includes(keyword), keyword);
    }
    assert.equal((text.match(/### 参加者 /g) || []).length, 5);
    assert(!text.includes('"kpSettings"'));
    assert.deepEqual(await page.evaluate(() => window.characterSheetBuilder.getState()), original);
    const gets = calls.filter(x => x.action === "get").length;
    await page.locator("#play-wish").fill("探索と会話");
    assert.equal(calls.filter(x => x.action === "get").length, gets);

    await page.locator("#play-ai").selectOption("claude-code");
    assert((await page.locator("#play-request-preview").inputValue()).includes(".claude/runtime/TRPG-NNNN/"));
    await page.locator("#play-environment").selectOption("mobile");
    await page.locator("#play-ai").selectOption("claude");
    text = await page.locator("#play-request-preview").inputValue();
    assert(text.includes("SMARTPHONE_CLAUDE_COMPACT"));
    assert(text.includes("すべてのダイスを実行ツールの乱数で代行"));
    assert(text.includes("卓中の画像生成・画像ワーカーは使わず"));
    await page.locator("#play-ai").selectOption("chatgpt");
    assert((await page.locator("#play-request-preview").inputValue()).includes("未確認のIDを創作しない"));
    await page.locator("#play-environment").selectOption("desktop");
    await page.locator("#play-scenario-method").selectOption("suggest");
    assert((await page.locator("#play-request-preview").inputValue()).startsWith("/相談"));
    await page.locator('[name="play-mode"][value="rp"]').check();
    text = await page.locator("#play-request-preview").inputValue();
    assert(text.includes("準備後は本編を描写せず"));
    assert(!text.includes("start_from_workset"));
    assert(text.includes("雰囲気：明るい雰囲気"));
    assert(!text.includes("難易度の希望（仮）："));
    assert(!text.includes("推奨CP（1人あたり）"));
    await page.locator('[name="play-mode"][value="trpg"]').check();
    await page.locator("#play-scenario-method").selectOption("existing");

    failGet = true;
    await page.locator("#refresh-play-request").click();
    await page.waitForFunction(() => document.querySelector("#play-roster").textContent.includes("取得エラー"));
    assert(await page.locator("#copy-play-request").isDisabled());
    assert.equal(await page.locator("#play-request-preview").inputValue(), "");
    failGet = false;
    await page.locator("#refresh-play-request").click();
    await page.waitForFunction(() => !document.getElementById("copy-play-request").disabled);

    // Removing a pending participant must not allow the late result to re-add it.
    let release;
    holdGet = new Promise(resolve => { release = resolve; });
    await page.locator("#refresh-play-request").click();
    await page.locator("#play-roster button").last().click();
    release(); holdGet = null;
    await page.waitForFunction(() => !document.getElementById("copy-play-request").disabled);
    assert.equal(await page.locator("#play-roster select").count(), 4);

    await page.reload();
    await page.locator("#play-tab").click();
    await page.waitForFunction(() => !document.getElementById("copy-play-request").disabled);
    assert.equal(await page.locator("#play-roster select").count(), 4);
    assert.equal(await page.locator("#play-scenario").inputValue(), "SCN-0002 森に満ちる足音");

    // A new page/context carrying the current cloud ID must catch duplicate selection.
    await page.evaluate(() => localStorage.setItem("hoshimichi-character-sheet-builder-cloud-context-v1",
      JSON.stringify({ characterId: "test-1", revision: 2 })));
    await page.reload();
    await page.locator("#play-tab").click();
    await page.waitForFunction(() => document.getElementById("play-character-warning").textContent.includes("重複"));
    assert(await page.locator("#copy-play-request").isDisabled());
    await page.locator("#play-use-current").uncheck();
    await page.waitForFunction(() => !document.getElementById("copy-play-request").disabled);

    // Names/settings are plain text, not HTML.
    await page.locator("#play-wish").fill('<img src=x onerror="alert(1)">');
    assert.equal(await page.locator("#play-panel img").count(), 0);
    await page.locator("#play-wish").fill("探索と会話");
    // Clipboard success and manual fallback both use the complete visible request.
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText: async text => { window.testCopiedText = text; } }
    }));
    await page.locator("#copy-play-request").click();
    assert.equal(await page.evaluate(() => window.testCopiedText), await page.locator("#play-request-preview").inputValue());
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText: async () => { throw new Error("denied"); } }
    }));
    await page.locator("#copy-play-request").click();
    assert(await page.locator("#manual-copy-dialog").isVisible());
    assert.equal(await page.locator("#manual-copy-text").inputValue(), await page.locator("#play-request-preview").inputValue());
    await page.locator("#close-copy-dialog").click();
    if (process.env.TEST_ARTIFACT_DIR) {
      await page.locator("#play-scenario-catalog").selectOption("SCN-0003");
      fs.mkdirSync(process.env.TEST_ARTIFACT_DIR, { recursive: true });
      for (const width of [1365, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.locator("#play-panel").scrollIntoViewIfNeeded();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "Horizontal overflow");
        await page.screenshot({ path: path.join(process.env.TEST_ARTIFACT_DIR, "play-" + width + ".png"), fullPage: true });
      }
    }
    // Consultation may be character-free; gameplay must not silently start with an empty roster.
    while (await page.locator("#play-roster button").count()) {
      await page.locator("#play-roster button").first().click();
    }
    assert(await page.locator("#copy-play-request").isDisabled());
    await page.locator('[name="play-mode"][value="consult"]').check();
    assert(!(await page.locator("#copy-play-request").isDisabled()));
    assert((await page.locator("#play-request-preview").inputValue()).includes("本編や起動処理へ自動移行しない"));
    assert(calls.every(x => x.method === "GET" && ["get", "list"].includes(x.action)));
    assert.deepEqual(errors, []);
    console.log("Scenario/RP preparation: PASS (multi-party, profiles, gating, read-only export, errors, races, persistence, responsive UI)");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
