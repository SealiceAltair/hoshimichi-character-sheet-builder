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

const attackTypes = readObject("attackTypeDefinitions");
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
  heavy: [0, 0, 0.60, 1.50, 1.72, 3.00],
  single: [0, 0.75, 1.15, 1.55, 1.75, 2.50],
  standard: [0.63, 0.75, 1.00, 1.40, 1.90, 2.70],
  combo: [0, 0.75, 0.90, 1.20, 1.40, 2.50],
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

assert(/var STORAGE_VERSION = 9;/.test(source), "storage version is not V9");
assert(/raw\.version !== 8/.test(source), "V8 migration is not accepted");
assert(/enhancementStage:\s*0/.test(source), "new weapon enhancement stage is not 0");
assert(/goblinArmorEnhancement:\s*0/.test(source), "new enemy defense stage is not 0");
assert(/HOSHIMICHI-PC-V8:/.test(source), "public restore marker is not V8");
assert(/HOSHIMICHI-KP-V8:/.test(source), "KP restore marker is not V8");

assert(/return normalized > 0 \? "＋" \+ normalized : ""/.test(source),
  "weapon summary suffix missing");
assert(!/attackStageMultipliers/.test(source), "old uniform stage multiplier remains");
assert(/state\.monsterHp \* \(1 \+ state\.baseStats\.robustness \/ 3\)/.test(source),
  "monster maximum HP does not use base HP and robustness");
assert(/固定使用ポイント/.test(source), "monster fixed-point label missing");
assert(/ランダムポイント/.test(source), "monster random-point label missing");

console.log("星みちTRPG builder rule tests: PASS");
