"use strict";

const fs = require("fs");
const vm = require("vm");

const source = fs.readFileSync("index.html", "utf8");

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function assertClose(actual, expected, message) {
  if (Math.abs(actual - expected) > 1e-9) {
    fail(`${message}: expected ${expected}, got ${actual}`);
  }
}

function readObject(name) {
  const marker = `var ${name} = `;
  const start = source.indexOf(marker);
  assert(start >= 0, `${name} not found`);
  const objectStart = source.indexOf("{", start + marker.length);
  let depth = 0;
  let end = -1;
  for (let index = objectStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  assert(end > objectStart, `${name} object is incomplete`);
  return vm.runInNewContext(`(${source.slice(objectStart, end)})`);
}

function readArray(name) {
  const marker = `var ${name} = [`;
  const start = source.indexOf(marker);
  assert(start >= 0, `${name} not found`);
  const arrayStart = source.indexOf("[", start + marker.length - 1);
  const end = source.indexOf("];", arrayStart);
  assert(end > arrayStart, `${name} array is incomplete`);
  return vm.runInNewContext(`(${source.slice(arrayStart, end + 1)})`);
}

function readFunction(name, context) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert(start >= 0, `${name} not found`);
  const bodyStart = source.indexOf("{", start + marker.length);
  let depth = 0;
  let end = -1;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  assert(end > bodyStart, `${name} function is incomplete`);
  return vm.runInNewContext(`(${source.slice(start, end)})`, context);
}

const attackTypes = readObject("attackTypeDefinitions");
const attackMethods = readObject("simulationAttackMethods");
const attackPurposes = readObject("attackPurposeDefinitions");
const defenseMultipliers = readObject("defenseResultMultipliers");
const weaponStages = readArray("weaponEnhancementDefinitions");
const defenseStages = readArray("armorEnhancementDefinitions");

const expectedPowers = {
  heavy: 18,
  single: 13,
  standard: 7,
  combo: 6,
  multi: 5
};
const expectedHits = {
  heavy: [0, 0, 1, 1, 1, 1],
  single: [0, 1, 1, 1, 1, 1],
  standard: [1, 1, 2, 2, 2, 2],
  combo: [0, 1, 2, 4, 4, 4],
  multi: [1, 2, 3, 4, 5, 5]
};
const expectedMultipliers = {
  heavy: [0.50, 0.75, 0.60, 1.50, 1.72, 3.00],
  single: [0.50, 0.75, 1.15, 1.55, 1.75, 2.50],
  standard: [0.63, 0.75, 1.00, 1.40, 1.90, 2.70],
  combo: [0.50, 0.75, 0.90, 1.20, 1.40, 2.50],
  multi: [1.00, 1.00, 1.00, 1.15, 1.25, 2.00]
};
const grades = ["limited", "weak", "regular", "hard", "extreme", "critical"];

Object.keys(expectedPowers).forEach((type) => {
  assert(attackTypes[type].power === expectedPowers[type], `${type} base power`);
  grades.forEach((grade, index) => {
    assert(attackTypes[type].hits[grade] === expectedHits[type][index], `${type}/${grade} hits`);
    assertClose(
      attackTypes[type].multipliers[grade],
      expectedMultipliers[type][index],
      `${type}/${grade} multiplier`
    );
  });
});

function enhanced(base, stage) {
  return base * stage.multiplier + stage.fixed;
}

const stage3Powers = {
  heavy: 38,
  single: 28,
  standard: 16,
  combo: 14,
  multi: 12
};
Object.keys(stage3Powers).forEach((type) => {
  assertClose(
    enhanced(attackTypes[type].power, weaponStages[3]),
    stage3Powers[type],
    `${type} stage 3 power`
  );
});
assertClose(enhanced(1, defenseStages[1]), 7 / 3, "standard protection 1 stage 1");
assertClose(enhanced(2, defenseStages[3]), 7, "heavy protection 2 stage 3");

const getRangeBudget = readFunction("getRangeBudget", {});
const getTargetBudget = (skill) => skill.targetMode === "multiple"
  ? Math.max(0, skill.maxTargets - 1) * 25
  : 0;
const getSkillPerformance = readFunction("getSkillPerformance", {
  SKILL_ACCURACY_RATE: 1.4,
  SKILL_SELL_RATE: 0.7,
  getTargetBudget,
  getRangeBudget
});

function skillBudget(overrides) {
  return getSkillPerformance(Object.assign({
    powerDisplay: 0,
    accuracy: 0,
    effectBudget: 0,
    targetMode: "single",
    maxTargets: 1,
    rangeShape: "line",
    rangeDistance: 3,
    rangeAngle: 90,
    areaRadius: 1.5
  }, overrides));
}

assertClose(skillBudget({ powerDisplay: 65 }).netBudget, 65,
  "power 65 net budget");
assert(skillBudget({ powerDisplay: 65 }).requiredCost === 1,
  "power 65 should require cost 1");
const soldAccuracy = skillBudget({ powerDisplay: 123, accuracy: -60 });
assertClose(soldAccuracy.buyBudget, 123, "power 123 buy budget");
assertClose(soldAccuracy.sellBudget, 58.8, "accuracy -60 sell budget");
assertClose(soldAccuracy.netBudget, 64.2, "power 123 accuracy -60 net budget");
assert(soldAccuracy.requiredCost === 1,
  "power 123 accuracy -60 should require cost 1");
