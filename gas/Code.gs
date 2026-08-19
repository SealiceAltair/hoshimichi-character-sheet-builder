var HM_API_VERSION = 1;
var HM_SCHEMA_VERSION = 10;
var HM_TIME_ZONE = "Asia/Tokyo";
var HM_KEEP_REVISIONS = 3;
var HM_CHUNK_SIZE = 40000;
var HM_MAX_JSON_CHARS = 500000;
var HM_MAX_BODY_BYTES = 2000000;
var HM_LOCK_TIMEOUT_MS = 20000;
var HM_SPREADSHEET_PROPERTY = "HOSHIMICHI_SPREADSHEET_ID";
var HM_REQUEST_SPREADSHEET = null;

var HM_SHEETS = {
  characters: "Characters",
  revisions: "Revisions",
  chunks: "PayloadChunks",
  usage: "Usage"
};

var HM_HEADERS = {
  characters: [
    "character_id", "name_json", "target_type", "schema_version", "current_revision",
    "created_at", "updated_at", "deleted_at", "last_request_id"
  ],
  revisions: [
    "character_id", "revision", "operation", "restored_from_revision", "name_json",
    "target_type", "schema_version", "saved_at", "request_id", "sha256",
    "original_chars", "chunk_count"
  ],
  chunks: ["character_id", "revision", "chunk_index", "payload_b64"],
  usage: ["jst_date", "request_count", "updated_at"]
};

function setupHoshimichiCloud() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error("Googleスプレッドシートから、拡張機能 → Apps Scriptを開いて実行してください。");
  }
  PropertiesService.getScriptProperties().setProperty(HM_SPREADSHEET_PROPERTY, spreadsheet.getId());
  ensureSheets_(spreadsheet);
  return { spreadsheetId: spreadsheet.getId(), sheets: Object.keys(HM_SHEETS).map(function (key) {
    return HM_SHEETS[key];
  }) };
}

function doGet(e) {
  return handleRequest_("GET", e || {});
}

function doPost(e) {
  return handleRequest_("POST", e || {});
}

function handleRequest_(method, event) {
  HM_REQUEST_SPREADSHEET = null;
  var usage = null;
  var callback = event.parameter && event.parameter.callback;
  try {
    usage = incrementUsage_();
    var request = parseRequest_(method, event);
    var data = routeRequest_(method, request);
    return jsonOutput_({
      ok: true,
      data: data,
      usage: usage,
      serverTime: new Date().toISOString(),
      apiVersion: HM_API_VERSION
    }, callback);
  } catch (error) {
    return jsonOutput_({
      ok: false,
      error: publicError_(error),
      usage: usage,
      serverTime: new Date().toISOString(),
      apiVersion: HM_API_VERSION
    }, callback);
  }
}

function parseRequest_(method, event) {
  if (method === "GET") {
    var query = event.parameter || {};
    return { action: String(query.action || ""), id: String(query.id || "") };
  }
  var bodyLength = event.postData && event.postData.length ? Number(event.postData.length) : 0;
  if (bodyLength > HM_MAX_BODY_BYTES) {
    throw publicException_("PAYLOAD_TOO_LARGE", "送信データが大きすぎます。");
  }
  var payload = event.parameter && event.parameter.payload;
  if (!payload && event.postData && event.postData.contents) payload = event.postData.contents;
  if (!payload) throw publicException_("INVALID_REQUEST", "送信内容がありません。");
  try {
    return JSON.parse(payload);
  } catch (error) {
    throw publicException_("INVALID_JSON", "送信内容をJSONとして読み込めませんでした。");
  }
}

function routeRequest_(method, request) {
  var action = String(request.action || "");
  if (method === "GET") {
    if (action === "list") return listCharacters_();
    if (action === "get") return getCharacter_(request.id);
    if (action === "history") return getHistory_(request.id);
  } else {
    if (action === "save") return saveCharacter_(request);
    if (action === "restore") return restoreCharacter_(request);
    if (action === "delete") return deleteCharacter_(request);
  }
  throw publicException_("UNKNOWN_ACTION", "未対応の操作です。");
}

function listCharacters_() {
  var spreadsheet = getSpreadsheet_();
  var rows = dataRows_(spreadsheet.getSheetByName(HM_SHEETS.characters));
  return { characters: rows.filter(function (row) {
    return !row[7];
  }).map(characterSummaryFromRow_).sort(function (left, right) {
    return String(right.updatedAt).localeCompare(String(left.updatedAt));
  }) };
}

