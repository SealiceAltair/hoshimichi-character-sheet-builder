"use strict";

// All cloud requests are intercepted. Never writes to the shared warehouse.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.TEST_BROWSER_CHANNEL || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 950 } });
    const errors = [];
    const records = {};
    let held = null;
    let failId = null;
    let posts = 0;
    page.on("pageerror", e => errors.push(e.message));
    await page.route("https://script.google.com/**", async route => {
      const request = route.request();
      const url = new URL(request.url());
      const action = url.searchParams.get("action");
      const id = url.searchParams.get("id");
      if (held && action === "get" && id === "private") { await held; }
      let response;
      if (request.method() === "POST") {
        posts++;
        const body = JSON.parse(new URLSearchParams(request.postData()).get("payload"));
        const record = records[body.characterId];
        record.state = body.state; record.revision++;
        response = { ok: true, data: { character: record } };
      } else if (failId && id === failId) {
        response = { ok: false, error: { message: "offline" } };
      } else if (action === "list") {
        response = { ok: true, data: { characters: Object.values(records).map(({ state, ...summary }) => summary) } };
      } else {
        response = { ok: true, data: { character: records[id] } };
      }
      await route.fulfill({ json: response, headers: { "access-control-allow-origin": "*" } });
    });
    await page.goto(pathToFileURL(path.join(__dirname, "index.html")).href);
    const base = await page.evaluate(() => window.characterSheetBuilder.getState());
    records.public = { id: "public", name: "公開テスト", revision: 1, state: { ...base, name: "公開テスト" } };
    records.private = { id: "private", name: "管理テスト", revision: 1,
      state: { ...base, name: "管理テスト", visibility: "manager", characterSetting: "帝国の未公開設定" } };
    const refresh = () => page.evaluate(() => window.hoshimichiCloudLibrary.refresh(true));
    const unlock = () => page.evaluate(() => window.characterSheetBuilder.tryEnterKpMode("ばに"));
    const lock = () => page.evaluate(() => window.characterSheetBuilder.exitKpMode());
    await page.locator("#library-tab").click(); await refresh();
    await page.waitForFunction(() => document.querySelectorAll(".cloud-character-card").length === 1);
    assert(!(await page.locator("body").innerText()).includes("管理テスト"));
    assert.deepEqual(await page.evaluate(async () => (await window.hoshimichiCloudLibrary.listForPlay()).map(x => x.id)), ["public"]);
    assert.equal(await page.evaluate(async () => {
      try { await window.hoshimichiCloudLibrary.getForPlay("private"); return "LEAK"; } catch (e) { return e.code; }
    }), "MANAGER_LOCKED");
    assert.equal(await unlock(), true);
    assert.equal(await page.locator(".cloud-character-card").count(), 2);
    await page.locator("#library-scope").selectOption("manager");
    assert.equal(await page.locator(".cloud-character-card").count(), 1);
    await page.getByRole("button", { name: "「管理テスト」を編集する", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("character-name").value === "管理テスト");
    let confirmation = "";
    page.once("dialog", async dialog => { confirmation = dialog.message(); await dialog.dismiss(); });
    await page.locator("#character-visibility").selectOption("public");
    assert(confirmation.includes("公開一覧"));
    assert.equal(await page.locator("#character-visibility").inputValue(), "manager");
    await page.locator("#play-tab").click();
    assert((await page.locator("#play-request-preview").inputValue()).includes("管理テスト"));
    await lock();
    assert.equal(await page.locator("#character-name").inputValue(), "");
    assert(!(await page.locator("#play-request-preview").inputValue()).includes("管理テスト"));
    assert(!(await page.locator("body").innerText()).includes("帝国の未公開設定"));
    await unlock();
    await page.evaluate(record => window.characterSheetBuilder.replaceState(record.state), records.private);
    await page.reload();
    assert.equal(await page.locator("#character-name").inputValue(), "");
    assert.equal(await page.evaluate(() => window.characterSheetBuilder.isKpMode()), false);
    await page.locator("#library-tab").click(); await refresh();
    assert(!(await page.locator("#local-backup-list").innerText()).includes("管理テスト"));
    await unlock();
    assert((await page.locator("#local-backup-list").innerText()).includes("管理テスト"));
    await page.locator("#play-tab").click();
    await page.locator("#play-load-library").click();
    await page.waitForFunction(() => document.querySelectorAll("#play-library-options input").length === 2);
    let release;
    held = new Promise(resolve => { release = resolve; });
    await page.locator("#play-library-options label").filter({ hasText: "管理テスト" }).locator("input").check();
    await lock(); release(); held = null;
    await page.waitForTimeout(100);
    assert(!(await page.locator("#play-roster").innerText()).includes("管理テスト"));
    assert(!(await page.locator("#play-library-options").innerText()).includes("管理テスト"));
    // A newly changed record is classified again; errors never fall back to public.
    records.public.revision++; records.public.state.visibility = "manager"; failId = "public";
    await refresh();
    assert.equal(await page.locator(".cloud-character-card").count(), 0);
    failId = null;
    await unlock(); await refresh();
    await page.locator("#library-tab").click();
    await page.getByRole("button", { name: "「管理テスト」を編集する", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("character-name").value === "管理テスト");
    page.once("dialog", dialog => dialog.accept());
    await page.locator("#character-visibility").selectOption("public");
    await page.locator("#save-character-cloud").click();
    await page.waitForFunction(() => document.getElementById("cloud-save-status").textContent.includes("保存しました"));
    assert.equal(records.private.state.visibility, "public"); assert.equal(posts, 1);
    await lock(); await page.locator("#library-tab").click();
    assert.equal(await page.locator(".cloud-character-card").count(), 1);
    // Mobile / desktop layout and screenshots.
    if (process.env.TEST_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.TEST_ARTIFACT_DIR, { recursive: true });
      for (const width of [1365, 390]) {
        await page.setViewportSize({ width, height: 950 });
        for (const open of [false, true]) {
          if (open) { await unlock(); } else { await lock(); }
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
          await page.screenshot({ path: path.join(process.env.TEST_ARTIFACT_DIR, `manager-${width}-${open ? "open" : "locked"}.png`) });
        }
      }
    }
    assert.deepEqual(errors, []);
    console.log("Manager view lock: PASS (classification, scopes, confirmation, reload, backups, participants, races, responsive layout)");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
