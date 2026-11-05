(function (root) {
  "use strict";
  const clone = value => JSON.parse(JSON.stringify(value));
  const graphSize = { width: 2800, height: 1850, nodeWidth: 260, nodeHeight: 240 };
  const graphPorts = Object.freeze({
    "top-left":     Object.freeze({ x: 87,  y: 0,   nx: 0,  ny: -1, label: "上辺・左" }),
    "top-right":    Object.freeze({ x: 173, y: 0,   nx: 0,  ny: -1, label: "上辺・右" }),
    "right-upper":  Object.freeze({ x: graphSize.nodeWidth, y: 70,  nx: 1,  ny: 0, label: "右辺・上" }),
    "right-lower":  Object.freeze({ x: graphSize.nodeWidth, y: 170, nx: 1,  ny: 0, label: "右辺・下" }),
    "bottom-right": Object.freeze({ x: 173, y: graphSize.nodeHeight, nx: 0, ny: 1, label: "下辺・右" }),
    "bottom-left":  Object.freeze({ x: 87,  y: graphSize.nodeHeight, nx: 0, ny: 1, label: "下辺・左" }),
    "left-lower":   Object.freeze({ x: 0, y: 170, nx: -1, ny: 0, label: "左辺・下" }),
    "left-upper":   Object.freeze({ x: 0, y: 70,  nx: -1, ny: 0, label: "左辺・上" })
  });
  function graphAnchor(point, portId) {
    const port = graphPorts[portId];
    return { x: point.x + port.x, y: point.y + port.y, nx: port.nx, ny: port.ny };
  }
  const tiles = [
    { id: "void", label: "空白", color: "#edf1ed", glyph: " " },
    { id: "floor", label: "床", color: "#d4c9b5", glyph: "." },
    { id: "wall", label: "壁", color: "#59616c", glyph: "#" },
    { id: "road", label: "道", color: "#c79b65", glyph: "=" },
    { id: "grass", label: "草地", color: "#90b77b", glyph: "," },
    { id: "forest", label: "森", color: "#407952", glyph: "T" },
    { id: "water", label: "水域", color: "#64a9cb", glyph: "~" },
    { id: "rock", label: "岩地", color: "#9895a0", glyph: "^" },
    { id: "door", label: "扉", color: "#b26c43", glyph: "+" }
  ];
  const pointFields = ["name", "contents", "danger", "possibleEnemies", "events", "conditions", "notes"];
  const locationAdditionKinds = Object.freeze(["イベント", "使えるもの", "痕跡", "目立つもの", "持っていけるもの", "仕掛け", "植物", "その他"]);
  const locationAdditionReveal = Object.freeze({ arrival: "入ると分かる", roll: "ロールで見つかる" });
  const routeFields = ["from", "to", "distance", "time", "roughness", "notes"];
  const routeRoughnessLevels = Object.freeze([
    { name: "低い", color: "#63b7a8", examples: ["街道・平地"] },
    { name: "やや険しい", color: "#b5bc68", examples: ["森・林道"] },
    { name: "険しい", color: "#e9a15b", examples: ["悪路"] },
    { name: "非常に険しい", color: "#ed7376", examples: ["急斜面", "浅瀬", "雪中"] }
  ]);
  function routeRoughnessLevel(value) {
    return routeRoughnessLevels.find(level => level.name === value || level.examples.includes(value));
  }
  const scenarioFields = ["name", "canonId", "year", "period", "place", "cp", "party", "duration", "difficulty", "certainty", "summary", "hook", "cast", "events", "branches", "ending", "secrets", "clues", "deadline", "failure", "rewards", "boundaries", "pending"];
  const preferences = [
    { name: "体験", items: ["探索", "戦闘", "交渉", "調査・推理", "救出", "護衛", "採取・制作", "日常・交流"] },
    { name: "舞台", items: ["街・市場", "街道", "森・山", "洞窟・遺跡", "学園", "辺境の村", "地下・下水", "水辺"] },
    { name: "判断と展開", items: ["複数の解決方法", "戦わずに解決", "撤退の選択肢", "情報で危険を見抜く", "時間制限", "資源管理", "交渉できる相手", "行動で変わる状況"] },
    { name: "人物と雰囲気", items: ["仲間の掘り下げ", "NPCの自発的行動", "軽快な会話", "不穏な前兆", "生活の泥臭さ", "冒険の浪漫", "小さな達成", "次の依頼につながる余韻"] }
  ];
  const check = (condition, message) => { if (!condition) { throw new Error(message); } };
  const hasRequiredPassageCondition = value => typeof value === "string" && !!value.trim() &&
    !["なし", "条件なし", "不要"].includes(value.trim());
  function string(value, label, max = 30000) {
    check(typeof value === "string" && value.length <= max, label + "の形式・長さを確認してください。");
    return value;
  }
  function integer(value, min, max, label) {
    check(Number.isInteger(value) && value >= min && value <= max, label + "の範囲が不正です。");
    return value;
  }
  function newMap(id) {
    return { id, name: "新しいマップ", width: 24, height: 16, cells: Array(24 * 16).fill(0),
      scale: "", notes: "", points: [], routes: [], grid: true };
  }
  function newGraphMap(id) {
    return { id, name: "新しいシナリオMAP", kind: "graph", canonId: "", summary: "", notes: "", points: [], routes: [], actors: [] };
  }
  function newScenario(id) {
    return Object.assign(Object.fromEntries(scenarioFields.map(key => [key, ""])),
      { id, name: "新しいシナリオ", year: "992", difficulty: "おまかせ", certainty: "候補", tags: [], mapIds: [] });
  }
  function validateMap(source) {
    check(source && typeof source === "object", "マップがありません。");
    const graph = source.kind === "graph";
    check(graph || source.kind === undefined, "マップの形式が不正です。");
    const map = { id: string(source.id, "マップID", 160), name: string(source.name, "名前", 200) };
    if (graph) {
      map.kind = "graph";
      map.canonId = string(source.canonId ?? "", "既存SCN-ID", 30);
      check(map.canonId === "" || /^SCN-\d{4,}$/.test(map.canonId), "既存SCN-IDの形式を確認してください。");
      map.summary = string(source.summary ?? "", "シナリオ概要", 10000);
      map.notes = string(source.notes, "地図メモ");
    }
    else {
      Object.assign(map, { width: integer(source.width, 4, 80, "横幅"), height: integer(source.height, 4, 80, "縦幅"),
        scale: string(source.scale, "縮尺", 200), notes: string(source.notes, "地図メモ"), grid: source.grid === true });
      check(Array.isArray(source.cells) && source.cells.length === map.width * map.height, "マス数が一致しません。");
      map.cells = source.cells.map(value => integer(value, 0, tiles.length - 1, "地形"));
    }
    check(Array.isArray(source.points) && source.points.length <= 200, "地点数が多すぎます。");
    map.points = source.points.map(point => {
      const item = { id: string(point.id, "地点ID", 160),
        x: integer(point.x, 0, graph ? graphSize.width - graphSize.nodeWidth : map.width - 1, "地点X"),
        y: integer(point.y, 0, graph ? graphSize.height - graphSize.nodeHeight : map.height - 1, "地点Y") };
      pointFields.forEach(key => { item[key] = string(graph ? point[key] ?? "" : point[key], key, key === "name" ? 200 : 10000); });
      if (graph) {
        const ideas = point.eventIdeas === undefined ? (point.events ? [point.events] : []) : point.eventIdeas;
        check(Array.isArray(ideas) && ideas.length <= 30, "以前のイベント入力は1ロケーション30件までです。");
        item.eventIdeas = ideas.map(idea => string(idea, "以前のイベント入力", 3000));
        if (point.additions !== undefined) {
          check(Array.isArray(point.additions) && point.additions.length <= 30, "追加内容は1ロケーション30件までです。");
          const additionIds = new Set();
          item.additions = point.additions.map(addition => {
            check(addition && typeof addition === "object", "追加内容の形式が不正です。");
            const id = string(addition.id, "追加内容ID", 160);
            check(id.trim() && !additionIds.has(id), "追加内容IDの空欄または重複があります。");
            additionIds.add(id);
            check(locationAdditionKinds.includes(addition.kind), "追加内容の種類を確認してください。");
            check(addition.reveal === "" || Object.hasOwn(locationAdditionReveal, addition.reveal), "追加内容の発見方法を確認してください。");
            return { id, kind: addition.kind, reveal: addition.reveal, text: string(addition.text, "追加内容", 3000) };
          });
        }
      }
      return item;
    });
    const ids = new Set(map.points.map(point => point.id));
    check(ids.size === map.points.length, "地点IDが重複しています。");
    const pointsById = new Map(map.points.map(point => [point.id, point]));
    check(Array.isArray(source.routes) && source.routes.length <= 300, "ルート数が多すぎます。");
    map.routes = source.routes.map(route => {
      const item = { id: string(route.id, "ルートID", 160) };
      routeFields.forEach(key => { item[key] = string(route[key], key, key === "notes" ? 10000 : 300); });
      check(ids.has(item.from) && ids.has(item.to) && item.from !== item.to, "移動ルートの地点を確認してください。");
      if (graph) {
        item.condition = string(route.condition ?? "", "通行条件", 3000);
        item.oneWay = route.oneWay === true;
        // Older drafts only stored places. Preserve the sides shown when first read.
        const forward = pointsById.get(item.to).x >= pointsById.get(item.from).x;
        item.fromPort = route.fromPort === undefined ? (forward ? "right-upper" : "left-upper") : route.fromPort;
        item.toPort = route.toPort === undefined ? (forward ? "left-upper" : "right-upper") : route.toPort;
        check([item.fromPort, item.toPort].every(port => typeof port === "string" && Object.hasOwn(graphPorts, port)),
          "接続端子の位置を確認してください。");
      }
      return item;
    });
    check(new Set(map.routes.map(route => route.id)).size === map.routes.length, "ルートIDが重複しています。");
    if (graph) {
      check(Array.isArray(source.actors ?? []) && (source.actors ?? []).length <= 200, "登場人物は200人までです。");
      map.actors = (source.actors ?? []).map(actor => {
        const item = { id: string(actor.id, "人物ID", 160), name: string(actor.name, "人物名", 200),
          kind: string(actor.kind, "人物区分", 20), species: string(actor.species ?? "", "種族", 200),
          initialNodeId: string(actor.initialNodeId ?? "", "初期位置ID", 160), goal: string(actor.goal ?? "", "目的", 3000) };
        check(["pc", "npc", "enemy"].includes(item.kind), "人物区分が不正です。");
        check(!item.initialNodeId || ids.has(item.initialNodeId), "人物の初期位置が見つかりません。");
        return item;
      });
      check(new Set(map.actors.map(actor => actor.id)).size === map.actors.length, "人物IDが重複しています。");
    }
    return map;
  }
  function validateScenario(source) {
    check(source && typeof source === "object", "シナリオがありません。");
    const result = { id: string(source.id, "下書きID", 160) };
    scenarioFields.forEach(key => { result[key] = string(source[key], key, key === "name" ? 200 : 30000); });
    check(result.year === "" || /^\d{1,5}$/.test(result.year), "星歴は未定または0〜99999で入力してください。");
    check(result.canonId === "" || /^SCN-\d{4,}$/.test(result.canonId), "登録済みSCN-IDの形式を確認してください。");
    check(["候補", "妄想", "採用寄り", "決定（主KP確認済み）", "保留"].includes(result.certainty), "確定度が不正です。");
    check(Array.isArray(source.tags) && source.tags.length <= 100, "希望チェックが不正です。");
    result.tags = source.tags.map(value => string(value, "希望", 200));
    check(Array.isArray(source.mapIds) && source.mapIds.length <= 100, "参照マップが不正です。");
    result.mapIds = source.mapIds.map(value => string(value, "参照マップID", 160));
    return result;
  }
  function validateStore(source) {
    check(source && source.version === 1 && Array.isArray(source.maps) && Array.isArray(source.scenarios), "未対応の下書き形式です。");
    check(source.maps.length <= 100 && source.scenarios.length <= 100, "下書きが100件を超えています。");
    const store = { version: 1, maps: source.maps.map(validateMap), scenarios: source.scenarios.map(validateScenario) };
    check(new Set(store.maps.map(m => m.id)).size === store.maps.length, "マップIDが重複しています。");
    check(new Set(store.scenarios.map(s => s.id)).size === store.scenarios.length, "シナリオIDが重複しています。");
    const mapIds = new Set(store.maps.map(m => m.id));
    check(store.scenarios.every(s => s.mapIds.every(id => mapIds.has(id))), "参照先のマップがありません。");
    return store;
  }
  function paintLine(map, a, b, tile) {
    let [x, y] = a;
    const dx = Math.abs(b[0] - x), dy = -Math.abs(b[1] - y), sx = x < b[0] ? 1 : -1, sy = y < b[1] ? 1 : -1;
    let error = dx + dy;
    while (true) {
      if (x >= 0 && y >= 0 && x < map.width && y < map.height) { map.cells[y * map.width + x] = tile; }
      if (x === b[0] && y === b[1]) { break; }
      const twice = 2 * error;
      if (twice >= dy) { error += dy; x += sx; }
      if (twice <= dx) { error += dx; y += sy; }
    }
  }
  function rectangle(map, a, b, tile, room) {
    const left = Math.max(0, Math.min(a[0], b[0])), right = Math.min(map.width - 1, Math.max(a[0], b[0]));
    const top = Math.max(0, Math.min(a[1], b[1])), bottom = Math.min(map.height - 1, Math.max(a[1], b[1]));
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        map.cells[y * map.width + x] = room ? (x === left || x === right || y === top || y === bottom ? 2 : 1) : tile;
      }
    }
  }
  function fill(map, x, y, tile) {
    const original = map.cells[y * map.width + x];
    if (original === tile) { return; }
    const pending = [[x, y]];
    map.cells[y * map.width + x] = tile;
    while (pending.length) {
      const [cx, cy] = pending.pop();
      for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
        if (nx >= 0 && ny >= 0 && nx < map.width && ny < map.height && map.cells[ny * map.width + nx] === original) {
          map.cells[ny * map.width + nx] = tile; pending.push([nx, ny]);
        }
      }
    }
  }
  function resize(map, width, height) {
    integer(width, 4, 80, "横幅"); integer(height, 4, 80, "縦幅");
    const result = clone(map); result.width = width; result.height = height; result.cells = Array(width * height).fill(0);
    for (let y = 0; y < Math.min(height, map.height); y++) {
      for (let x = 0; x < Math.min(width, map.width); x++) { result.cells[y * width + x] = map.cells[y * map.width + x]; }
    }
    result.points = result.points.filter(p => p.x < width && p.y < height);
    const ids = new Set(result.points.map(p => p.id));
    result.routes = result.routes.filter(r => ids.has(r.from) && ids.has(r.to));
    return result;
  }
  function fence(text, language = "text") {
    const lengths = (text.match(/`+/g) || []).map(value => value.length);
    const mark = "`".repeat(Math.max(3, ...lengths.map(n => n + 1)));
    return mark + language + "\n" + text + "\n" + mark;
  }
  function mapText(map) {
    const graph = map.kind === "graph", lines = ["## マップ下書き：" + map.name];
    if (graph) {
      lines.push("形式：シナリオ単位の場所ノードMAP。画面上の位置や線の長さは実距離・所要時間・正確な地形を示さない。",
        "既存SCN-ID：" + (map.canonId || "未登録。ここでは採番しない"), "概要：" + (map.summary || "未定"));
    }
    else {
      const rows = [];
      for (let y = 0; y < map.height; y++) { rows.push(map.cells.slice(y * map.width, (y + 1) * map.width).map(t => tiles[t].glyph).join("")); }
      lines.push("寸法：" + map.width + "列 × " + map.height + "行", "1マスの距離：" + (map.scale || "未定（縮尺を推測しない）"),
        "原点は左上。以下の地点座標は1始まり。距離・所要時間は入力された目安で、絵の間隔から自動計算しない。", fence(rows.join("\n")),
        "凡例：" + tiles.map(t => (t.glyph === " " ? "空白" : t.glyph) + "=" + t.label).join(" / "));
    }
    lines.push("### 地点・候補（KP用）");
    if (graph) { lines.push("入ると分かる追加内容と、ロール成功で見つかる追加内容を区別する。ロールは発見の条件とし、イベントの発生は卓で条件を確認する。"); }
    map.points.forEach((p, i) => {
      lines.push("#### " + (i + 1) + ". " + p.name + (graph ? "" : "（列" + (p.x + 1) + "・行" + (p.y + 1) + "）"));
      if (graph) {
        lines.push("描写：" + (p.contents || "空欄。AIは正本と卓の現在状態に合わせて人や物を配置してよい"));
        for (const addition of p.additions || []) {
          if (addition.text.trim()) {
            lines.push("追加（" + addition.kind + "／" + (locationAdditionReveal[addition.reveal] || "発見方法未設定") + "）：" + addition.text);
          }
        }
        const oldEvents = p.eventIdeas.filter(Boolean);
        if (oldEvents.length) { lines.push("以前のイベント入力（発生未確定）：" + oldEvents.join(" / ")); }
        const legacy = [p.danger, p.possibleEnemies, p.conditions, p.notes].filter(Boolean);
        if (legacy.length) { lines.push("以前のメモ：" + legacy.join(" / ")); }
      } else {
        lines.push("あるもの：" + (p.contents || "未定"), "危険・険しさ：" + (p.danger || "未定"), "敵がいる可能性：" + (p.possibleEnemies || "未設定。敵なしとは確定しない"),
          "ランダムイベント候補：" + (p.events || "未設定"), "発生条件・確率の希望：" + (p.conditions || "未定。確率を創作しない"), "補足：" + (p.notes || "なし"));
      }
    });
    if (graph) {
      lines.push("### 登場人物・敵の初期配置案（卓開始状態ではない）");
      map.actors.forEach(actor => {
        const place = map.points.find(p => p.id === actor.initialNodeId);
        lines.push(actor.name + "（" + actor.kind + (actor.species ? "・" + actor.species : "") + "） / 初期位置：" + (place ? place.name : "未配置") + " / 目的：" + (actor.goal || "未定"));
      });
    }
    lines.push("### 移動ルート・見積もり",
      "険しさの段階は通りにくさの目安です。街道や森などは例です。地形や足場は描写の内容を参照してください。");
    map.routes.forEach(r => {
      const level = routeRoughnessLevel(r.roughness)?.name || "未設定";
      lines.push(map.points.find(p => p.id === r.from).name + (graph && !r.oneWay ? " ↔ " : " → ") + map.points.find(p => p.id === r.to).name,
        "距離：" + (r.distance || "未定") + " / 所要時間：" + (r.time || "未定") + " / 険しさの段階：" + level);
      if (r.roughness && r.roughness !== level) { lines.push("以前の険しさ欄（参考）：" + r.roughness); }
      lines.push(
        (graph ? "通行条件：" + (hasRequiredPassageCondition(r.condition) ? r.condition : "なし") : "条件：" + (r.notes || "未定")),
        "描写：" + (r.notes || "なし"));
    });
    lines.push("### マップ全体メモ", map.notes || "未定");
    return lines.join("\n");
  }
  const boundaries = [
    "これは主KP用の制作下書きです。物語の開始、配置の確定、イベント抽選、正本の編集・登録・ID発行を依頼しません。",
    "現行正本のAGENTS.mdと索引を確認し、canon/game_rules/360_星みちTRPG_世界運行・シナリオ設計.md、canon/world/180_年表.md、canon/world/190_地図.mdの関連原文を読んでから検討してください。",
    "空欄は未定です。候補・妄想・採用寄り・保留を決定へ昇格しないでください。敵の可能性やランダムイベントは候補であり、実在・出現・発生済みとは扱いません。",
    "前提、距離・移動時間の根拠、危険の前兆、撤退や別解、NPCの目的・条件・時間経過、PCが知る情報とKP秘密を分離してください。未定の数値・確率は主KPへ確認してください。",
    "希望チェックは優先材料であり、すべて必須ではありません。未選択を禁止と解釈せず、希望同士が衝突する場合は選択肢を出してください。"
  ];
  function mapRequest(map) { return ["# マップ制作相談（KP用・未確定下書き）", ...boundaries, mapText(map), "\n配置・移動・イベントの矛盾と不足を点検し、採用を選べる案を作ってください。画像化する場合も、候補の敵を確定配置した画像へ勝手に変えないでください。"].join("\n\n"); }
  function sceneMapPrompt(source) {
    const map = validateMap(source);
    check(map.kind === "graph", "場所ノードMAPを選んでください。");
    return ["# シナリオ場所MAP案の作成・修正（KP用）",
      "正本を参照し、既存の決定・保留・候補を混同しない。下書きの内容を黙って消さず、PCが通る一本道や強制遭遇を作らない。",
      "地点ノードのnameはロケーション名、contentsは描写。描写が空欄の場合、正本と卓の現在状態に合わせて人や物を配置できる。additionsはそのロケーションに追加する内容。各項目はid、kind（" + locationAdditionKinds.join("、") + "）、reveal（arrival＝入ると分かる、roll＝ロールで見つかる、空文字＝未設定）、text（内容）を持つ。既存項目のIDを維持し、新しい項目にはその地点内で一意のIDを付ける。",
      "rollは発見の条件。対象の存在は配置で扱い、成功前は本人が知った情報へ加えない。イベントの発生条件はtextに記し、成立は卓で扱う。以前のeventIdeasは発生未確定の入力として保持する。",
      "接続は往復を標準とし、一方通行のみoneWayをtrueにする。conditionは満たさなければその経路を移動できない必須条件だけに使う。条件がなければ空文字。地点の内容はadditionsへ記し、確率や自動判定を作らない。",
      "roughnessは通りにくさの段階。新しい入力には「" + routeRoughnessLevels.map(level => level.name).join("」「") + "」のいずれか、未定なら空文字を使う。街道・森・急斜面などは段階の例。どんな地形でも、路面や足場、通れるが危険・遅い理由などはnotes（描写）へ自由に記す。既存の自由記述は元の情報を保持する。",
      "既存接続のfromPort・toPortは同じ地点につながる限り維持する。新しい接続で未指定の端子はアプリが初回だけ決める。",
      "敵・NPCは開始前の人数・種族・初期位置・目的の案として個体ごとに記す。卓中の現在地や行動、勝敗を確定しない。既存個体のIDを保ち、新しいIDは重複しない文字列にする。",
      "回答は説明やコードフェンスを付けず、JSONオブジェクトのみ。schemaはhoshimichi.scene-map-proposal/1、mapは下記の構造を保つ。map.idを変更しない。",
      fence(JSON.stringify({ schema: "hoshimichi.scene-map-proposal/1", map }, null, 2), "json")].join("\n\n");
  }
  function validateSceneMapProposal(source, baseMap) {
    check(source && source.schema === "hoshimichi.scene-map-proposal/1", "AI案の形式が違います。");
    const proposal = validateMap(source.map);
    check(proposal.kind === "graph" && proposal.id === baseMap.id, "別のシナリオMAPの案です。");
    const originalRoutes = new Map(validateMap(baseMap).routes.map(route => [route.id, route]));
    for (const route of proposal.routes) {
      const previous = originalRoutes.get(route.id);
      if (!previous) { continue; }
      for (const end of ["from", "to"]) {
        if (route[end] === previous.from) { route[end + "Port"] = previous.fromPort; }
        else if (route[end] === previous.to) { route[end + "Port"] = previous.toPort; }
      }
    }
    return proposal;
  }
  function scenarioText(scenario, maps) {
    const labels = { place: "舞台", period: "季・月・日・時刻", cp: "推奨CPの希望", party: "想定人数・役割", duration: "プレイ時間の希望", difficulty: "仮の難易度", certainty: "分類", summary: "PC向け概要", hook: "導入・依頼", cast: "登場人物・目的・知識", events: "事件・進行条件", branches: "分岐・別解", ending: "結末候補", secrets: "KP秘密・真相", clues: "手掛かり・公開条件", deadline: "期限・時間経過", failure: "撤退・失敗時の変化", rewards: "報酬・後始末", boundaries: "避けたい内容・制約", pending: "未決定・要確認" };
    const lines = ["# シナリオ制作依頼（KP用）", ...boundaries, "## 基本情報", "名前：" + scenario.name,
      "既存のSCN-ID：" + (scenario.canonId || "未登録。ここでは採番しない"), "星歴：" + (scenario.year || "未定"),
      "希望：" + (scenario.tags.join("、") || "未指定")];
    Object.entries(labels).forEach(([key, label]) => { lines.push("## " + label, scenario[key] || "未定"); });
    const linked = scenario.mapIds.map(id => maps.find(m => m.id === id));
    check(linked.every(Boolean), "紐づくマップが見つかりません。");
    linked.forEach(map => { lines.push(mapText(map)); });
    lines.push("## 依頼する成果", "一シナリオ一Markdownの候補案として、PC向け案内とKP専用本文を分離してください。成立事実ではなく制作案として扱い、未決定事項・参照元・主KP確認が必要な点を併記してください。engine.py用WORKSETの生成やREADY判定、卓の開始はこの依頼には含めません。");
    return lines.join("\n\n");
  }
  const api = { clone, tiles, graphSize, graphPorts, graphAnchor, pointFields, locationAdditionKinds, locationAdditionReveal, routeFields, routeRoughnessLevels, routeRoughnessLevel, scenarioFields, preferences, newMap, newGraphMap, newScenario, validateMap, validateScenario, validateStore, paintLine, rectangle, fill, resize, hasRequiredPassageCondition, mapText, mapRequest, sceneMapPrompt, validateSceneMapProposal, scenarioText };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  else { root.HoshimichiAuthoringCore = Object.freeze(api); }
})(typeof window !== "undefined" ? window : globalThis);