const minimumCost = skillBudget({
  powerDisplay: -90,
  targetMode: "multiple",
  maxTargets: 3
});
assertClose(minimumCost.buyBudget, 50, "negative power buy budget");
assertClose(minimumCost.sellBudget, 63, "negative power sell budget");
assertClose(minimumCost.netBudget, -13, "negative power net budget");
assert(minimumCost.requiredCost === 1, "minimum skill cost should be 1");
assert(skillBudget({ powerDisplay: 130 }).requiredCost === 2,
  "power 130 should require cost 2");

assert(getRangeBudget({ targetMode: "range", rangeShape: "line", rangeDistance: 3 }) === 20,
  "line 3m budget");
assert(getRangeBudget({ targetMode: "range", rangeShape: "line", rangeDistance: 9 }) === 60,
  "line 9m budget");
assert(getRangeBudget({
  targetMode: "range", rangeShape: "cone", rangeDistance: 6, rangeAngle: 90
}) === 57, "cone 90 degrees 6m budget");
assert(getRangeBudget({
  targetMode: "range", rangeShape: "cone", rangeDistance: 3, rangeAngle: 360
}) === 40, "cone angle should clamp to 180 degrees");
assert(getRangeBudget({ targetMode: "range", rangeShape: "around", areaRadius: 3 }) === 57,
  "around radius 3m budget");
assert(getRangeBudget({
  targetMode: "range", rangeShape: "area", rangeDistance: 6, areaRadius: 3
}) === 77, "area distance 6m radius 3m budget");

const expectedAttackMethods = {
  harry: [-30, 15],
  steady: [-20, 10],
  careful: [-10, 5],
  normal: [0, 0],
  step: [10, -5],
  strong: [20, -10],
  allout: [25, -15]
};
assert(Object.keys(attackMethods).length === 7, "attack method count is not 7");
Object.keys(expectedAttackMethods).forEach((method) => {
  assertClose(attackMethods[method].powerDisplay, expectedAttackMethods[method][0],
    `${method} power correction`);
  assertClose(attackMethods[method].accuracy, expectedAttackMethods[method][1],
    `${method} accuracy correction`);
});

["direct", "harry", "break", "coordinate", "push"].forEach((purpose) => {
  assert(attackPurposes[purpose], `${purpose} attack purpose missing`);
  assertClose(attackPurposes[purpose].multiplier, purpose === "direct" ? 1 : 0.7,
    `${purpose} attack purpose multiplier`);
});

const expectedDefenseMultipliers = {
  critical: 0,
  extreme: 0.10,
  hard: 0.25,
  regular: 0.40,
  weak: 0.65,
  limited: 0.85,
  automaticSuccess: 0.40,
  failure: 1,
  fumble: 1,
  automaticFailure: 1
};
Object.keys(expectedDefenseMultipliers).forEach((grade) => {
  assertClose(defenseMultipliers[grade], expectedDefenseMultipliers[grade],
    `${grade} defense multiplier`);
});

assert(/var STORAGE_VERSION = 10;/.test(source), "storage version is not V10");
assert(/raw\.version !== 9/.test(source), "V9 migration is not accepted");
assert(/enhancementStage:\s*0/.test(source), "new weapon enhancement stage is not 0");
assert(/goblinArmorEnhancement:\s*0/.test(source), "new enemy defense stage is not 0");
assert(/HOSHIMICHI-PC-V10:/.test(source), "public restore marker is not V10");
assert(/HOSHIMICHI-KP-V10:/.test(source), "KP restore marker is not V10");

assert(/return normalized > 0 \? "＋" \+ normalized : ""/.test(source),
  "weapon summary suffix missing");
assert(!/attackStageMultipliers/.test(source), "old uniform stage multiplier remains");
assert(!/defenseEquipmentDefinitions/.test(source), "abolished weapon-receive categories remain");
assert(!/receiveMultiplier/.test(source), "abolished weapon-receive multiplier remains");
assert(/defenseMethod === "parry" \? -15 : 0/.test(source),
  "parry success correction is not -15");
assert(/config\.methodPowerFactor \*\s*config\.skillPowerFactor/.test(source),
  "attack method and attack skill power factors are not multiplied separately");
assert(/Math\.max\(0, rawPerHit - goblinProtection\) \* hits/.test(source),
  "protection is not subtracted per hit before defense reduction");
assert(/compareOpposedResults\(attack, defense\)/.test(source),
  "dodge/parry opposed-result comparison is missing");
assert(/Math\.round\(getEnhancedWeaponPower\(weapon\) \* 100\) \/ 100/.test(source),
  "weapon display is not rounded to two decimal places");
assert(/Math\.round\(getEnhancedArmorProtection\(armor\) \* 100\) \/ 100/.test(source),
  "armor display is not rounded to two decimal places");
assert(/state\.monsterHp \* \(1 \+ state\.baseStats\.robustness \/ 3\)/.test(source),
  "monster maximum HP does not use base HP and robustness");
assert(/固定使用ポイント/.test(source), "monster fixed-point label missing");
assert(/ランダムポイント/.test(source), "monster random-point label missing");

console.log("星みちTRPG builder rule tests: PASS");
