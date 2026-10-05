(function () {
  "use strict";
  const C = window.HoshimichiAuthoringCore;
  const KEY = "hoshimichi-authoring-drafts-v1";
  const MAX_FILE = 5 * 1024 * 1024;
  const panels = { map: document.getElementById("map-panel"), scenario: document.getElementById("scenario-panel") };
  let store = null, storedText = null, mapId = null, scenarioId = null, selectedPoint = null, selectedRoute = null;
  let undo = [], redo = [], gesture = null, mode = "brush", tile = 2, zoom = 1, cursor = [0, 0], epoch = 0;
  let graphZoom = 1, graphLinkFrom = null;
  let pendingProposal = null;
  let statusText = "", statusError = false;
  let pendingRecovery = null, recovering = false;
  const unlocked = () => window.characterSheetBuilder.isKpMode();
  const uid = () => "local-" + (window.crypto.randomUUID ? window.crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const map = () => store && store.maps.find(item => item.id === mapId);
  const scenario = () => store && store.scenarios.find(item => item.id === scenarioId);
  const byId = id => document.getElementById(id);
  function el(tag, text, attrs = {}) {
    const node = document.createElement(tag);
    if (text !== null && text !== undefined) { node.textContent = text; }
    Object.entries(attrs).forEach(([key, value]) => { if (value !== false && value !== null) { node.setAttribute(key, value === true ? "" : String(value)); } });
    return node;
  }
  function append(parent, ...nodes) { parent.append(...nodes); return parent; }
  function button(parent, text, handler, attrs = {}) {
    const node = el("button", text, { type: "button", class: "secondary-button", ...attrs });
    node.addEventListener("click", () => { if (unlocked()) { safely(handler); } }); parent.append(node); return node;
  }
  function field(parent, label, id, value, handler, options = {}) {
    const wrap = el("div", null, { class: "field" + (options.compact ? " compact" : "") });
    const input = el(options.choices ? "select" : options.area ? "textarea" : "input", null, { id, maxlength: options.max || 30000 });
    if (options.choices) { options.choices.forEach(choice => input.append(new Option(choice[1], choice[0]))); }
    else if (!options.area) { input.type = options.type || "text"; }
    if (options.min !== undefined) { input.min = options.min; input.max = options.max; }
    if (options.readonly) { input.readOnly = true; }
    input.value = value;
    if (handler) { input.addEventListener(options.choices ? "change" : "input", () => { if (unlocked()) { safely(() => handler(input.value)); } }); }
    append(wrap, el("label", label, { for: id }), input); parent.append(wrap); return input;
  }
  function safely(action) { try { action(); } catch (error) { status(error.message, true); } }
  function status(text, error = false) {
    statusText = text; statusError = error;
    document.querySelectorAll(".authoring-status").forEach(node => { node.textContent = text; node.classList.toggle("is-error", error); });
  }
  function persist() {
    if (!unlocked() || !store) { return false; }
    try {
      C.validateStore(store);
      if (localStorage.getItem(KEY) !== storedText) { throw new Error("別タブで下書きが更新されています。上書きしていません。この内容をJSONで退避してから再読み込みしてください。"); }
      const next = JSON.stringify(store);
      localStorage.setItem(KEY, next); storedText = next;
      if (recovering) { localStorage.removeItem(KEY + "-recovery"); pendingRecovery = null; recovering = false; }
      status("このブラウザに保存済み", false); return true;
    } catch (error) { status("未保存：" + error.message + " JSON出力で退避できます。", true); return false; }
  }
  function load() {
    storedText = localStorage.getItem(KEY);
    store = storedText ? C.validateStore(JSON.parse(storedText)) : { version: 1, maps: [], scenarios: [] };
    recovering = false;
    if (!pendingRecovery) {
      try { pendingRecovery = JSON.parse(localStorage.getItem(KEY + "-recovery") || "null"); } catch (ignored) {}
    }
    if (pendingRecovery && window.confirm("未保存で退避した制作下書きがあります。開きますか？別タブの更新は上書きせず、JSONで退避できます。")) {
      store = C.validateStore(pendingRecovery.store); storedText = pendingRecovery.baseline; recovering = true;
    }
    if (!store.maps.length) { store.maps.push(C.newGraphMap(uid())); }
    if (!store.scenarios.length) { store.scenarios.push(C.newScenario(uid())); }
    mapId = store.maps.some(m => m.id === mapId) ? mapId : store.maps[0].id;
    scenarioId = store.scenarios.some(s => s.id === scenarioId) ? scenarioId : store.scenarios[0].id;
    undo = []; redo = []; selectedPoint = null; selectedRoute = null; gesture = null; graphLinkFrom = null; pendingProposal = null;
  }
  function refreshSelectors() {
    [["map-drafts", store.maps, mapId], ["scenario-drafts", store.scenarios, scenarioId]].forEach(([id, entries, selected]) => {
      const input = byId(id); if (!input) { return; }
      input.replaceChildren(...entries.map(item => new Option(item.name || "名前未入力", item.id)));
      input.value = selected;
    });
  }
  function saveMap() { persist(); refreshSelectors(); draw(); updateMapOutput(); updateScenarioOutput(); }
  function saveScenario() { persist(); refreshSelectors(); updateScenarioOutput(); }
  function pushUndo(before) {
    if (JSON.stringify(before) !== JSON.stringify(map())) { undo.push(before); if (undo.length > 80) { undo.shift(); } redo = []; }
  }
  function changeMap(action) { const before = C.clone(map()); action(map()); pushUndo(before); saveMap(); }
  function history(back) {
    const from = back ? undo : redo, to = back ? redo : undo;
    if (!from.length) { return; }
    cancelGesture(); to.push(C.clone(map())); store.maps[store.maps.findIndex(m => m.id === mapId)] = from.pop();
    selectedPoint = null; selectedRoute = null; graphLinkFrom = null; persist(); renderMap(); renderScenario();
  }
  function safeName(value) { return (value || "下書き").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 100); }
  function downloadBlob(blob, name) {
    if (!unlocked()) { return; }
    const url = URL.createObjectURL(blob), link = el("a", null, { href: url, download: name });
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function downloadText(text, name, type = "text/plain;charset=utf-8") { downloadBlob(new Blob([text], { type }), name); }
  function exportPack(kind) {
    const current = kind === "map" ? { version: 1, maps: [map()], scenarios: [] } :
      { version: 1, maps: store.maps.filter(m => scenario().mapIds.includes(m.id)), scenarios: [scenario()] };
    C.validateStore(current);
    downloadText(JSON.stringify({ schema: "hoshimichi.authoring/1", ...current }, null, 2), safeName(kind === "map" ? map().name : scenario().name) + "_KP下書き.json", "application/json");
  }
  async function importFile(file) {
    const started = epoch;
    if (!file || file.size > MAX_FILE) { status("5MB以下の下書きJSONを選んでください。", true); return; }
    try {
      const source = JSON.parse(await file.text());
      if (!unlocked() || started !== epoch) { return; }
      if (source.schema !== "hoshimichi.authoring/1") { throw new Error("この制作タブの下書きJSONではありません。"); }
      const incoming = C.validateStore(source);
      if (!incoming.maps.length && !incoming.scenarios.length) { throw new Error("下書きが入っていません。"); }
      if (!window.confirm("マップ" + incoming.maps.length + "件・シナリオ" + incoming.scenarios.length + "件を別の下書きとして追加しますか？現在の下書きは残ります。")) { return; }
      const ids = new Map();
      incoming.maps.forEach(m => { const old = m.id; m.id = uid(); ids.set(old, m.id); });
      incoming.scenarios.forEach(s => { s.id = uid(); s.mapIds = s.mapIds.map(id => ids.get(id)); });
      const merged = { version: 1, maps: [...store.maps, ...incoming.maps], scenarios: [...store.scenarios, ...incoming.scenarios] };
      C.validateStore(merged); store = merged;
      if (incoming.maps.length) { mapId = incoming.maps[0].id; }
      if (incoming.scenarios.length) { scenarioId = incoming.scenarios[0].id; }
      undo = []; redo = []; selectedPoint = null; selectedRoute = null; graphLinkFrom = null; persist(); renderMap(); renderScenario();
    } catch (error) { if (unlocked() && started === epoch) { status("読込できません：" + error.message, true); } }
  }
  async function copy(text) {
    const started = epoch;
    try { await navigator.clipboard.writeText(text); if (unlocked() && started === epoch) { status("制作依頼をコピーしました。", false); } }
    catch (error) {
      if (!unlocked() || started !== epoch) { return; }
      const dialog = byId("manual-copy-dialog"), input = byId("manual-copy-text");
      input.value = text; dialog.showModal(); input.focus(); input.select();
    }
  }
  function heading(parent, title, kind) {
    const head = el("div", null, { class: "authoring-head" }); append(head, el("h2", title));
    const actions = el("div", null, { class: "authoring-toolbar" });
    button(actions, "下書きJSONを読込", () => byId(kind + "-import").click());
    button(actions, "下書きJSONを出力", () => exportPack(kind));
    button(actions, "ロック", () => window.characterSheetBuilder.exitKpMode());
    const input = el("input", null, { id: kind + "-import", type: "file", accept: ".json,application/json", hidden: true });
    input.addEventListener("change", () => { if (unlocked()) { importFile(input.files[0]); input.value = ""; } });
    append(head, actions, input); parent.append(head);
    parent.append(el("p", statusText, { class: "authoring-status" + (statusError ? " is-error" : ""), role: "status" }));
    const row = el("div", null, { class: "authoring-row" });
    field(row, "保存した下書き", kind + "-drafts", kind === "map" ? mapId : scenarioId, id => {
      cancelGesture(); if (kind === "map") { mapId = id; undo = []; redo = []; selectedPoint = null; selectedRoute = null; graphLinkFrom = null; pendingProposal = null; renderMap(); } else { scenarioId = id; renderScenario(); }
    }, { choices: (kind === "map" ? store.maps : store.scenarios).map(item => [item.id, item.name || "名前未入力"]) });
    button(row, "新規", () => {
      const collection = kind === "map" ? store.maps : store.scenarios;
      if (collection.length >= 100) { throw new Error("下書きは各100件までです。JSONへ退避してください。"); }
      const next = kind === "map" ? C.newGraphMap(uid()) : C.newScenario(uid()); collection.push(next);
      if (kind === "map") { mapId = next.id; undo = []; redo = []; selectedPoint = null; selectedRoute = null; } else { scenarioId = next.id; }
      persist(); renderMap(); renderScenario();
    });
    button(row, "複製", () => {
      const collection = kind === "map" ? store.maps : store.scenarios;
      if (collection.length >= 100) { throw new Error("下書きは各100件までです。"); }
      const next = C.clone(kind === "map" ? map() : scenario()); next.id = uid(); next.name += "（複製）";
      collection.push(next); if (kind === "map") { mapId = next.id; undo = []; redo = []; graphLinkFrom = null; pendingProposal = null; } else { scenarioId = next.id; }
      persist(); renderMap(); renderScenario();
    });
    button(row, "削除", () => {
      const item = kind === "map" ? map() : scenario();
      const linked = kind === "map" && store.scenarios.some(s => s.mapIds.includes(item.id));
      if (!window.confirm("「" + item.name + "」を削除しますか？" + (linked ? "シナリオとの紐づけも解除します。" : ""))) { return; }
      if (kind === "map") {
        store.maps = store.maps.filter(m => m.id !== item.id); store.scenarios.forEach(s => { s.mapIds = s.mapIds.filter(id => id !== item.id); });
        if (!store.maps.length) { store.maps.push(C.newGraphMap(uid())); } mapId = store.maps[0].id; undo = []; redo = []; selectedPoint = null; selectedRoute = null; graphLinkFrom = null; pendingProposal = null;
      } else { store.scenarios = store.scenarios.filter(s => s.id !== item.id); if (!store.scenarios.length) { store.scenarios.push(C.newScenario(uid())); } scenarioId = store.scenarios[0].id; }
      persist(); renderMap(); renderScenario();
    }, { class: "danger-button" });
    parent.append(row);
  }
  function renderMap() {
    if (!unlocked() || !store) { return; }
    const panel = panels.map; panel.replaceChildren(); panel.classList.remove("graph-editor-panel"); heading(panel, map().kind === "graph" ? "シナリオMAP制作" : "マップ制作（旧形式）", "map");
    if (map().kind === "graph") { renderGraphMap(panel); return; }
    const basics = el("div", null, { class: "authoring-row" });
    field(basics, "マップ名", "map-name", map().name, value => changeMap(m => { m.name = value; }), { max: 200 });
    field(basics, "1マスの距離（任意）", "map-scale", map().scale, value => changeMap(m => { m.scale = value; }), { max: 200 });
    field(basics, "横マス", "map-width", map().width, null, { type: "number", min: 4, max: 80, compact: true });
    field(basics, "縦マス", "map-height", map().height, null, { type: "number", min: 4, max: 80, compact: true });
    button(basics, "サイズ変更", () => {
      const width = Number(byId("map-width").value), height = Number(byId("map-height").value);
      const next = C.resize(map(), width, height);
      if ((width < map().width || height < map().height) && !window.confirm("範囲外の地形・地点・ルートが除かれます。縮小しますか？取り消しは可能です。")) { return; }
      changeMap(m => Object.assign(m, next)); selectedPoint = null; selectedRoute = null; renderMap(); renderScenario();
    }); panel.append(basics);
    const tools = el("div", null, { class: "authoring-toolbar" });
    button(tools, "↶", () => history(true), { id: "map-undo", class: "secondary-button authoring-icon", title: "取り消し", "aria-label": "取り消し" });
    button(tools, "↷", () => history(false), { id: "map-redo", class: "secondary-button authoring-icon", title: "やり直し", "aria-label": "やり直し" });
    const modes = el("fieldset", null, { class: "authoring-tools" }); modes.append(el("legend", "描画"));
    [["brush", "ペン"], ["rect", "長方形"], ["room", "部屋"], ["fill", "塗りつぶし"], ["point", "地点"], ["pan", "移動"]].forEach(([value, label]) => {
      const wrap = el("label"), input = el("input", null, { type: "radio", name: "map-tool", value }); input.checked = mode === value;
      input.addEventListener("change", () => { cancelGesture(); mode = value; draw(); }); append(wrap, input, document.createTextNode(label)); modes.append(wrap);
    }); tools.append(modes);
    field(tools, "表示倍率", "map-zoom", String(zoom), value => { zoom = Number(value); draw(); }, { choices: [.5, .75, 1, 1.25, 1.5, 2].map(value => [String(value), value * 100 + "%"]) });
    const grid = el("label", null, { class: "inline-check" }), check = el("input", null, { type: "checkbox", id: "map-grid" }); check.checked = map().grid;
    check.addEventListener("change", () => changeMap(m => { m.grid = check.checked; })); append(grid, check, document.createTextNode("マス目")); tools.append(grid); panel.append(tools);
    const palette = el("fieldset", null, { class: "authoring-tools authoring-toolbar" }); palette.append(el("legend", "地形"));
    C.tiles.forEach((entry, i) => {
      const wrap = el("label", null, { title: i === 0 ? "地形を消す" : entry.label }), input = el("input", null, { type: "radio", name: "map-tile", value: i });
      input.checked = i === tile; input.addEventListener("change", () => { tile = i; });
      const swatch = el("span", null, { class: "map-swatch", "aria-hidden": "true" }); swatch.style.backgroundColor = entry.color;
      append(wrap, input, swatch, document.createTextNode(entry.label)); palette.append(wrap);
    }); panel.append(palette);
    const workspace = el("div", null, { class: "map-workspace" }), stage = el("div");
    const viewport = el("div", null, { id: "map-viewport", class: "map-viewport" });
    const canvas = el("canvas", null, { id: "map-canvas", tabindex: "0", "aria-label": "マップ編集。矢印キーで位置を選択、Enterで描画、地点モードでは地点を追加。" });
    viewport.append(canvas); stage.append(viewport, el("p", "", { id: "map-coordinate", class: "map-coordinate", "aria-live": "off" }));
    const actions = el("div", null, { class: "authoring-toolbar" });
    button(actions, "PNG（地形のみ）", () => exportPng(false)); button(actions, "PNG（KP用）", () => exportPng(true));
    button(actions, "制作依頼をコピー", () => { C.validateMap(map()); copy(C.mapRequest(map())); });
    button(actions, "制作依頼MD", () => { C.validateMap(map()); downloadText(C.mapRequest(map()), safeName(map().name) + "_KP制作依頼.md"); }); stage.append(actions);
    const inspector = el("aside", null, { id: "map-inspector", class: "map-inspector", "aria-label": "地点と移動ルート" });
    append(workspace, stage, inspector); panel.append(workspace);
    field(panel, "マップ全体のメモ・環境", "map-notes", map().notes, value => changeMap(m => { m.notes = value; }), { area: true });
    const output = el("details"); output.append(el("summary", "AIに渡す制作依頼（KP用）"));
    field(output, "制作依頼文", "map-output", "", null, { area: true, readonly: true }).className = "authoring-output"; panel.append(output);
    canvas.addEventListener("pointerdown", pointerDown); canvas.addEventListener("pointermove", pointerMove); canvas.addEventListener("pointerup", pointerUp);
    canvas.addEventListener("pointercancel", cancelGesture); canvas.addEventListener("lostpointercapture", () => { if (gesture) { cancelGesture(); } });
    canvas.addEventListener("keydown", event => {
      if (!unlocked()) { return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); history(!event.shiftKey); return; }
      const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (delta) { event.preventDefault(); cursor = [Math.max(0, Math.min(map().width - 1, cursor[0] + delta[0])), Math.max(0, Math.min(map().height - 1, cursor[1] + delta[1]))]; draw(); }
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (mode === "point") { selectOrCreatePoint(cursor); } else if (mode !== "pan") { changeMap(m => mode === "fill" ? C.fill(m, ...cursor, tile) : C.paintLine(m, cursor, cursor, tile)); } }
      if (event.key === "Escape") { cancelGesture(); }
    });
    renderInspector(); draw(); updateMapOutput();
  }
  function renderGraphMap(panel) {
    panel.classList.add("graph-editor-panel");
    const layout = el("div", null, { class: "graph-editor-layout" });
    const sidebar = el("aside", null, { class: "graph-sidebar", "aria-label": "シナリオと登場人物" });
    sidebar.append(el("h3", "シナリオ基本情報"));
    field(sidebar, "シナリオ名", "map-name", map().name, value => changeMap(m => { m.name = value; }), { max: 200 });
    field(sidebar, "既存SCN-ID（任意）", "graph-canon-id", map().canonId, value => changeMap(m => { m.canonId = value; }), { max: 30 });
    field(sidebar, "概要", "graph-summary", map().summary, value => changeMap(m => { m.summary = value; }), { area: true, max: 10000 });
    field(sidebar, "全体メモ", "map-notes", map().notes, value => changeMap(m => { m.notes = value; }), { area: true });
    const actors = el("section", null, { id: "graph-actors", class: "graph-sidebar-section" }); sidebar.append(actors);
    const route = el("section", null, { id: "graph-route-editor", class: "graph-sidebar-section" }); sidebar.append(route);
    const main = el("div", null, { class: "graph-main" });
    const tools = el("div", null, { class: "authoring-toolbar graph-toolbar" });
    button(tools, "↶", () => history(true), { id: "map-undo", class: "secondary-button authoring-icon", title: "取り消し", "aria-label": "取り消し" });
    button(tools, "↷", () => history(false), { id: "map-redo", class: "secondary-button authoring-icon", title: "やり直し", "aria-label": "やり直し" });
    button(tools, "+ 場所", () => {
      const viewport = byId("map-viewport");
      addGraphPoint(Math.round((viewport.scrollLeft + viewport.clientWidth / 2) / graphZoom - C.graphSize.nodeWidth / 2),
        Math.round((viewport.scrollTop + viewport.clientHeight / 2) / graphZoom - C.graphSize.nodeHeight / 2));
    });
    button(tools, "−", () => graphSetZoom(graphZoom - .2), { title: "縮小", "aria-label": "縮小", class: "secondary-button authoring-icon" });
    const zoomText = el("span", "", { id: "graph-zoom-label", class: "graph-zoom-label" }); tools.append(zoomText);
    button(tools, "+", () => graphSetZoom(graphZoom + .2), { title: "拡大", "aria-label": "拡大", class: "secondary-button authoring-icon" });
    button(tools, "AI用依頼をコピー", () => { C.validateMap(map()); copy(C.sceneMapPrompt(map())); });
    main.append(tools);
    const viewport = el("div", null, { id: "map-viewport", class: "map-viewport graph-viewport" });
    const spacer = el("div", null, { id: "graph-spacer", class: "graph-spacer" });
    const surface = el("div", null, { id: "graph-surface", class: "graph-surface", "aria-label": "場所ノードMAP" });
    surface.addEventListener("pointerdown", graphPanDown);
    surface.addEventListener("pointermove", graphPanMove);
    surface.addEventListener("pointerup", graphPanUp);
    surface.addEventListener("pointercancel", cancelGesture);
    surface.addEventListener("dblclick", event => {
      if (!unlocked() || event.target !== surface) { return; }
      const rect = surface.getBoundingClientRect(), size = C.graphSize;
      addGraphPoint(Math.round((event.clientX - rect.left) / graphZoom - size.nodeWidth / 2),
        Math.round((event.clientY - rect.top) / graphZoom - size.nodeHeight / 2));
    });
    viewport.addEventListener("wheel", graphWheel, { passive: false });
    spacer.append(surface); viewport.append(spacer); main.append(viewport);
    main.append(el("p", "", { id: "graph-status", class: "map-coordinate", role: "status" }));
    const ai = el("details", null, { class: "graph-ai-panel" }); ai.append(el("summary", "AIのMAP案を確認・採用"));
    field(ai, "AIの返答JSON", "graph-ai-json", "", null, { area: true, max: MAX_FILE });
    const aiActions = el("div", null, { class: "authoring-toolbar" });
    button(aiActions, "案を確認", previewGraphProposal);
    const adopt = button(aiActions, "確認した案を採用", adoptGraphProposal, { id: "graph-ai-adopt" }); adopt.disabled = true;
    ai.append(aiActions, el("pre", "", { id: "graph-ai-preview", class: "graph-ai-preview" })); main.append(ai);
    const output = el("details", null, { class: "graph-output" }); output.append(el("summary", "KP用MAPテキスト"));
    const outputActions = el("div", null, { class: "authoring-toolbar" });
    button(outputActions, "コピー", () => { C.validateMap(map()); copy(C.mapRequest(map())); });
    button(outputActions, "MD出力", () => { C.validateMap(map()); downloadText(C.mapRequest(map()), safeName(map().name) + "_KP制作依頼.md"); });
    output.append(outputActions);
    field(output, "MAP文", "map-output", "", null, { area: true, readonly: true }).className = "authoring-output"; main.append(output);
    append(layout, sidebar, main); panel.append(layout);
    renderGraphActors(); renderGraphRoute(); drawGraph(); updateMapOutput();
    frameGraphStart();
    byId("graph-ai-json").addEventListener("input", () => { pendingProposal = null; byId("graph-ai-adopt").disabled = true; byId("graph-ai-preview").textContent = ""; });
  }
  function frameGraphStart() {
    const viewport = byId("map-viewport"), first = map() && map().points[0];
    if (!viewport || !viewport.clientWidth || !first || viewport.scrollLeft || viewport.scrollTop) { return; }
    viewport.scrollLeft = Math.max(0, first.x * graphZoom - viewport.clientWidth * .2);
    viewport.scrollTop = Math.max(0, first.y * graphZoom - viewport.clientHeight * .25);
  }
  function graphSetZoom(value, clientX, clientY) {
    const viewport = byId("map-viewport"); if (!viewport) { return; }
    const rect = viewport.getBoundingClientRect(), old = graphZoom;
    const x = clientX === undefined ? rect.width / 2 : clientX - rect.left;
    const y = clientY === undefined ? rect.height / 2 : clientY - rect.top;
    graphZoom = Math.max(.4, Math.min(1.8, Math.round(value * 100) / 100));
    if (graphZoom === old) { return; }
    const nextX = (viewport.scrollLeft + x) * graphZoom / old - x;
    const nextY = (viewport.scrollTop + y) * graphZoom / old - y;
    drawGraph();
    viewport.scrollLeft = nextX; viewport.scrollTop = nextY;
  }
  function graphWheel(event) {
    if (!unlocked() || !event.deltaY) { return; }
    const node = event.target.closest(".graph-node");
    if (node) {
      event.preventDefault();
      const body = node.querySelector(".graph-node-body");
      const textarea = event.target.closest("textarea");
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1;
      const delta = event.deltaY * scale;
      const canScroll = element => element && element.scrollHeight > element.clientHeight + 1 &&
        (delta < 0 ? element.scrollTop > 0 : element.scrollTop + element.clientHeight < element.scrollHeight - 1);
      const target = canScroll(textarea) ? textarea : body;
      if (target) { target.scrollTop += delta; }
      return;
    }
    event.preventDefault();
    graphSetZoom(graphZoom + (event.deltaY < 0 ? .1 : -.1), event.clientX, event.clientY);
  }
  function graphPanDown(event) {
    if (!unlocked() || event.target !== event.currentTarget || gesture || event.button !== 0) { return; }
    event.preventDefault();
    const viewport = byId("map-viewport");
    gesture = { mode: "graph-pan", pointer: event.pointerId, client: [event.clientX, event.clientY], scroll: [viewport.scrollLeft, viewport.scrollTop] };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function graphPanMove(event) {
    if (!gesture || gesture.mode !== "graph-pan" || gesture.pointer !== event.pointerId) { return; }
    const viewport = byId("map-viewport");
    viewport.scrollLeft = gesture.scroll[0] + gesture.client[0] - event.clientX;
    viewport.scrollTop = gesture.scroll[1] + gesture.client[1] - event.clientY;
  }
  function graphPanUp(event) {
    if (!gesture || gesture.mode !== "graph-pan" || gesture.pointer !== event.pointerId) { return; }
    gesture = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) { event.currentTarget.releasePointerCapture(event.pointerId); }
  }
  function renderGraphActors() {
    const panel = byId("graph-actors"); if (!panel || !map() || map().kind !== "graph") { return; }
    panel.replaceChildren(el("h3", "登場人物・初期配置案"));
    button(panel, "+ 人物", () => {
      if (map().actors.length >= 200) { throw new Error("登場人物は200人までです。"); }
      changeMap(m => m.actors.push({ id: uid(), name: "新しい人物", kind: "npc", species: "", initialNodeId: selectedPoint || "", goal: "" }));
      renderGraphActors();
    });
    map().actors.forEach((actor, i) => {
      const section = el("section", null, { class: "graph-actor" });
      const title = el("h4", (i + 1) + ". " + actor.name, { draggable: true, title: "場所ノードへドラッグして初期配置" });
      title.addEventListener("dragstart", event => { event.dataTransfer.setData("application/x-hoshimichi-actor", actor.id); event.dataTransfer.effectAllowed = "move"; });
      section.append(title);
      field(section, "名前", "graph-actor-name-" + i, actor.name, value => {
        changeMap(m => { m.actors.find(item => item.id === actor.id).name = value; });
        section.querySelector("h4").textContent = (i + 1) + ". " + value;
      }, { max: 200 });
      field(section, "区分", "graph-actor-kind-" + i, actor.kind, value => changeMap(m => { m.actors.find(item => item.id === actor.id).kind = value; }),
        { choices: [["pc", "PC"], ["npc", "NPC"], ["enemy", "敵・モンスター"]] });
      field(section, "種族・分類", "graph-actor-species-" + i, actor.species, value => changeMap(m => { m.actors.find(item => item.id === actor.id).species = value; }), { max: 200 });
      field(section, "初期位置", "graph-actor-place-" + i, actor.initialNodeId, value => changeMap(m => { m.actors.find(item => item.id === actor.id).initialNodeId = value; }),
        { choices: [["", "未配置"], ...map().points.map(point => [point.id, point.name])] });
      field(section, "目的・行動の軸", "graph-actor-goal-" + i, actor.goal, value => changeMap(m => { m.actors.find(item => item.id === actor.id).goal = value; }), { area: true, max: 3000 });
      button(section, "削除", () => {
        if (!window.confirm("「" + actor.name + "」を初期配置案から削除しますか？")) { return; }
        changeMap(m => { m.actors = m.actors.filter(item => item.id !== actor.id); }); renderGraphActors();
      }, { class: "danger-button" });
      panel.append(section);
    });
  }
  function renderGraphRoute() {
    const panel = byId("graph-route-editor"); if (!panel || !map() || map().kind !== "graph") { return; }
    panel.replaceChildren(el("h3", "接続・移動条件"));
    field(panel, "接続", "map-route-select", selectedRoute || "", id => { selectedRoute = id || null; renderGraphRoute(); drawGraph(); },
      { choices: [["", "未選択"], ...map().routes.map((r, i) => [r.id, (i + 1) + ". " + map().points.find(p => p.id === r.from).name + (r.oneWay ? " → " : " ↔ ") + map().points.find(p => p.id === r.to).name])] });
    const route = map().routes.find(r => r.id === selectedRoute);
    if (!route) { return; }
    const direction = el("label", null, { class: "inline-check" }), check = el("input", null, { type: "checkbox", id: "graph-route-one-way" });
    check.checked = route.oneWay; check.addEventListener("change", () => { changeMap(m => { m.routes.find(r => r.id === selectedRoute).oneWay = check.checked; }); renderGraphRoute(); });
    append(direction, check, document.createTextNode("一方通行")); panel.append(direction);
    const condition = field(panel, "通行必須条件（未達なら移動不可）", "graph-route-condition", route.condition,
      value => changeMap(m => { m.routes.find(r => r.id === selectedRoute).condition = value; }), { area: true, max: 3000 });
    condition.placeholder = "例：鍵を開けないと扉を通れない。条件がなければ空欄";
    [["distance", "距離の目安"], ["time", "徒歩所要時間（分の目安）"], ["roughness", "険しさ"], ["notes", "補足"]].forEach(([key, label]) =>
      field(panel, label, "graph-route-" + key, route[key], value => changeMap(m => { m.routes.find(r => r.id === selectedRoute)[key] = value; }), { area: key === "notes", max: key === "notes" ? 10000 : 300 }));
    byId("graph-route-time").placeholder = "例：約4分";
    button(panel, "接続を削除", () => { changeMap(m => { m.routes = m.routes.filter(r => r.id !== selectedRoute); }); selectedRoute = null; renderGraphRoute(); }, { class: "danger-button" });
  }
  function previewGraphProposal() {
    const raw = byId("graph-ai-json").value;
    if (raw.length > MAX_FILE) { throw new Error("AI案は5MB以下にしてください。"); }
    const proposal = C.validateSceneMapProposal(JSON.parse(raw), map());
    const before = map();
    const differences = (oldItems, nextItems, label) => {
      const oldById = new Map(oldItems.map(item => [item.id, item]));
      const nextById = new Map(nextItems.map(item => [item.id, item]));
      return label + "：追加 " + (nextItems.filter(item => !oldById.has(item.id)).map(item => item.name || item.id).join("、") || "なし") +
        " / 削除 " + (oldItems.filter(item => !nextById.has(item.id)).map(item => item.name || item.id).join("、") || "なし") +
        " / 変更 " + (nextItems.filter(item => oldById.has(item.id) && JSON.stringify(oldById.get(item.id)) !== JSON.stringify(item)).map(item => item.name || item.id).join("、") || "なし");
    };
    pendingProposal = { baseline: JSON.stringify(before), map: proposal };
    byId("graph-ai-preview").textContent = ["シナリオ：" + proposal.name,
      "場所：" + before.points.length + " → " + proposal.points.length + " / 接続：" + before.routes.length + " → " + proposal.routes.length,
      "人物：" + before.actors.length + " → " + proposal.actors.length,
      differences(before.points, proposal.points, "場所"), differences(before.routes, proposal.routes, "接続"), differences(before.actors, proposal.actors, "人物"),
      "基本情報：" + (["name", "canonId", "summary", "notes"].some(key => before[key] !== proposal[key]) ? "変更あり" : "変更なし"),
      "採用すると、このシナリオMAP下書き全体を置き換えます。"].join("\n");
    byId("graph-ai-adopt").disabled = false;
  }
  function adoptGraphProposal() {
    if (!pendingProposal) { throw new Error("先にAI案を確認してください。"); }
    if (pendingProposal.baseline !== JSON.stringify(map())) { pendingProposal = null; byId("graph-ai-adopt").disabled = true; throw new Error("確認後にMAPが変わりました。AI案を再確認してください。"); }
    if (!window.confirm("確認したAI案を採用し、現在のMAP下書きを置き換えますか？取り消しは可能です。")) { return; }
    const before = C.clone(map()); store.maps[store.maps.findIndex(m => m.id === mapId)] = pendingProposal.map;
    pendingProposal = null; pushUndo(before); selectedPoint = null; selectedRoute = null; graphLinkFrom = null;
    persist(); renderMap(); renderScenario();
  }
  function addGraphPoint(x, y) {
    if (map().points.length >= 200) { status("地点は200件までです。", true); return; }
    const size = C.graphSize, id = uid();
    const clampX = value => Math.max(0, Math.min(size.width - size.nodeWidth, value));
    const clampY = value => Math.max(0, Math.min(size.height - size.nodeHeight, value));
    const baseX = clampX(x), baseY = clampY(y);
    let place = [baseX, baseY];
    for (let ring = 0; ring <= 6; ring++) {
      let found = false;
      for (let row = -ring; row <= ring && !found; row++) {
        for (let col = -ring; col <= ring; col++) {
          if (Math.max(Math.abs(row), Math.abs(col)) !== ring) { continue; }
          const px = clampX(baseX + col * (size.nodeWidth + 50));
          const py = clampY(baseY + row * (size.nodeHeight + 35));
          if (map().points.every(point => Math.abs(point.x - px) >= size.nodeWidth + 20 || Math.abs(point.y - py) >= size.nodeHeight + 20)) {
            place = [px, py]; found = true; break;
          }
        }
      }
      if (found) { break; }
    }
    changeMap(m => { m.points.push(Object.assign(Object.fromEntries(C.pointFields.map(key => [key, ""])),
      { id, name: "場所" + (m.points.length + 1), eventIdeas: [],
        x: place[0], y: place[1] })); });
    selectedPoint = id; selectedRoute = null; renderGraphActors(); drawGraph();
  }
  function connectGraphNodes(from, to) {
    graphLinkFrom = null;
    if (from === to) { drawGraph(); return; }
    if (map().routes.length >= 300) { status("接続は300件までです。", true); drawGraph(); return; }
    if (map().routes.some(r => (r.from === from && r.to === to) || (!r.oneWay && r.from === to && r.to === from))) {
      status("この場所どうしは接続済みです。", true); drawGraph(); return;
    }
    const routeId = uid();
    changeMap(m => { m.routes.push({ id: routeId, from, to, distance: "", time: "", roughness: "", notes: "", condition: "", oneWay: false }); });
    selectedPoint = null; selectedRoute = routeId; renderGraphRoute(); drawGraph();
  }
  function graphPortDown(event, id) {
    if (!unlocked() || gesture || event.button !== 0) { return; }
    event.stopPropagation(); event.preventDefault();
    gesture = { mode: "graph-link", pointer: event.pointerId, from: graphLinkFrom || id, client: [event.clientX, event.clientY] };
    event.currentTarget.setPointerCapture(event.pointerId);
    graphLinkFrom = gesture.from; drawGraphEdges();
  }
  function graphPortMove(event) {
    if (!gesture || gesture.mode !== "graph-link" || gesture.pointer !== event.pointerId) { return; }
    gesture.client = [event.clientX, event.clientY];
    const preview = byId("graph-link-preview"), source = map().points.find(p => p.id === gesture.from), surface = byId("graph-surface");
    if (!preview || !source || !surface) { return; }
    const rect = surface.getBoundingClientRect(), x = (event.clientX - rect.left) / graphZoom, y = (event.clientY - rect.top) / graphZoom;
    const ax = source.x + C.graphSize.nodeWidth / 2, ay = source.y + C.graphSize.nodeHeight / 2;
    preview.setAttribute("d", `M ${ax} ${ay} L ${x} ${y}`);
  }
  function graphPortUp(event) {
    if (!gesture || gesture.mode !== "graph-link" || gesture.pointer !== event.pointerId) { return; }
    const from = gesture.from; gesture = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) { event.currentTarget.releasePointerCapture(event.pointerId); }
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".graph-node");
    const targetId = target && target.dataset.pointId;
    if (targetId && targetId !== from) { connectGraphNodes(from, targetId); }
    else { graphLinkFrom = from; drawGraphEdges(); byId("graph-status").textContent = "接続元：" + (map().points.find(p => p.id === from)?.name || ""); }
  }
  function graphNodeDown(event, id) {
    if (!unlocked() || gesture || event.button !== 0) { return; }
    const point = map().points.find(p => p.id === id); if (!point) { return; }
    event.preventDefault(); selectedPoint = id; selectedRoute = null;
    gesture = { mode: "graph-drag", pointer: event.pointerId, before: C.clone(map()), id,
      client: [event.clientX, event.clientY], origin: [point.x, point.y], moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function graphNodeMove(event) {
    if (!gesture || gesture.mode !== "graph-drag" || gesture.pointer !== event.pointerId || !unlocked()) { return; }
    const point = map().points.find(p => p.id === gesture.id), size = C.graphSize;
    const dx = (event.clientX - gesture.client[0]) / graphZoom, dy = (event.clientY - gesture.client[1]) / graphZoom;
    if (Math.abs(dx) + Math.abs(dy) < 3 && !gesture.moved) { return; }
    gesture.moved = true;
    point.x = Math.max(0, Math.min(size.width - size.nodeWidth, Math.round(gesture.origin[0] + dx)));
    point.y = Math.max(0, Math.min(size.height - size.nodeHeight, Math.round(gesture.origin[1] + dy)));
    event.currentTarget.parentElement.style.left = point.x + "px"; event.currentTarget.parentElement.style.top = point.y + "px";
    drawGraphEdges();
  }
  function graphNodeUp(event) {
    if (!gesture || gesture.mode !== "graph-drag" || gesture.pointer !== event.pointerId) { return; }
    const current = gesture; gesture = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) { event.currentTarget.releasePointerCapture(event.pointerId); }
    if (current.moved) { pushUndo(current.before); saveMap(); }
    drawGraph();
  }
  function svgElement(tag, attrs) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  }
  function drawGraphEdges() {
    const svg = byId("graph-links"); if (!svg || !map() || map().kind !== "graph") { return; }
    svg.replaceChildren();
    const size = C.graphSize, defs = svgElement("defs", {}), marker = svgElement("marker", { id: "graph-arrow", markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: "auto" });
    marker.append(svgElement("path", { d: "M 0 0 L 8 4 L 0 8 z", fill: "#63b7a8" })); defs.append(marker); svg.append(defs);
    map().routes.forEach(route => {
      const from = map().points.find(p => p.id === route.from), to = map().points.find(p => p.id === route.to);
      if (!from || !to) { return; }
      const forward = to.x >= from.x;
      const ax = from.x + (forward ? size.nodeWidth : 0), ay = from.y + 70;
      const bx = to.x + (forward ? 0 : size.nodeWidth), by = to.y + 70;
      const bend = Math.max(65, Math.abs(bx - ax) * .45), sign = forward ? 1 : -1;
      const d = `M ${ax} ${ay} C ${ax + sign * bend} ${ay} ${bx - sign * bend} ${by} ${bx} ${by}`;
      const line = svgElement("path", { d, class: route.id === selectedRoute ? "graph-edge is-selected" : "graph-edge" });
      if (route.oneWay) { line.setAttribute("marker-end", "url(#graph-arrow)"); }
      const hit = svgElement("path", { d, class: "graph-edge-hit", role: "button", tabindex: 0, "aria-label": from.name + (route.oneWay ? "から" : "と") + to.name + "の接続" });
      const select = event => { event.stopPropagation(); graphLinkFrom = null; selectedPoint = null; selectedRoute = route.id; renderGraphRoute(); drawGraph(); };
      hit.addEventListener("click", select);
      hit.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(event); } });
      svg.append(line, hit);
      const hasGate = C.hasRequiredPassageCondition(route.condition), labelX = (ax + bx) / 2;
      const label = svgElement("text", { x: labelX, y: (ay + by) / 2 - (hasGate ? 18 : 10), class: "graph-edge-label" });
      const time = svgElement("tspan", { x: labelX, dy: 0 });
      time.textContent = route.time.trim() || "徒歩時間未定"; label.append(time);
      if (hasGate) {
        const gate = svgElement("tspan", { x: labelX, dy: 19, class: "graph-edge-condition" });
        gate.textContent = "条件あり"; label.append(gate);
      }
      svg.append(label);
    });
    if (graphLinkFrom) { svg.append(svgElement("path", { id: "graph-link-preview", class: "graph-link-preview", d: "" })); }
  }
  function drawGraph() {
    const surface = byId("graph-surface"); if (!surface || !unlocked() || !map() || map().kind !== "graph") { return; }
    const size = C.graphSize, spacer = byId("graph-spacer");
    spacer.style.width = size.width * graphZoom + "px"; spacer.style.height = size.height * graphZoom + "px";
    surface.style.transform = `scale(${graphZoom})`;
    surface.replaceChildren();
    const svg = svgElement("svg", { id: "graph-links", width: size.width, height: size.height, viewBox: `0 0 ${size.width} ${size.height}`, "aria-label": "地点間のルート" });
    surface.append(svg); drawGraphEdges();
    map().points.forEach((point, i) => {
      const node = el("section", null, { class: "graph-node" + (point.id === selectedPoint ? " is-selected" : "") + (point.id === graphLinkFrom ? " is-link-origin" : ""),
        "data-point-id": point.id, "aria-label": "場所" + (i + 1) + " " + point.name });
      node.style.left = point.x + "px"; node.style.top = point.y + "px";
      for (const side of ["left", "right"]) {
        const port = el("button", null, { type: "button", class: "graph-port graph-port-" + side,
          title: "接続端子", "aria-label": point.name + "の接続端子" });
        port.addEventListener("pointerdown", event => graphPortDown(event, point.id));
        port.addEventListener("pointermove", graphPortMove);
        port.addEventListener("pointerup", graphPortUp);
        port.addEventListener("pointercancel", cancelGesture);
        node.append(port);
      }
      const header = el("div", null, { class: "graph-node-drag", tabindex: 0, role: "button", "aria-label": point.name + "を移動" });
      header.append(el("span", String(i + 1), { class: "graph-node-number" }), el("span", "場所", { class: "graph-node-type" }));
      header.addEventListener("pointerdown", event => graphNodeDown(event, point.id));
      header.addEventListener("pointermove", graphNodeMove);
      header.addEventListener("pointerup", graphNodeUp);
      header.addEventListener("pointercancel", cancelGesture);
      header.addEventListener("lostpointercapture", () => { if (gesture && gesture.mode === "graph-drag") { cancelGesture(); } });
      header.addEventListener("keydown", event => {
        const shift = event.shiftKey ? 64 : 16, delta = { ArrowLeft: [-shift, 0], ArrowRight: [shift, 0], ArrowUp: [0, -shift], ArrowDown: [0, shift] }[event.key];
        if (!delta) { return; } event.preventDefault();
        changeMap(m => { const p = m.points.find(item => item.id === point.id);
          p.x = Math.max(0, Math.min(size.width - size.nodeWidth, p.x + delta[0]));
          p.y = Math.max(0, Math.min(size.height - size.nodeHeight, p.y + delta[1])); });
      });
      node.append(header);
      const body = el("div", null, { class: "graph-node-body" });
      const nameLabel = el("label", "場所名", { for: "graph-name-" + i });
      const name = el("input", null, { id: "graph-name-" + i, type: "text", maxlength: 200, value: point.name });
      name.value = point.name; bindGraphNodeInput(name, point.id, value => { map().points.find(p => p.id === point.id).name = value; });
      const situationLabel = el("label", "状況", { for: "graph-situation-" + i });
      const situation = el("textarea", null, { id: "graph-situation-" + i, maxlength: 10000, rows: 3 });
      situation.value = point.contents;
      bindGraphNodeInput(situation, point.id, value => { map().points.find(p => p.id === point.id).contents = value; });
      body.append(nameLabel, name, situationLabel, situation);
      const events = el("div", null, { class: "graph-node-events" });
      events.append(el("span", "イベント案", { class: "graph-node-label" }));
      point.eventIdeas.forEach((idea, index) => {
        const row = el("div", null, { class: "graph-event-row" });
        const input = el("textarea", null, { maxlength: 3000, rows: 2, "aria-label": point.name + "のイベント案" + (index + 1) });
        input.value = idea;
        bindGraphNodeInput(input, point.id, value => { map().points.find(p => p.id === point.id).eventIdeas[index] = value; });
        const remove = button(row, "×", () => { changeMap(m => { m.points.find(p => p.id === point.id).eventIdeas.splice(index, 1); }); },
          { title: "イベント案を削除", "aria-label": "イベント案を削除" });
        row.insertBefore(input, remove); events.append(row);
      });
      button(events, "+ 案", () => {
        if (map().points.find(p => p.id === point.id).eventIdeas.length >= 30) { throw new Error("イベント案は1地点30件までです。"); }
        changeMap(m => { m.points.find(p => p.id === point.id).eventIdeas.push(""); });
      });
      body.append(events);
      const assigned = map().actors.filter(actor => actor.initialNodeId === point.id);
      if (assigned.length) { body.append(el("div", assigned.map(actor => actor.name).join("、"), { class: "graph-node-actors", title: "初期配置案" })); }
      button(body, "場所を削除", () => {
        if (!window.confirm("「" + point.name + "」と接続を削除しますか？初期配置中の人物は未配置になります。")) { return; }
        changeMap(m => {
          m.points = m.points.filter(p => p.id !== point.id);
          m.routes = m.routes.filter(r => r.from !== point.id && r.to !== point.id);
          m.actors.forEach(actor => { if (actor.initialNodeId === point.id) { actor.initialNodeId = ""; } });
        });
        selectedPoint = null; selectedRoute = null; graphLinkFrom = null; renderGraphActors(); renderGraphRoute();
      }, { class: "graph-node-delete" });
      node.append(body);
      node.addEventListener("dragover", event => { if (event.dataTransfer.types.includes("application/x-hoshimichi-actor")) { event.preventDefault(); } });
      node.addEventListener("drop", event => {
        const actorId = event.dataTransfer.getData("application/x-hoshimichi-actor");
        if (!map().actors.some(actor => actor.id === actorId)) { return; }
        event.preventDefault(); changeMap(m => { m.actors.find(actor => actor.id === actorId).initialNodeId = point.id; }); renderGraphActors();
      });
      surface.append(node);
    });
    const origin = map().points.find(p => p.id === graphLinkFrom);
    byId("graph-status").textContent = origin ? "接続元：" + origin.name :
      "場所 " + map().points.length + " / 接続 " + map().routes.length + " / 登場人物 " + map().actors.length;
    byId("graph-zoom-label").textContent = Math.round(graphZoom * 100) + "%";
    byId("map-undo").disabled = !undo.length; byId("map-redo").disabled = !redo.length;
  }
  function bindGraphNodeInput(input, pointId, assign) {
    let before = null;
    input.addEventListener("focus", () => { before = C.clone(map()); selectedPoint = pointId; });
    input.addEventListener("input", () => {
      if (!unlocked()) { return; }
      assign(input.value); persist(); updateMapOutput(); updateScenarioOutput();
    });
    input.addEventListener("blur", () => {
      if (!before || !unlocked()) { return; }
      pushUndo(before); before = null; drawGraphEdges(); renderGraphActors(); renderGraphRoute();
      byId("map-undo").disabled = !undo.length; byId("map-redo").disabled = !redo.length;
    });
  }
  function pointAt(event) {
    const canvas = byId("map-canvas"), rect = canvas.getBoundingClientRect();
    return [Math.max(0, Math.min(map().width - 1, Math.floor((event.clientX - rect.left) / rect.width * map().width))),
      Math.max(0, Math.min(map().height - 1, Math.floor((event.clientY - rect.top) / rect.height * map().height)))];
  }
  function pointerDown(event) {
    if (!unlocked() || gesture || event.button !== 0) { return; } event.preventDefault();
    cursor = pointAt(event);
    if (mode === "point") { selectOrCreatePoint(cursor); return; }
    if (mode === "fill") { changeMap(m => C.fill(m, ...cursor, tile)); return; }
    const viewport = byId("map-viewport");
    gesture = { pointer: event.pointerId, before: C.clone(map()), start: cursor.slice(), last: cursor.slice(), mode, tile,
      client: [event.clientX, event.clientY], scroll: [viewport.scrollLeft, viewport.scrollTop] };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (mode === "brush") { C.paintLine(map(), cursor, cursor, tile); } draw();
  }
  function pointerMove(event) {
    if (!unlocked()) { return; } cursor = pointAt(event);
    if (gesture && event.pointerId === gesture.pointer) {
      if (gesture.mode === "pan") {
        byId("map-viewport").scrollLeft = gesture.scroll[0] + gesture.client[0] - event.clientX;
        byId("map-viewport").scrollTop = gesture.scroll[1] + gesture.client[1] - event.clientY;
      } else if (gesture.mode === "brush") { C.paintLine(map(), gesture.last, cursor, gesture.tile); }
      gesture.last = cursor.slice();
    }
    draw();
  }
  function pointerUp(event) {
    if (!gesture || gesture.pointer !== event.pointerId) { return; }
    const current = gesture; gesture = null;
    if (current.mode === "rect" || current.mode === "room") { C.rectangle(map(), current.start, pointAt(event), current.tile, current.mode === "room"); }
    pushUndo(current.before); saveMap();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) { event.currentTarget.releasePointerCapture(event.pointerId); }
  }
  function cancelGesture() {
    if (!gesture) { return; }
    if (gesture.before && map()) { Object.assign(map(), gesture.before); }
    if (gesture.mode === "graph-link") { graphLinkFrom = null; }
    gesture = null; draw();
  }
  function drawCanvas(canvas, data, cell, overlay, showCursor) {
    canvas.width = Math.round(data.width * cell); canvas.height = Math.round(data.height * cell);
    const context = canvas.getContext("2d");
    data.cells.forEach((kind, i) => {
      const x = i % data.width * cell, y = Math.floor(i / data.width) * cell;
      context.fillStyle = C.tiles[kind].color; context.fillRect(x, y, cell, cell);
      context.strokeStyle = kind === 2 ? "#9298a0" : "#244a3990"; context.lineWidth = Math.max(1, cell / 24);
      if (kind === 2) { context.beginPath(); context.moveTo(x, y + cell / 2); context.lineTo(x + cell, y + cell / 2); context.moveTo(x + cell / 2, y); context.lineTo(x + cell / 2, y + cell / 2); context.stroke(); }
      if (kind === 5 || kind === 7) { context.beginPath(); context.moveTo(x + cell * .2, y + cell * .75); context.lineTo(x + cell / 2, y + cell * .2); context.lineTo(x + cell * .8, y + cell * .75); context.closePath(); context.stroke(); }
      if (kind === 6) { context.beginPath(); context.moveTo(x + cell * .1, y + cell * .6); context.bezierCurveTo(x + cell * .4, y + cell * .1, x + cell * .6, y + cell, x + cell * .9, y + cell * .5); context.stroke(); }
      if (kind === 8) { context.strokeStyle = "#572d1c"; context.strokeRect(x + cell * .25, y + cell * .12, cell * .5, cell * .76); }
    });
    if (data.grid) {
      context.strokeStyle = "#52637140"; context.lineWidth = .7; context.beginPath();
      for (let x = 0; x <= data.width; x++) { context.moveTo(x * cell, 0); context.lineTo(x * cell, canvas.height); }
      for (let y = 0; y <= data.height; y++) { context.moveTo(0, y * cell); context.lineTo(canvas.width, y * cell); } context.stroke();
    }
    if (overlay) {
      data.routes.forEach(route => {
        const from = data.points.find(p => p.id === route.from), to = data.points.find(p => p.id === route.to); if (!from || !to) { return; }
        const ax = (from.x + .5) * cell, ay = (from.y + .5) * cell, bx = (to.x + .5) * cell, by = (to.y + .5) * cell;
        context.strokeStyle = "#932d64"; context.lineWidth = 3; context.setLineDash([6, 4]); context.beginPath(); context.moveTo(ax, ay); context.lineTo(bx, by); context.stroke(); context.setLineDash([]);
        const angle = Math.atan2(by - ay, bx - ax), mx = (ax + bx) / 2, my = (ay + by) / 2;
        context.beginPath(); context.moveTo(mx - 8 * Math.cos(angle - .5), my - 8 * Math.sin(angle - .5)); context.lineTo(mx, my); context.lineTo(mx - 8 * Math.cos(angle + .5), my - 8 * Math.sin(angle + .5)); context.stroke();
      });
      data.points.forEach((point, i) => {
        const x = (point.x + .5) * cell, y = (point.y + .5) * cell;
        context.beginPath(); context.arc(x, y, Math.max(8, cell * .4), 0, Math.PI * 2); context.fillStyle = point.id === selectedPoint && showCursor ? "#a73c24" : "#35455e"; context.fill(); context.strokeStyle = "#fff"; context.lineWidth = 1.5; context.stroke();
        context.fillStyle = "#fff"; context.font = "bold " + Math.max(10, Math.round(cell * .5)) + "px sans-serif"; context.textAlign = "center"; context.textBaseline = "middle"; context.fillText(String(i + 1), x, y);
      });
    }
    if (showCursor && cursor[0] < data.width && cursor[1] < data.height) { context.strokeStyle = "#c3391c"; context.lineWidth = 2; context.strokeRect(cursor[0] * cell + 1, cursor[1] * cell + 1, cell - 2, cell - 2); }
  }
  function draw() {
    if (map() && map().kind === "graph") { drawGraph(); return; }
    const canvas = byId("map-canvas"); if (!canvas || !unlocked() || !map()) { return; }
    const data = gesture && ["rect", "room"].includes(gesture.mode) ? C.clone(map()) : map();
    if (data !== map()) { C.rectangle(data, gesture.start, gesture.last, gesture.tile, gesture.mode === "room"); }
    drawCanvas(canvas, data, 28 * zoom, true, true);
    byId("map-coordinate").textContent = "列 " + (cursor[0] + 1) + " / 行 " + (cursor[1] + 1) + "　地点 " + data.points.length + "　ルート " + data.routes.length;
    byId("map-undo").disabled = !undo.length; byId("map-redo").disabled = !redo.length;
  }
  function exportPng(overlay) {
    C.validateMap(map()); const started = epoch, data = C.clone(map()), canvas = document.createElement("canvas");
    drawCanvas(canvas, data, 40, overlay, false);
    canvas.toBlob(blob => { if (blob && unlocked() && started === epoch) { downloadBlob(blob, safeName(data.name) + (overlay ? "_KP配置案" : "_地形") + ".png"); } }, "image/png");
  }
  function selectOrCreatePoint(position) {
    let point = map().points.find(p => p.x === position[0] && p.y === position[1]);
    if (!point) {
      if (map().points.length >= 200) { status("地点は200件までです。", true); return; }
      changeMap(m => { point = Object.assign(Object.fromEntries(C.pointFields.map(key => [key, ""])), { id: uid(), name: "地点" + (m.points.length + 1), x: position[0], y: position[1] }); m.points.push(point); });
    }
    selectedPoint = point.id; renderInspector(); draw();
  }
  function renderInspector() {
    const panel = byId("map-inspector"); if (!panel) { return; } panel.replaceChildren(); panel.append(el("h3", "地点・配置候補"));
    field(panel, "地点", "map-point-select", selectedPoint || "", id => { selectedPoint = id || null; renderInspector(); draw(); },
      { choices: [["", "未選択"], ...map().points.map((p, i) => [p.id, (i + 1) + ". " + p.name])] });
    const point = map().points.find(p => p.id === selectedPoint);
    if (point) {
      if (map().kind !== "graph") {
        const position = el("div", null, { class: "authoring-row" });
        field(position, "列", "map-point-x", point.x + 1, null, { type: "number", min: 1, max: map().width, compact: true });
        field(position, "行", "map-point-y", point.y + 1, null, { type: "number", min: 1, max: map().height, compact: true });
        button(position, "地点を移動", () => {
          const x = Number(byId("map-point-x").value) - 1, y = Number(byId("map-point-y").value) - 1;
          if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= map().width || y >= map().height) { throw new Error("マップ内の列・行を指定してください。"); }
          if (map().points.some(p => p.id !== selectedPoint && p.x === x && p.y === y)) { throw new Error("そのマスには別の地点があります。"); }
          changeMap(m => Object.assign(m.points.find(p => p.id === selectedPoint), { x, y })); renderInspector();
        }); panel.append(position);
      }
      const labels = { name: "地点名", contents: "そこにあるもの", danger: "危険・地形の険しさ", possibleEnemies: "敵がいる可能性（候補）", events: "ランダムイベント候補", conditions: "発生条件・確率の希望（任意）", notes: "KPメモ" };
      Object.entries(labels).forEach(([key, label]) => field(panel, label, "map-point-" + key, point[key], value => {
        changeMap(m => { m.points.find(p => p.id === selectedPoint)[key] = value; });
        if (key === "name") { byId("map-point-select").selectedOptions[0].textContent = (map().points.findIndex(p => p.id === selectedPoint) + 1) + ". " + value; }
      }, { area: key !== "name", max: key === "name" ? 200 : 10000 }));
      button(panel, "地点を削除", () => {
        if (!window.confirm("この地点と接続する移動ルートを削除しますか？")) { return; }
        changeMap(m => { m.points = m.points.filter(p => p.id !== selectedPoint); m.routes = m.routes.filter(r => r.from !== selectedPoint && r.to !== selectedPoint); });
        selectedPoint = null; selectedRoute = null; graphLinkFrom = null; renderInspector(); draw();
      }, { class: "danger-button" });
    }
    const routes = el("details", null, { open: true }); routes.append(el("summary", "移動ルート")); panel.append(routes);
    field(routes, "ルート", "map-route-select", selectedRoute || "", id => { selectedRoute = id || null; renderInspector(); },
      { choices: [["", "未選択"], ...map().routes.map((r, i) => [r.id, (i + 1) + ". " + map().points.find(p => p.id === r.from).name + " → " + map().points.find(p => p.id === r.to).name])] });
    const create = button(routes, "ルート追加", () => {
      if (map().routes.length >= 300) { throw new Error("ルートは300件までです。"); }
      if (map().points.length < 2) { throw new Error("地点を2つ以上置いてください。"); }
      selectedRoute = uid(); changeMap(m => { m.routes.push({ id: selectedRoute, from: m.points[0].id, to: m.points[1].id, distance: "", time: "", roughness: "", notes: "" }); }); renderInspector();
    }); create.disabled = map().points.length < 2;
    const route = map().routes.find(r => r.id === selectedRoute);
    if (route) {
      [["from", "出発地点"], ["to", "到着地点"]].forEach(([key, label]) => field(routes, label, "map-route-" + key, route[key], value => {
        if (value === route[key === "from" ? "to" : "from"]) { byId("map-route-" + key).value = route[key]; throw new Error("別の地点を選んでください。"); }
        changeMap(m => { m.routes.find(r => r.id === selectedRoute)[key] = value; }); renderInspector();
      }, { choices: map().points.map(p => [p.id, p.name]) }));
      [["distance", "距離の目安"], ["time", "所要時間の目安"], ["roughness", "険しさ・通行条件"], ["notes", "移動中の条件・補足"]].forEach(([key, label]) => field(routes, label, "map-route-" + key, route[key], value => changeMap(m => { m.routes.find(r => r.id === selectedRoute)[key] = value; }), { area: key === "notes", max: key === "notes" ? 10000 : 300 }));
      button(routes, "ルートを削除", () => { changeMap(m => { m.routes = m.routes.filter(r => r.id !== selectedRoute); }); selectedRoute = null; renderInspector(); draw(); }, { class: "danger-button" });
    }
  }
  function updateMapOutput() { const output = byId("map-output"); if (output && map()) { output.value = C.mapRequest(map()); } }
  function updateScenarioOutput() {
    const output = byId("scenario-output"); if (!output || !scenario()) { return; }
    try { C.validateScenario(scenario()); output.value = C.scenarioText(scenario(), store.maps); }
    catch (error) { output.value = ""; status(error.message, true); }
  }
  function renderScenario() {
    if (!unlocked() || !store) { return; }
    const panel = panels.scenario; panel.replaceChildren(); heading(panel, "シナリオ制作", "scenario");
    const layout = el("div", null, { class: "scenario-layout" }), fields = el("div", null, { class: "scenario-fields" }), preview = el("aside", null, { class: "scenario-preview" });
    function section(title) { const node = el("section", null, { class: "scenario-section" }); node.append(el("h3", title)); fields.append(node); return node; }
    function sf(parent, key, label, options = {}) { return field(parent, label, "scenario-" + key, scenario()[key], value => { scenario()[key] = value; saveScenario(); }, options); }
    const basics = section("基本情報"); sf(basics, "name", "名前", { max: 200 });
    sf(basics, "canonId", "既存のSCN-ID（任意）", { max: 30 });
    sf(basics, "year", "星歴（空欄は未定）", { type: "number", min: 0, max: 99999 });
    sf(basics, "period", "季・月・日・時刻（任意）"); sf(basics, "place", "舞台・場所");
    sf(basics, "cp", "推奨CPの希望（任意）"); sf(basics, "party", "想定人数・操作区分"); sf(basics, "duration", "プレイ時間の希望");
    sf(basics, "difficulty", "仮の難易度", { choices: ["おまかせ", "入門", "標準", "挑戦"].map(x => [x, x]) });
    sf(basics, "certainty", "下書きの分類", { choices: ["候補", "妄想", "採用寄り", "決定（主KP確認済み）", "保留"].map(x => [x, x]) });
    const wishes = section("希望チェック");
    C.preferences.forEach(group => {
      const set = el("fieldset", null, { class: "authoring-preferences" }); set.append(el("legend", group.name));
      const options = el("div", null, { class: "authoring-checks" });
      group.items.forEach(item => {
        const label = el("label"), check = el("input", null, { type: "checkbox", value: item, "data-scenario-tag": group.name }); check.checked = scenario().tags.includes(item);
        check.addEventListener("change", () => { if (!unlocked()) { return; } scenario().tags = check.checked ? [...new Set([...scenario().tags, item])] : scenario().tags.filter(tag => tag !== item); saveScenario(); });
        append(label, check, document.createTextNode(item)); options.append(label);
      }); append(set, options); wishes.append(set);
    });
    const publicPart = section("PC向け案内の下書き"); sf(publicPart, "summary", "概要", { area: true }); sf(publicPart, "hook", "導入・依頼", { area: true });
    const kp = section("KP専用の設計");
    [["cast", "登場人物・目的・知っていること"], ["events", "事件・進行条件"], ["clues", "手掛かり・公開条件"], ["branches", "分岐・別解"], ["ending", "結末候補"], ["secrets", "秘密・真相"], ["deadline", "期限・時間経過"], ["failure", "撤退・失敗時の変化"], ["rewards", "報酬・後始末"]].forEach(([key, label]) => sf(kp, key, label, { area: true }));
    const linked = section("使用するマップ"); const checks = el("div", null, { class: "authoring-checks" });
    store.maps.forEach(m => {
      const label = el("label"), input = el("input", null, { type: "checkbox", value: m.id, "data-scenario-map": "true" }); input.checked = scenario().mapIds.includes(m.id);
      input.addEventListener("change", () => { if (!unlocked()) { return; } scenario().mapIds = input.checked ? [...new Set([...scenario().mapIds, m.id])] : scenario().mapIds.filter(id => id !== m.id); saveScenario(); });
      append(label, input, document.createTextNode(m.name || "名前未入力")); checks.append(label);
    }); linked.append(checks);
    const review = section("制約・要確認"); sf(review, "boundaries", "避けたい内容・制約", { area: true }); sf(review, "pending", "未決定・要確認", { area: true });
    preview.append(el("h3", "AIへの制作依頼（KP用）"));
    const actions = el("div", null, { class: "authoring-toolbar" });
    button(actions, "制作依頼をコピー", () => { C.validateStore(store); copy(C.scenarioText(scenario(), store.maps)); }, { id: "scenario-copy" });
    button(actions, "制作依頼MD", () => { C.validateStore(store); downloadText(C.scenarioText(scenario(), store.maps), safeName(scenario().name) + "_KP制作依頼.md"); });
    preview.append(actions); field(preview, "制作依頼文", "scenario-output", "", null, { area: true, readonly: true });
    append(layout, fields, preview); panel.append(layout); updateScenarioOutput();
  }
  function syncLock() {
    epoch++;
    ["map", "scenario"].forEach(name => { byId(name + "-tab").hidden = !unlocked(); });
    if (!unlocked()) {
      cancelGesture(); Object.values(panels).forEach(panel => { panel.replaceChildren(); panel.hidden = true; });
      if (["map", "scenario"].some(name => byId(name + "-tab").getAttribute("aria-selected") === "true")) { window.hoshimichiNavigation.activateTab("library", false); }
      store = null; undo = []; redo = []; pendingProposal = null; return;
    }
    try { load(); renderMap(); renderScenario(); persist(); }
    catch (error) {
      store = null;
      Object.values(panels).forEach(panel => {
        panel.replaceChildren(el("h2", "下書きを読み込めません"), el("p", error.message));
        button(panel, "保存データを退避", () => downloadText(localStorage.getItem(KEY) || "", "制作下書き_復旧用.json"));
      });
    }
  }
  window.addEventListener("hoshimichi:before-manager-lock", () => {
    cancelGesture();
    if (store && !persist()) {
      pendingRecovery = { store: C.clone(store), baseline: storedText };
      try { localStorage.setItem(KEY + "-recovery", JSON.stringify(pendingRecovery)); } catch (ignored) {}
    }
  });
  window.addEventListener("hoshimichi:manager-mode", syncLock);
  window.addEventListener("hoshimichi:tab", event => {
    if (!unlocked() || !store) { return; }
    if (event.detail.name === "map") { draw(); if (map().kind === "graph") { frameGraphStart(); } }
    if (event.detail.name === "scenario") { renderScenario(); }
  });
  window.hoshimichiAuthoring = Object.freeze({
    getDrafts: () => unlocked() && store ? C.clone(store) : null,
    storageKey: KEY,
    importFile,
    refresh: () => { if (unlocked()) { syncLock(); } }
  });
  if (unlocked()) { syncLock(); }
})();
