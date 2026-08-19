"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = __dirname;
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const gas = fs.readFileSync(path.join(root, "gas", "Code.gs"), "utf8");

function includes(source, expected, message) {
  assert(source.includes(expected), message || `Missing: ${expected}`);
}

// ブラウザ用の全インラインスクリプトとGASコードが構文解析できること。
const inlineScripts = Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi));
assert(inlineScripts.length >= 4, "Expected the builder, navigation, config, and cloud scripts");
inlineScripts.forEach((match, index) => {
  assert.doesNotThrow(() => new Function(match[1]), `Inline script ${index + 1} has a syntax error`);
});
assert.doesNotThrow(() => new Function(gas), "Code.gs has a syntax error");

// 3タブと単一HTMLのオフライン動作契約。
const tabOrder = ["library", "builder", "play"].map((name) => html.indexOf(`data-primary-tab="${name}"`));
assert(tabOrder.every((position) => position >= 0), "All three primary tabs must exist");
assert(tabOrder[0] < tabOrder[1] && tabOrder[1] < tabOrder[2], "Primary tabs are in the wrong order");
const elementIds = Array.from(html.matchAll(/\sid="([^"]+)"/g), (match) => match[1]);
assert.strictEqual(new Set(elementIds).size, elementIds.length, "HTML contains a duplicate id");
includes(html, "キャラ一覧へ →");
includes(html, "キャラ作成へ →");
includes(html, "シナリオ・RPへ →");
includes(html, "grid-template-columns: repeat(3, minmax(0, 1fr))");
assert(
  /window\.HOSHIMICHI_CLOUD_API_URL\s*=\s*"https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec";/.test(html),
  "Cloud must point to a deployed GAS web app"
);
assert(!/<script[^>]+src=/i.test(html), "The builder must not depend on an external script");
assert(!/<link[^>]+rel=["']stylesheet["']/i.test(html), "The builder must not depend on an external stylesheet");

// 従来のlocalStorageとクラウド用データを別キーで維持すること。
includes(html, 'var STORAGE_KEY = "hoshimichi-character-sheet-builder";');
includes(html, 'var STORAGE_VERSION = 10;');
includes(html, 'var CLOUD_CONTEXT_KEY = "hoshimichi-character-sheet-builder-cloud-context-v1";');
includes(html, 'var LOCAL_BACKUP_KEY = "hoshimichi-character-sheet-builder-cloud-backups-v1";');
includes(html, "storeLocalBackup(");
includes(html, '"cloud:" + snapshot.character.id');
includes(html, 'var snapshot = await apiGet("get", { id: character.id });');
assert(
  html.indexOf('var snapshot = await apiGet("get", { id: character.id });') <
    html.indexOf('action: "delete"', html.indexOf("async function deleteCloudCharacter")),
  "A cloud character must be backed up before logical deletion"
);

// 公開データからKP内部設定を除き、読込時は現在端末の設定を維持すること。
includes(html, "delete cloudState.kpSettings;");
includes(html, '!Object.prototype.hasOwnProperty.call(source, "kpSettings")');
includes(html, "source.kpSettings = JSON.parse(JSON.stringify(state.kpSettings));");
includes(html, "state = sanitizeState(source);");
assert(
  html.indexOf("state = sanitizeState(source);") < html.indexOf("saveState();", html.indexOf("function replaceState")),
  "Cloud state must be sanitized before it is stored locally"
);

// GAS通信はpreflightを招きにくいフォームPOSTで、カウンター専用通信を持たないこと。
includes(html, "new URLSearchParams({ payload: JSON.stringify(request) })");
includes(html, 'redirect: "follow"');
includes(html, 'credentials: "omit"');
assert(!/mode\s*:\s*["']no-cors["']/.test(html), "no-cors responses cannot be read");
assert(!/action\s*[:=]\s*["'](?:usage|counter|quota)["']/.test(html), "Do not add a counter-only API call");
includes(html, 'usageCounter.textContent = "本日の通信回数：" + count + "回";');
includes(html, "saveButton.disabled = saveInProgress;");
includes(html, "saveCopyButton.disabled = saveInProgress;");
includes(html, "クラウド保存を使うにはGASのURL設定が必要です。入力内容はこのブラウザへ自動保存されています。");
assert(!html.includes("saveButton.disabled = !configured || !hasName"), "Save must explain why it cannot proceed after click");

// 公開HTMLへ所有者情報を埋め込まないこと。
assert(!/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(html), "An email address leaked into index.html");

// GASの主要契約。
includes(gas, "var HM_KEEP_REVISIONS = 3;");
includes(gas, "var HM_CHUNK_SIZE = 40000;");
includes(gas, 'var HM_TIME_ZONE = "Asia/Tokyo";');
includes(gas, 'if (action === "list")');
includes(gas, 'if (action === "get")');
includes(gas, 'if (action === "history")');
includes(gas, 'if (action === "save")');
includes(gas, 'if (action === "restore")');
includes(gas, 'if (action === "delete")');
includes(gas, "LockService.getScriptLock()");
includes(gas, "revisionRows.slice(HM_KEEP_REVISIONS)");
includes(gas, "usage: usage");
includes(gas, "usageDateKey_(rows[index][0])");
includes(gas, "previousCount += Number(rows[index][1] || 0);");
includes(gas, "sheet.deleteRow(matchingRows[duplicateIndex]);");
assert(!/getOwner\(|getEmail\(/.test(gas), "The API must not expose the owner's identity");

// GASのペイロード分割と入力検証を、Node上の最小モックで実行する。
const utilities = {
  DigestAlgorithm: { SHA_256: "SHA_256" },
  newBlob(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return {
      getBytes: () => Array.from(bytes, (byte) => (byte > 127 ? byte - 256 : byte)),
      getDataAsString: () => bytes.toString("utf8")
    };
  },
  base64EncodeWebSafe(bytes) {
    return Buffer.from(bytes.map((byte) => (byte < 0 ? byte + 256 : byte)))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  },
  base64DecodeWebSafe(value) {
    return Array.from(Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
  },
  computeDigest(_algorithm, bytes) {
    return Array.from(
      crypto.createHash("sha256").update(Buffer.from(bytes.map((byte) => (byte < 0 ? byte + 256 : byte)))).digest(),
      (byte) => (byte > 127 ? byte - 256 : byte)
    );
  }
};

const gasContext = vm.createContext({
  Utilities: utilities,
  console,
  Date,
  Error,
  JSON,
  Math,
  Number,
  Object,
  String,
  Array,
  RegExp
});
vm.runInContext(gas, gasContext);

const largeState = { version: 10, name: "分割試験", targetType: "character", note: "星".repeat(90000) };
const encoded = gasContext.encodePayload_(largeState);
assert(encoded.chunks.length > 1, "Large state should be split across cells");
assert(encoded.chunks.every((chunk) => chunk.length <= 40000), "A payload chunk exceeds 40,000 characters");
assert.strictEqual(encoded.originalChars, JSON.stringify(largeState).length);
assert.strictEqual(encoded.sha256.length, 64);

assert.strictEqual(gasContext.validateState_(largeState).name, "分割試験");
assert.throws(
  () => gasContext.validateState_({ version: 10, name: "" }),
  (error) => error.publicCode === "INVALID_NAME"
);
assert.throws(
  () => gasContext.validateState_({ version: 9, name: "旧版" }),
  (error) => error.publicCode === "UNSUPPORTED_SCHEMA"
);

// インメモリのスプレッドシートで、保存・3版保持・復元・論理削除を結合試験する。
class MemoryRange {
  constructor(sheet, row, column, rowCount = 1, columnCount = 1) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.rowCount = rowCount;
    this.columnCount = columnCount;
  }

  getValues() {
    return Array.from({ length: this.rowCount }, (_unused, rowOffset) =>
      Array.from({ length: this.columnCount }, (_unusedColumn, columnOffset) => {
        const row = this.sheet.rows[this.row - 1 + rowOffset] || [];
        const value = row[this.column - 1 + columnOffset];
        return value === undefined ? "" : value;
      })
    );
  }

  setValues(values) {
    assert.strictEqual(values.length, this.rowCount);
    values.forEach((valuesRow, rowOffset) => {
      assert.strictEqual(valuesRow.length, this.columnCount);
      const rowIndex = this.row - 1 + rowOffset;
      while (this.sheet.rows.length <= rowIndex) this.sheet.rows.push([]);
      const target = this.sheet.rows[rowIndex];
      valuesRow.forEach((value, columnOffset) => {
        target[this.column - 1 + columnOffset] = value;
      });
    });
    return this;
  }
}

class MemorySheet {
  constructor(name) {
    this.name = name;
    this.rows = [];
  }

  getLastRow() {
    return this.rows.length;
  }

  getLastColumn() {
    return this.rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  }

  getRange(row, column, rowCount = 1, columnCount = 1) {
    return new MemoryRange(this, row, column, rowCount, columnCount);
  }

  appendRow(values) {
    this.rows.push(values.slice());
    return this;
  }

  deleteRow(row) {
    this.rows.splice(row - 1, 1);
  }

  setFrozenRows() {}
}

class MemorySpreadsheet {
  constructor(id) {
    this.id = id;
    this.sheets = new Map();
  }

  getId() {
    return this.id;
  }

  getSheetByName(name) {
    return this.sheets.get(name) || null;
  }

  insertSheet(name) {
    const sheet = new MemorySheet(name);
    this.sheets.set(name, sheet);
    return sheet;
  }
}

const memorySpreadsheet = new MemorySpreadsheet("test-spreadsheet");
const memoryProperties = {};
let generatedUuid = 1000;
utilities.getUuid = () => {
  generatedUuid += 1;
  return `00000000-0000-4000-8000-${generatedUuid.toString(16).padStart(12, "0")}`;
};
utilities.formatDate = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

gasContext.SpreadsheetApp = {
  getActiveSpreadsheet: () => memorySpreadsheet,
  openById: (id) => {
    assert.strictEqual(id, memorySpreadsheet.id);
    return memorySpreadsheet;
  }
};
gasContext.PropertiesService = {
  getScriptProperties: () => ({
    setProperty: (key, value) => { memoryProperties[key] = value; },
    getProperty: (key) => memoryProperties[key] || null
  })
};
gasContext.LockService = {
  getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
};
gasContext.ContentService = {
  MimeType: { JSON: "application/json", JAVASCRIPT: "application/javascript" },
  createTextOutput: (value) => ({
    value,
    mimeType: "",
    setMimeType(mimeType) {
      this.mimeType = mimeType;
      return this;
    }
  })
};

gasContext.setupHoshimichiCloud();
assert.deepStrictEqual(
  Array.from(memorySpreadsheet.sheets.keys()).sort(),
  ["Characters", "PayloadChunks", "Revisions", "Usage"].sort()
);

function requestId(number) {
  return `10000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
}

function revisionState(name) {
  return { version: 10, name, targetType: "character", characterSetting: `設定:${name}` };
}

let savedCharacter = gasContext.saveCharacter_({
  action: "save",
  requestId: requestId(1),
  characterId: "",
  baseRevision: 0,
  state: revisionState("v1")
}).character;
const savedCharacterId = savedCharacter.id;
assert.strictEqual(savedCharacter.revision, 1);
const repeatedCreate = gasContext.saveCharacter_({
  action: "save",
  requestId: requestId(1),
  characterId: "",
  baseRevision: 0,
  state: revisionState("v1")
}).character;
assert.strictEqual(repeatedCreate.id, savedCharacterId, "Retrying a create request must reuse the character id");
assert.strictEqual(memorySpreadsheet.getSheetByName("Characters").rows.length, 2);

for (let revision = 2; revision <= 4; revision += 1) {
  savedCharacter = gasContext.saveCharacter_({
    action: "save",
    requestId: requestId(revision),
    characterId: savedCharacterId,
    baseRevision: revision - 1,
    state: revisionState(`v${revision}`)
  }).character;
}
assert.strictEqual(savedCharacter.revision, 4);
assert.strictEqual(savedCharacter.state.name, "v4");

const historyAtV4 = gasContext.getHistory_(savedCharacterId);
assert.deepStrictEqual(Array.from(historyAtV4.history, (entry) => entry.revision), [3, 2]);
assert.deepStrictEqual(
  memorySpreadsheet.getSheetByName("Revisions").rows.slice(1).map((row) => row[1]),
  [2, 3, 4]
);
const idempotentRetry = gasContext.saveCharacter_({
  action: "save",
  requestId: requestId(4),
  characterId: savedCharacterId,
  baseRevision: 3,
  state: revisionState("v4")
}).character;
assert.strictEqual(idempotentRetry.revision, 4, "Retrying the same request must not create v5");
assert.throws(
  () => gasContext.saveCharacter_({
    action: "save",
    requestId: requestId(99),
    characterId: savedCharacterId,
    baseRevision: 3,
    state: revisionState("競合版")
  }),
  (error) => error.publicCode === "REVISION_CONFLICT" && error.publicDetails.currentRevision === 4
);

const restored = gasContext.restoreCharacter_({
  action: "restore",
  requestId: requestId(5),
  characterId: savedCharacterId,
  sourceRevision: 2,
  baseRevision: 4
}).character;
assert.strictEqual(restored.revision, 5);
assert.strictEqual(restored.state.name, "v2");
assert.deepStrictEqual(
  Array.from(gasContext.getHistory_(savedCharacterId).history, (entry) => entry.revision),
  [4, 3]
);

gasContext.deleteCharacter_({
  action: "delete",
  requestId: requestId(6),
  characterId: savedCharacterId,
  baseRevision: 5
});
assert.strictEqual(gasContext.listCharacters_().characters.length, 0);
assert.throws(
  () => gasContext.getCharacter_(savedCharacterId),
  (error) => error.publicCode === "CHARACTER_DELETED"
);

const firstSeed = gasContext.seedCurrentCharacters();
assert.deepStrictEqual(Array.from(firstSeed.created), [
  "紅焔",
  "フィトリアット・マリアベル",
  "カイト",
  "カーヴェイン",
  "シーリス・アルタイル",
  "シェイナム",
  "マイン・A・レッドフォックス"
]);
assert.deepStrictEqual(Array.from(firstSeed.skipped), []);
assert.deepStrictEqual(
  Array.from(gasContext.listCharacters_().characters, (character) => character.name),
  Array.from(firstSeed.created)
);
const repeatedSeed = gasContext.seedCurrentCharacters();
assert.deepStrictEqual(Array.from(repeatedSeed.created), []);
assert.deepStrictEqual(Array.from(repeatedSeed.skipped), Array.from(firstSeed.created));
assert.strictEqual(memorySpreadsheet.getSheetByName("Characters").rows.length, 9);

const currentSeeds = gasContext.currentCharacterSeeds_();
const shainamSeed = currentSeeds.find((seed) => seed.state.name === "シェイナム");
assert.strictEqual(shainamSeed.state.name, "シェイナム", "Only Shainam's public name may be seeded");
assert(!shainamSeed.state.name.includes("・"), "A non-public surname leaked into Shainam's list name");
const mineSeed = currentSeeds.find((seed) => seed.state.name.startsWith("マイン"));
assert.strictEqual(mineSeed.state.totalPoints, 0, "Unregistered CP must not be invented for Mine");

const countedResponse = gasContext.doGet({ parameter: { action: "list" } });
const countedPayload = JSON.parse(countedResponse.value);
assert.strictEqual(countedPayload.ok, true);
assert.strictEqual(countedPayload.usage.count, 1);
assert(/^\d{4}-\d{2}-\d{2}$/.test(countedPayload.usage.dateJst));

console.log("星みちTRPG builder cloud tests: PASS");