function getCharacter_(characterId) {
  validateUuid_(characterId, "characterId");
  var spreadsheet = getSpreadsheet_();
  return { character: publicCharacter_(spreadsheet, findCharacter_(spreadsheet, characterId, false)) };
}

function getHistory_(characterId) {
  validateUuid_(characterId, "characterId");
  var spreadsheet = getSpreadsheet_();
  var record = findCharacter_(spreadsheet, characterId, false);
  var currentRevision = positiveInteger_(record.values[4], "currentRevision");
  var history = dataRows_(spreadsheet.getSheetByName(HM_SHEETS.revisions)).filter(function (row) {
    return row[0] === characterId && Number(row[1]) < currentRevision;
  }).sort(function (left, right) {
    return Number(right[1]) - Number(left[1]);
  }).slice(0, 2).map(function (row) {
    return {
      revision: Number(row[1]),
      operation: String(row[2]),
      restoredFromRevision: row[3] === "" ? null : Number(row[3]),
      savedAt: isoString_(row[7])
    };
  });
  return {
    characterId: characterId,
    name: parseName_(record.values[1]),
    currentRevision: currentRevision,
    history: history
  };
}

function saveCharacter_(request) {
  validateRequestId_(request.requestId);
  var stateInfo = validateState_(request.state);
  var requestedId = String(request.characterId || "");
  if (requestedId) validateUuid_(requestedId, "characterId");

  return withScriptLock_(function () {
    var spreadsheet = getSpreadsheet_();
    var charactersSheet = spreadsheet.getSheetByName(HM_SHEETS.characters);
    var now = new Date().toISOString();
    if (!requestedId) {
      var existingRows = dataRows_(charactersSheet);
      for (var existingIndex = 0; existingIndex < existingRows.length; existingIndex += 1) {
        if (existingRows[existingIndex][8] === request.requestId && !existingRows[existingIndex][7]) {
          return {
            character: publicCharacter_(spreadsheet, {
              rowIndex: existingIndex + 2,
              values: existingRows[existingIndex]
            })
          };
        }
      }
      var newId = Utilities.getUuid();
      writeRevision_(spreadsheet, newId, 1, request.state, {
        operation: "create", restoredFromRevision: "", requestId: request.requestId, savedAt: now
      });
      charactersSheet.appendRow([
        newId, JSON.stringify(stateInfo.name), stateInfo.targetType, stateInfo.schemaVersion,
        1, now, now, "", request.requestId
      ]);
      return { character: publicCharacter_(spreadsheet, findCharacter_(spreadsheet, newId, false)) };
    }

    var record = findCharacter_(spreadsheet, requestedId, false);
    if (record.values[8] === request.requestId) {
      pruneRevisions_(spreadsheet, requestedId);
      return { character: publicCharacter_(spreadsheet, record) };
    }
    var currentRevision = positiveInteger_(record.values[4], "currentRevision");
    var baseRevision = nonNegativeInteger_(request.baseRevision, "baseRevision");
    if (!request.force && baseRevision !== currentRevision) {
      throw publicException_("REVISION_CONFLICT", "別の環境で先に更新されています。", {
        currentRevision: currentRevision
      });
    }
    var nextRevision = currentRevision + 1;
    writeRevision_(spreadsheet, requestedId, nextRevision, request.state, {
      operation: "save", restoredFromRevision: "", requestId: request.requestId, savedAt: now
    });
    charactersSheet.getRange(record.rowIndex, 2, 1, 8).setValues([[
      JSON.stringify(stateInfo.name), stateInfo.targetType, stateInfo.schemaVersion, nextRevision,
      record.values[5], now, "", request.requestId
    ]]);
    pruneRevisions_(spreadsheet, requestedId);
    return { character: publicCharacter_(spreadsheet, findCharacter_(spreadsheet, requestedId, false)) };
  });
}

