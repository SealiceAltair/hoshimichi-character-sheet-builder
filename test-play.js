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
    assert.equal(await page.locator('#profile-era').inputValue(), '992');
    assert.equal((await page.evaluate(() => window.characterSheetBuilder.getState())).profile.referenceYear, 992);
    await page.evaluate(() => {
      const state = window.characterSheetBuilder.getState();
      state.name = "試験PC";
      state.characterSetting = "慎重な旅人。本人の判断を待つ。";
      state.skills = [{ id: "test-skill", name: "試験技", description: "追加効果の全文を保持する", cost: 1 }];
      window.characterSheetBuilder.replaceState(state);
    });
    await page.locator('#profile-era').selectOption('unknown');
    assert.equal((await page.evaluate(() => window.characterSheetBuilder.getState())).profile.referenceYear, null);
    await page.locator('#profile-era').selectOption('custom');
    await page.locator('#profile-referenceYear').fill('986');
    assert.equal((await page.evaluate(() => window.characterSheetBuilder.getState())).profile.referenceYear, 986);
    await page.locator('#profile-era').selectOption('992');
    await page.locator("#profile-age").fill("22");
    await page.locator('#profile-gender-choice').selectOption('女性');
    const profileValues = {
      gender: "女性", species: "人族", appearance: "銀髪。右腰に剣。",
      personality: "慎重だが好奇心が強い", background: "辺境で育った職人",
      speech: "短く穏やかに話す", goals: "故郷に帰る旅費を集めたい"
    };
    for (const [key, value] of Object.entries(profileValues)) {
      if (key === 'gender') { continue; }
      await page.locator("#profile-" + key).fill(value);
    }
    await page.locator('#profile-gender-choice').selectOption('custom');
    await page.locator('#profile-gender').fill('性別を持たない');
    await page.reload();
    assert.equal(await page.locator('#profile-gender-choice').inputValue(), 'custom');
    assert.equal(await page.locator('#profile-gender').inputValue(), '性別を持たない');
    await page.locator('#profile-gender-choice').selectOption('女性');
    await page.locator('#profile-birthdayPeriod').selectOption('1');
    assert.equal(await page.locator('#profile-birthdayDay option').count(), 31);
    await page.locator('#profile-birthdayDay').selectOption('30');
    await page.locator('#profile-birthdayPeriod').selectOption('13');
    assert.equal(await page.locator('#profile-birthdayDay option').count(), 6);
    assert.equal(await page.locator('#profile-birthdayDay').inputValue(), '');
    await page.locator('#profile-birthdayDay').selectOption('5');
    assert((await page.locator('#profile-identity').textContent()).includes('出生年：未確定'));
    await page.locator('#profile-birthdayStatus').selectOption('before');
    assert((await page.locator('#profile-identity').textContent()).includes('出生年：星歴969年'));
    await page.locator('#profile-birthdayStatus').selectOption('after');
    assert((await page.locator('#profile-identity').textContent()).includes('出生年：星歴970年'));
    await page.locator('#profile-era').selectOption('custom');
    await page.locator('#profile-referenceYear').fill('993');
    assert.equal(await page.locator('#profile-birthdayStatus').inputValue(), 'unknown');
    assert.equal(await page.locator('#profile-age').inputValue(), '22');
    await page.locator('#profile-era').selectOption('992');
    await page.locator('#profile-birthdayStatus').selectOption('before');
    const profileCheck = await page.evaluate(() => {
      const api = window.characterSheetBuilder;
      const state = api.getState();
      const markdown = api.buildPlayerMarkdown();
      const full = api.parseMarkdownState(markdown).state;
      const plain = api.parseMarkdownState(markdown.replace(/<!-- HOSHIMICHI-PC-V12:[\s\S]*?-->/, "")).state;
      const kp = api.parseMarkdownState(api.buildKpMarkdown()).state;
      const old = JSON.parse(JSON.stringify(state)); old.version = 11; delete old.profile;
      const migrated = api.exportPlaySnapshot(old).state;
      const invalid = JSON.parse(JSON.stringify(state));
      invalid.profile = { referenceYear: true, age: -1 };
      const invalidResult = api.exportPlaySnapshot(invalid).state.profile;
      const zero = JSON.parse(JSON.stringify(state)); zero.profile = { referenceYear: 0, age: 0 };
      const fixtures = [
        { referenceYear: 992, age: 0, birthdayStatus: 'before' },
        { referenceYear: 992, age: 0, birthdayStatus: 'after' },
        { referenceYear: 992, age: null, birthdayStatus: 'after' },
        { referenceYear: null, age: 22, birthdayStatus: 'after' },
        { referenceYear: 0, age: 100, birthdayStatus: 'after' }
      ].map(profile => api.exportPlaySnapshot({ ...state, profile }).markdown);
      const badDay = api.exportPlaySnapshot({ ...state, profile: { birthdayPeriod: 13, birthdayDay: 6 } }).state.profile;
      const oldPlain = api.parseMarkdownState(markdown.replace(/<!-- HOSHIMICHI-PC-V12:[\s\S]*?-->/, '')
        .replace(/^(基準年|年齢|誕生日|基準年の誕生日|出生年（年齢から算出）)：.*\n/gm, '')).state;
      return { state, full, plain, kp, migrated, invalidResult, zero: api.exportPlaySnapshot(zero).state,
        cloud: api.getCloudState(), summary: api.buildCharacterSummary(), fixtures, badDay, oldPlain };
    });
    assert.equal(profileCheck.state.version, 12);
    for (const state of [profileCheck.full, profileCheck.plain, profileCheck.kp, profileCheck.cloud]) {
      assert.deepEqual(state.profile, profileCheck.state.profile);
      assert.equal(state.characterSetting, profileCheck.state.characterSetting);
    }
    assert.equal(profileCheck.migrated.characterSetting, profileCheck.state.characterSetting);
    assert.equal(profileCheck.migrated.profile.age, null);
    assert.equal(profileCheck.migrated.profile.referenceYear, null);
    assert.equal(profileCheck.invalidResult.age, null);
    assert.equal(profileCheck.invalidResult.referenceYear, null);
    assert.equal(profileCheck.zero.profile.age, 0);
    assert.equal(profileCheck.zero.profile.referenceYear, 0);
    assert.equal(profileCheck.state.profile.birthdayPeriod, 13);
    assert.equal(profileCheck.state.profile.birthdayDay, 5);
    assert.equal(profileCheck.state.profile.birthdayStatus, 'before');
    assert.equal(profileCheck.oldPlain.profile.referenceYear, null);
    assert.equal(profileCheck.oldPlain.profile.age, null);
    assert.equal(profileCheck.badDay.birthdayDay, null);
    ['星歴991年', '星歴992年', '未確定', '未確定', '星歴以前（年表記未定）'].forEach((label, index) => {
      assert(profileCheck.fixtures[index].includes('出生年（年齢から算出）：' + label));
    });
    assert(profileCheck.summary.includes("星歴992年時点 / 22歳"));
    await page.reload();
    assert.equal(await page.locator("#profile-referenceYear").inputValue(), "992");
    assert.equal(await page.locator('#profile-era').inputValue(), '992');
    assert.equal(await page.locator('#profile-birthdayDay').inputValue(), '5');
    assert.equal(await page.locator('#profile-birthdayStatus').inputValue(), 'before');
    assert.equal(await page.locator("#profile-goals").inputValue(), profileValues.goals);
    if (process.env.TEST_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.TEST_ARTIFACT_DIR, { recursive: true });
      for (const width of [1365, 390]) {
        await page.setViewportSize({ width, height: 950 });
        await page.evaluate(() => {
          const section = document.querySelector('[aria-labelledby="character-setting-heading"]');
          const offset = document.querySelector('.points-panel').getBoundingClientRect().height + 24;
          window.scrollTo({ top: section.getBoundingClientRect().top + window.scrollY - offset, behavior: 'instant' });
        });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
        await page.evaluate(() => {
          const year = document.getElementById('profile-era').getBoundingClientRect();
          if (document.elementFromPoint(year.x + 10, year.y + 10).id !== 'profile-era') {
            throw new Error('Profile year is obscured');
          }
        });
        await page.screenshot({
          path: path.join(process.env.TEST_ARTIFACT_DIR, "profile-" + width + ".png")
        });
      }
      await page.setViewportSize({ width: 1365, height: 1000 });
    }
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
    assert.deepEqual(catalog.slice(1), ["銅色の初仕事 ｜ 推奨CP：未設定 ｜ 未定", "森に満ちる足音 ｜ 推奨CP：4 ｜ 星歴992年", "約束の続きを探して ｜ 推奨CP：未設定 ｜ 未定"]);
    await page.locator("#play-scenario-catalog").selectOption("SCN-0002");
    await page.locator("#play-difficulty").selectOption("challenge");
    await page.locator('[data-play-tag="雰囲気"]').first().check();
    let catalogText = await page.locator("#play-request-preview").inputValue();
    assert(catalogText.includes("作中年（正本）：星歴992年"));
    assert(catalogText.includes("試験PC：星歴992年時点 / 22歳"));
    assert((await page.locator("#play-roster").textContent()).includes("星歴992年時点 / 22歳"));
    await page.locator("#play-year-mode").selectOption("custom");
    await page.locator("#play-year").fill("986");
    const differentYear = await page.locator("#play-request-preview").inputValue();
    assert(differentYear.includes("年代相違："));
    assert(differentYear.includes("年代要確認：試験PC"));
    assert.equal((await page.evaluate(() => window.characterSheetBuilder.getState())).profile.age, 22);
    await page.locator("#play-year").fill("");
    assert((await page.locator("#play-request-preview").inputValue()).includes("作中年（希望）：未定"));
    await page.locator("#play-year-mode").selectOption("canon");
    await page.locator("#play-scenario-method").selectOption("new");
    assert((await page.locator("#play-request-preview").inputValue()).includes("作中年（正本）：未定"));
    await page.locator("#play-scenario-method").selectOption("existing");
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
