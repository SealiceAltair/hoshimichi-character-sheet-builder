"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.TEST_BROWSER_CHANNEL || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true, hasTouch: true });
    const errors = [], calls = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.route("https://script.google.com/**", route => { calls.push(route.request().method()); return route.fulfill({ json: { ok: true, data: { characters: [] } } }); });
    await page.goto(pathToFileURL(path.join(__dirname, "index.html")).href);
    await page.evaluate(() => {
      const C = window.HoshimichiAuthoringCore;
      localStorage.setItem("hoshimichi-authoring-drafts-v1", JSON.stringify({ version: 1, maps: [C.newMap("legacy-grid-test")], scenarios: [C.newScenario("legacy-scenario-test")] }));
    });
    const initialCharacter = await page.evaluate(() => JSON.stringify(window.characterSheetBuilder.getState()));
    const drafts = () => page.evaluate(() => window.hoshimichiAuthoring.getDrafts());
    const unlock = () => page.evaluate(() => window.characterSheetBuilder.tryEnterKpMode("ばに"));
    const lock = () => page.evaluate(() => window.characterSheetBuilder.exitKpMode());
    assert.equal(await page.locator("#map-tab").isVisible(), false);
    assert.equal(await page.locator("#scenario-tab").isVisible(), false);
    await page.evaluate(() => window.hoshimichiNavigation.activateTab("map", false));
    assert.equal(await page.locator("#map-panel").isVisible(), false);
    await unlock(); await page.locator("#map-tab").click();
    await page.locator("#map-name").fill("廃坑への道");
    async function coordinate(x, y) {
      await page.locator("#map-canvas").scrollIntoViewIfNeeded();
      const box = await page.locator("#map-canvas").boundingBox();
      return [box.x + (x + .5) * box.width / 24, box.y + (y + .5) * box.height / 16];
    }
    async function drag(a, b) {
      const from = await coordinate(...a), to = await coordinate(...b);
      await page.mouse.move(...from); await page.mouse.down(); await page.mouse.move(...to, { steps: 8 }); await page.mouse.up();
    }
    async function clickCell(x, y) { await page.mouse.click(...await coordinate(x, y)); }
    await page.locator('[name="map-tool"][value="room"]').check(); await drag([2, 2], [9, 8]);
    let state = await drafts(); assert.equal(state.maps[0].cells[3 * 24 + 3], 1); assert.equal(state.maps[0].cells[2 * 24 + 2], 2);
    await page.locator("#map-undo").click(); assert.equal((await drafts()).maps[0].cells[2 * 24 + 2], 0);
    await page.locator("#map-redo").click(); assert.equal((await drafts()).maps[0].cells[2 * 24 + 2], 2);
    await page.locator('[name="map-tool"][value="brush"]').check();
    await page.locator('[name="map-tile"][value="3"]').check(); await drag([9, 7], [17, 7]);
    await page.locator('[name="map-tool"][value="point"]').check(); await clickCell(4, 4);
    await page.locator("#map-point-name").fill("坑道入口"); await page.locator("#map-point-contents").fill("壊れた荷車と古い看板");
    await clickCell(17, 7); await page.locator("#map-point-name").fill("沢沿いの道");
    await page.locator("#map-point-possibleEnemies").fill("獣が潜んでいるかもしれない");
    await page.locator("#map-point-events").fill("増水、落石、旅人との遭遇");
    await page.locator("#map-point-conditions").fill("雨の翌日は増水の可能性。確率は未定。");
    await page.locator("#map-point-x").fill("19");
    await page.getByRole("button", { name: "地点を移動", exact: true }).click();
    assert.equal((await drafts()).maps[0].points[1].x, 18);
    await page.getByRole("button", { name: "ルート追加", exact: true }).click();
    await page.locator("#map-route-distance").fill("約1km"); await page.locator("#map-route-time").fill("20〜40分"); await page.locator("#map-route-roughness").fill("足場の悪い急坂");
    state = await drafts(); assert.equal(state.maps[0].points.length, 2); assert.equal(state.maps[0].routes.length, 1);
    const mapRequest = await page.locator("#map-output").inputValue();
    for (const text of ["約1km", "20〜40分", "候補", "増水"]) { assert(mapRequest.includes(text)); }
    // Private data never survives a relock in DOM or a delayed import.
    await lock();
    assert.equal(await page.locator("#map-panel").innerHTML(), ""); assert.equal(await drafts(), null);
    assert(!(await page.locator("body").innerText()).includes("沢沿いの道"));
    await page.reload(); assert.equal(await page.locator("#map-tab").isVisible(), false);
    await unlock(); await page.locator("#map-tab").click();
    assert.equal((await drafts()).maps[0].routes[0].time, "20〜40分");
    const countBeforeDelay = (await drafts()).maps.length;
    await page.evaluate(() => {
      const data = JSON.stringify({ schema: "hoshimichi.authoring/1", ...window.hoshimichiAuthoring.getDrafts() });
      window.delayedAuthoringImport = window.hoshimichiAuthoring.importFile({ size: data.length, text: () => new Promise(resolve => { window.releaseAuthoringImport = () => resolve(data); }) });
    });
    await lock(); await page.evaluate(async () => { window.releaseAuthoringImport(); await window.delayedAuthoringImport; });
    await unlock(); await page.locator("#map-tab").click();
    assert.equal((await drafts()).maps.length, countBeforeDelay);
    // Terrain PNG contains no route or point overlays; both exports contain real colored pixels.
    const artifactDir = process.env.TEST_ARTIFACT_DIR;
    if (artifactDir) { fs.mkdirSync(artifactDir, { recursive: true }); }
    for (const [label, file] of [["PNG（地形のみ）", "map-terrain.png"], ["PNG（KP用）", "map-kp.png"]]) {
      const received = page.waitForEvent("download"); await page.getByRole("button", { name: label, exact: true }).click();
      const download = await received; if (artifactDir) { await download.saveAs(path.join(artifactDir, file)); }
      assert((await download.suggestedFilename()).endsWith(".png"));
    }
    assert(await page.evaluate(() => {
      const canvas = document.getElementById("map-canvas"), data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      const colors = new Set(); for (let i = 0; i < data.length; i += 400) { colors.add(data.slice(i, i + 3).join(",")); } return colors.size > 8;
    }));
    await page.locator("#scenario-tab").click(); await page.locator("#scenario-name").fill("谷を越えて");
    await page.locator("#scenario-place").fill("中継都市近郊（位置は要確認）");
    await page.locator("#scenario-summary").fill("廃坑へ物資を届ける依頼。");
    await page.locator("#scenario-secrets").fill("秘密の抜け道。採用は未確定。");
    await page.locator('[data-scenario-tag][value="戦わずに解決"]').check();
    await page.locator('[data-scenario-map]').first().check();
    let output = await page.locator("#scenario-output").inputValue();
    for (const phrase of ["谷を越えて", "秘密の抜け道", "戦わずに解決", "廃坑への道", "20〜40分", "ここでは採番しない"]) { assert(output.includes(phrase), phrase); }
    const current = await drafts(), exported = { schema: "hoshimichi.authoring/1", ...current };
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#scenario-panel").getByRole("button", { name: "下書きJSONを出力", exact: true }).click();
    const download = await downloadPromise;
    const json = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
    assert.deepEqual(json.maps, current.maps); assert.deepEqual(json.scenarios[0], current.scenarios[0]);
    page.once("dialog", dialog => dialog.accept());
    await page.locator("#scenario-import").setInputFiles({ name: "draft.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(exported)) });
    await page.waitForFunction(() => window.hoshimichiAuthoring.getDrafts().scenarios.length === 2);
    const afterImport = await drafts(); assert.equal(afterImport.maps.length, 2);
    assert.notEqual(afterImport.maps[0].id, afterImport.maps[1].id); assert.equal(afterImport.scenarios[1].mapIds[0], afterImport.maps[1].id);
    await page.locator("#scenario-import").setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from('{"schema":"wrong"}') });
    await page.waitForFunction(() => document.querySelector("#scenario-panel .authoring-status").textContent.includes("読込できません"));
    assert.equal((await drafts()).scenarios.length, 2);
    // A different tab's latest data must not be silently overwritten.
    await page.evaluate(() => { const key = window.hoshimichiAuthoring.storageKey; const value = JSON.parse(localStorage.getItem(key)); value.maps[0].name = "別タブの変更"; localStorage.setItem(key, JSON.stringify(value)); });
    await page.locator("#scenario-name").fill("未保存の作業");
    assert((await page.locator("#scenario-panel .authoring-status").textContent()).includes("別タブ"));
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem(window.hoshimichiAuthoring.storageKey)).maps[0].name), "別タブの変更");
    if (artifactDir) {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1050 });
        for (const tab of ["map", "scenario"]) {
          await page.locator("#" + tab + "-tab").click();
          if (width === 390 && tab === "map") {
            await page.locator('[name="map-tool"][value="point"]').check();
            await page.locator("#map-viewport").scrollIntoViewIfNeeded();
            await page.evaluate(() => { document.getElementById("map-viewport").scrollLeft = 0; document.getElementById("map-viewport").scrollTop = 0; });
            const canvas = await page.locator("#map-canvas").boundingBox();
            const pageMapId = await page.locator("#map-drafts").inputValue();
            const beforeTouch = (await drafts()).maps.find(m => m.id === pageMapId).points.length;
            await page.touchscreen.tap(canvas.x + 42, canvas.y + 42);
            assert.equal((await drafts()).maps.find(m => m.id === pageMapId).points.length, beforeTouch + 1);
          }
          await page.locator("#" + tab + "-panel").scrollIntoViewIfNeeded();
          await page.evaluate(id => { const p = document.getElementById(id); window.scrollTo({ top: p.offsetTop - 20, behavior: "instant" }); }, tab + "-panel");
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
          await page.screenshot({ path: path.join(artifactDir, tab + "-" + width + ".png") });
        }
      }
    }
    // Existing builder values and warehouse records remain untouched.
    assert.equal(await page.evaluate(() => JSON.stringify(window.characterSheetBuilder.getState())), initialCharacter);
    assert(!calls.includes("POST"));
    await lock(); assert.equal(await page.locator("#scenario-panel").innerHTML(), "");
    assert(!(await page.locator("body").innerText()).includes("秘密の抜け道"));
    assert.deepEqual(errors, []);
    console.log("Authoring browser: PASS (gated tabs, grid editing, metadata, undo, persistence, route candidates, scenario wishes, JSON/PNG export/import, conflict protection, layout)");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