function restoreCharacter_(request) {
  validateRequestId_(request.requestId);
  var characterId = String(request.characterId || "");
  validateUuid_(characterId, "characterId");
  var sourceRevision = positiveInteger_(request.sourceRevision, "sourceRevision");
  var baseRevision = positiveInteger_(request.baseRevision, "baseRevision");

  return withScriptLock_(function () {
    var spreadsheet = getSpreadsheet_();
    var record = findCharacter_(spreadsheet, characterId, false);
    if (record.values[8] === request.requestId) {
      pruneRevisions_(spreadsheet, characterId);
      return { character: publicCharacter_(spreadsheet, record) };
    }
    var currentRevision = positiveInteger_(record.values[4], "currentRevision");
    if (baseRevision !== currentRevision) {
      throw publicException_("REVISION_CONFLICT", "別の環境で先に更新されています。", {
        currentRevision: currentRevision
      });
    }
    if (sourceRevision === currentRevision) {
      throw publicException_("INVALID_REVISION", "現在版を復元元にはできません。");
    }
    var sourceState = readRevisionPayload_(spreadsheet, characterId, sourceRevision);
    var stateInfo = validateState_(sourceState);
    var nextRevision = currentRevision + 1;
    var now = new Date().toISOString();
    writeRevision_(spreadsheet, characterId, nextRevision, sourceState, {
      operation: "restore", restoredFromRevision: sourceRevision,
      requestId: request.requestId, savedAt: now
    });
    spreadsheet.getSheetByName(HM_SHEETS.characters).getRange(record.rowIndex, 2, 1, 8).setValues([[
      JSON.stringify(stateInfo.name), stateInfo.targetType, stateInfo.schemaVersion, nextRevision,
      record.values[5], now, "", request.requestId
    ]]);
    pruneRevisions_(spreadsheet, characterId);
    return { character: publicCharacter_(spreadsheet, findCharacter_(spreadsheet, characterId, false)) };
  });
}

function deleteCharacter_(request) {
  validateRequestId_(request.requestId);
  var characterId = String(request.characterId || "");
  validateUuid_(characterId, "characterId");
  var baseRevision = positiveInteger_(request.baseRevision, "baseRevision");
  return withScriptLock_(function () {
    var spreadsheet = getSpreadsheet_();
    var record = findCharacter_(spreadsheet, characterId, true);
    if (record.values[7]) return { characterId: characterId, deleted: true };
    var currentRevision = positiveInteger_(record.values[4], "currentRevision");
    if (baseRevision !== currentRevision) {
      throw publicException_("REVISION_CONFLICT", "別の環境で先に更新されています。", {
        currentRevision: currentRevision
      });
    }
    spreadsheet.getSheetByName(HM_SHEETS.characters).getRange(record.rowIndex, 8, 1, 2)
      .setValues([[new Date().toISOString(), request.requestId]]);
    return { characterId: characterId, deleted: true };
  });
}

function publicCharacter_(spreadsheet, record) {
  var summary = characterSummaryFromRow_(record.values);
  summary.state = readRevisionPayload_(spreadsheet, summary.id, summary.revision);
  return summary;
}

function characterSummaryFromRow_(row) {
  return {
    id: String(row[0]),
    name: parseName_(row[1]),
    targetType: row[2] === "monster" ? "monster" : "character",
    schemaVersion: Number(row[3]),
    revision: Number(row[4]),
    createdAt: isoString_(row[5]),
    updatedAt: isoString_(row[6])
  };
}

function writeRevision_(spreadsheet, characterId, revision, state, meta) {
  var encoded = encodePayload_(state);
  var stateInfo = validateState_(state);
  deleteStoredRevision_(spreadsheet, characterId, revision);
  spreadsheet.getSheetByName(HM_SHEETS.revisions).appendRow([
    characterId, revision, meta.operation, meta.restoredFromRevision,
    JSON.stringify(stateInfo.name), stateInfo.targetType, stateInfo.schemaVersion,
    meta.savedAt, meta.requestId, encoded.sha256, encoded.originalChars, encoded.chunks.length
  ]);
  var chunkRows = encoded.chunks.map(function (chunk, index) {
    return [characterId, revision, index, chunk];
  });
  if (chunkRows.length) {
    var chunkSheet = spreadsheet.getSheetByName(HM_SHEETS.chunks);
    chunkSheet.getRange(chunkSheet.getLastRow() + 1, 1, chunkRows.length, 4).setValues(chunkRows);
  }
}

function deleteStoredRevision_(spreadsheet, characterId, revision) {
  var chunksSheet = spreadsheet.getSheetByName(HM_SHEETS.chunks);
  dataRows_(chunksSheet).map(function (row, index) {
    return { rowIndex: index + 2, characterId: row[0], revision: Number(row[1]) };
  }).filter(function (entry) {
    return entry.characterId === characterId && entry.revision === Number(revision);
  }).sort(function (left, right) {
    return right.rowIndex - left.rowIndex;
  }).forEach(function (entry) {
    chunksSheet.deleteRow(entry.rowIndex);
  });

  var revisionsSheet = spreadsheet.getSheetByName(HM_SHEETS.revisions);
  dataRows_(revisionsSheet).map(function (row, index) {
    return { rowIndex: index + 2, characterId: row[0], revision: Number(row[1]) };
  }).filter(function (entry) {
    return entry.characterId === characterId && entry.revision === Number(revision);
  }).sort(function (left, right) {
    return right.rowIndex - left.rowIndex;
  }).forEach(function (entry) {
    revisionsSheet.deleteRow(entry.rowIndex);
  });
}

