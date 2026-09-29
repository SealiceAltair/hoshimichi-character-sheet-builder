"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.TEST_BROWSER_CHANNEL || undefined
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 950 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(pathToFileURL(path.join(__dirname, "index.html")).href);

    assert.equal(await page.locator("#ai-consult-panel").count(), 1);
    assert.equal(await page.locator("#copy-ai-consult-bottom").count(), 1);

    const packet = await page.evaluate(() =>
      window.characterSheetBuilder.buildAiConsultationPacket()
    );
    assert(packet.includes("公開リポジトリ：https://github.com/SealiceAltair/hoshimichi-character-sheet-builder"));
    assert(packet.includes("RULES.md"));
    assert(packet.includes("consultationFeedback"));

    const idMatch = packet.match(/相談ID：(CC-[A-Z0-9_-]+)/);
    assert(idMatch, "consultation id must exist in prompt");
    const consultationId = idMatch[1];

    const state = await page.evaluate(() => window.characterSheetBuilder.getState());
    const character = {
      name: "AIテスト",
      build: Number(state.build),
      profile: state.profile,
      baseStats: { ...state.baseStats, skill: 2 },
      potentialStats: state.potentialStats,
      practicalSkills: state.practicalSkills,
      uniqueAbility: state.uniqueAbility,
      characterSetting: "AI相談から反映",
      weapons: [state.weapons[0]],
      armor: state.armor,
      skills: []
    };
    const returned = {
      format: "hoshimichi_character_return",
      schemaVersion: 1,
      consultationId,
      character,
      consultationFeedback: [{
        status: "candidate",
        category: "proposal_style",
        userIntent: "迷った時は候補を3つくらい見たい",
        suggestedInstruction: "方向性に迷っている場合は、異なる候補を3案程度提示する。",
        reason: "今回の相談で選びやすかったため"
      }]
    };
    const returnText =
      "===HOSHIMICHI_CHARACTER_RETURN_START===\n" +
      JSON.stringify(returned, null, 2) +
      "\n===HOSHIMICHI_CHARACTER_RETURN_END===";

    const parsed = await page.evaluate(text =>
      window.characterSheetBuilder.parseAiCharacterReturn(text), returnText
    );
    assert.equal(parsed.state.name, "AIテスト");
    assert.equal(parsed.state.baseStats.skill, 2);
    assert.equal(parsed.state.totalPoints, state.totalPoints);
    assert.equal(parsed.feedback.length, 1);

    await page.locator("#ai-return-input").fill(returnText);
    await page.locator("#preview-ai-return").click();
    assert.equal(await page.locator("#ai-import-dialog").getAttribute("open"), "");
    assert((await page.locator("#ai-import-summary").innerText()).includes("技量：0 → 2"));

    await page.locator("[data-ai-feedback-index='0']").selectOption("accept");
    await page.locator("#apply-ai-import").click();
    assert.equal(await page.locator("#character-name").inputValue(), "AIテスト");
    assert.equal(
      await page.evaluate(() => window.characterSheetBuilder.getState().baseStats.skill),
      2
    );

    const settings = await page.evaluate(() =>
      window.characterSheetBuilder.getAiConsultationSettings()
    );
    assert(settings.acceptedInstructions.includes(
      "方向性に迷っている場合は、異なる候補を3案程度提示する。"
    ));

    const nextPacket = await page.evaluate(() =>
      window.characterSheetBuilder.buildAiConsultationPacket()
    );
    assert(nextPacket.includes("方向性に迷っている場合は、異なる候補を3案程度提示する。"));

    assert.deepEqual(errors, []);
    console.log("AI consultation tests passed");
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