function readRevisionPayload_(spreadsheet, characterId, revision) {
  var meta = dataRows_(spreadsheet.getSheetByName(HM_SHEETS.revisions)).find(function (row) {
    return row[0] === characterId && Number(row[1]) === Number(revision);
  });
  if (!meta) throw publicException_("REVISION_NOT_FOUND", "指定した保存履歴は残っていません。");
  var chunks = dataRows_(spreadsheet.getSheetByName(HM_SHEETS.chunks)).filter(function (row) {
    return row[0] === characterId && Number(row[1]) === Number(revision);
  }).sort(function (left, right) {
    return Number(left[2]) - Number(right[2]);
  });
  if (chunks.length !== Number(meta[11])) {
    throw publicException_("CORRUPT_DATA", "保存データの分割数が一致しません。");
  }
  try {
    var base64 = chunks.map(function (row) { return String(row[3]); }).join("");
    var bytes = Utilities.base64DecodeWebSafe(base64);
    var json = Utilities.newBlob(bytes).getDataAsString("UTF-8");
    if (json.length !== Number(meta[10]) || sha256Hex_(bytes) !== String(meta[9])) {
      throw new Error("payload verification failed");
    }
    return JSON.parse(json);
  } catch (error) {
    throw publicException_("CORRUPT_DATA", "保存データを復元できませんでした。");
  }
}

function encodePayload_(state) {
  var json = JSON.stringify(state);
  if (json.length > HM_MAX_JSON_CHARS) {
    throw publicException_("PAYLOAD_TOO_LARGE", "キャラクターデータが大きすぎます。");
  }
  var bytes = Utilities.newBlob(json, "application/json", "character.json").getBytes();
  var base64 = Utilities.base64EncodeWebSafe(bytes);
  var chunks = [];
  for (var index = 0; index < base64.length; index += HM_CHUNK_SIZE) {
    chunks.push(base64.slice(index, index + HM_CHUNK_SIZE));
  }
  return { sha256: sha256Hex_(bytes), originalChars: json.length, chunks: chunks };
}

function sha256Hex_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes).map(function (value) {
    var normalized = value < 0 ? value + 256 : value;
    return ("0" + normalized.toString(16)).slice(-2);
  }).join("");
}

function pruneRevisions_(spreadsheet, characterId) {
  var revisionsSheet = spreadsheet.getSheetByName(HM_SHEETS.revisions);
  var revisionRows = dataRows_(revisionsSheet).map(function (row, index) {
    return { rowIndex: index + 2, characterId: row[0], revision: Number(row[1]) };
  }).filter(function (entry) {
    return entry.characterId === characterId;
  }).sort(function (left, right) {
    return right.revision - left.revision;
  });
  var obsolete = revisionRows.slice(HM_KEEP_REVISIONS);
  if (!obsolete.length) return;
  var obsoleteRevisions = obsolete.map(function (entry) { return entry.revision; });
  var chunksSheet = spreadsheet.getSheetByName(HM_SHEETS.chunks);
  dataRows_(chunksSheet).map(function (row, index) {
    return { rowIndex: index + 2, characterId: row[0], revision: Number(row[1]) };
  }).filter(function (entry) {
    return entry.characterId === characterId && obsoleteRevisions.indexOf(entry.revision) >= 0;
  }).sort(function (left, right) {
    return right.rowIndex - left.rowIndex;
  }).forEach(function (entry) {
    chunksSheet.deleteRow(entry.rowIndex);
  });
  obsolete.sort(function (left, right) {
    return right.rowIndex - left.rowIndex;
  }).forEach(function (entry) {
    revisionsSheet.deleteRow(entry.rowIndex);
  });
}

function validateState_(state) {
  if (!state || typeof state !== "object" || Number(state.version) !== HM_SCHEMA_VERSION) {
    throw publicException_("UNSUPPORTED_SCHEMA", "未対応のキャラクターデータ形式です。");
  }
  var name = String(state.name || "").trim();
  if (!name || name.length > 100) {
    throw publicException_("INVALID_NAME", "キャラクター名は1～100文字で入力してください。");
  }
  var json = JSON.stringify(state);
  if (json.length > HM_MAX_JSON_CHARS) {
    throw publicException_("PAYLOAD_TOO_LARGE", "キャラクターデータが大きすぎます。");
  }
  return {
    name: name,
    targetType: state.targetType === "monster" ? "monster" : "character",
    schemaVersion: HM_SCHEMA_VERSION
  };
}

function findCharacter_(spreadsheet, characterId, includeDeleted) {
  var rows = dataRows_(spreadsheet.getSheetByName(HM_SHEETS.characters));
  for (var index = 0; index < rows.length; index += 1) {
    if (rows[index][0] === characterId) {
      if (!includeDeleted && rows[index][7]) {
        throw publicException_("CHARACTER_DELETED", "このキャラクターは一覧から削除されています。");
      }
      return { rowIndex: index + 2, values: rows[index] };
    }
  }
  throw publicException_("CHARACTER_NOT_FOUND", "キャラクターが見つかりません。");
}

function incrementUsage_() {
  return withScriptLock_(function () {
    var spreadsheet = getSpreadsheet_();
    var sheet = spreadsheet.getSheetByName(HM_SHEETS.usage);
    var date = Utilities.formatDate(new Date(), HM_TIME_ZONE, "yyyy-MM-dd");
    var rows = dataRows_(sheet);
    for (var index = 0; index < rows.length; index += 1) {
      if (rows[index][0] === date) {
        var count = Number(rows[index][1]) + 1;
        sheet.getRange(index + 2, 2, 1, 2).setValues([[count, new Date().toISOString()]]);
        return { dateJst: date, count: count };
      }
    }
    sheet.appendRow([date, 1, new Date().toISOString()]);
    return { dateJst: date, count: 1 };
  });
}

function withScriptLock_(callback) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(HM_LOCK_TIMEOUT_MS)) {
    throw publicException_("BUSY", "同時処理が混み合っています。少し待ってから再実行してください。");
  }
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function getSpreadsheet_() {
  if (HM_REQUEST_SPREADSHEET) return HM_REQUEST_SPREADSHEET;
  var id = PropertiesService.getScriptProperties().getProperty(HM_SPREADSHEET_PROPERTY);
  if (!id) {
    throw publicException_("NOT_SETUP", "GASの初期設定が終わっていません。setupHoshimichiCloudを一度実行してください。");
  }
  var spreadsheet = SpreadsheetApp.openById(id);
  ensureSheets_(spreadsheet);
  HM_REQUEST_SPREADSHEET = spreadsheet;
  return HM_REQUEST_SPREADSHEET;
}

function ensureSheets_(spreadsheet) {
  Object.keys(HM_SHEETS).forEach(function (key) {
    var name = HM_SHEETS[key];
    var sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
    var headers = HM_HEADERS[key];
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
      return;
    }
    var current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    if (current.join("\t") !== headers.join("\t")) {
      throw publicException_("INVALID_SHEET", name + "シートの見出しが一致しません。");
    }
  });
}

function dataRows_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) return [];
  return sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
}

function parseName_(value) {
  try {
    return String(JSON.parse(String(value)) || "");
  } catch (error) {
    return String(value || "");
  }
}

function isoString_(value) {
  if (value instanceof Date) return value.toISOString();
  var date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value || "") : date.toISOString();
}

function validateUuid_(value, label) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value))) {
    throw publicException_("INVALID_ID", label + "が正しくありません。");
  }
}

function validateRequestId_(value) {
  validateUuid_(String(value || ""), "requestId");
}

function positiveInteger_(value, label) {
  var number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw publicException_("INVALID_NUMBER", label + "が正しくありません。");
  }
  return number;
}

function nonNegativeInteger_(value, label) {
  var number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw publicException_("INVALID_NUMBER", label + "が正しくありません。");
  }
  return number;
}

function publicException_(code, message, details) {
  var error = new Error(message);
  error.publicCode = code;
  error.publicDetails = details || {};
  return error;
}

function publicError_(error) {
  var result = {
    code: error.publicCode || "SERVER_ERROR",
    message: error.publicCode ? error.message : "サーバー処理に失敗しました。"
  };
  Object.keys(error.publicDetails || {}).forEach(function (key) {
    result[key] = error.publicDetails[key];
  });
  return result;
}

function jsonOutput_(payload, callback) {
  var json = JSON.stringify(payload);
  if (callback && /^[A-Za-z_$][0-9A-Za-z_$\.]*$/.test(callback)) {
    return ContentService.createTextOutput(callback + "(" + json + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}
