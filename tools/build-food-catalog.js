#!/usr/bin/env node
/**
 * Builds food-catalog.json from the USDA FoodData Central "SR Legacy" release.
 *
 * SR Legacy is public domain (CC0) and frozen, so the generated file never needs
 * to be refreshed. Run this only if you want to regenerate or retune the output.
 *
 *   node tools/build-food-catalog.js --download
 *   node tools/build-food-catalog.js --source <extracted-csv-dir>
 *
 * Output shape matches the inline FOOD_CATALOG in Tracker.html:
 *   { aliases, measure, baseAmount, calories, protein, carbs, fat }
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const { execFileSync } = require("child_process");

const SR_LEGACY_URL =
  "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip";

const NUTRIENT_IDS = { calories: "1008", protein: "1003", carbs: "1005", fat: "1004" };

// Categories that map onto how a person actually logs a meal. Excluded:
// spices (2), baby food (3), branded (26), QC materials (27), alcohol (28) --
// they add rows without adding matches.
const KEEP_CATEGORIES = new Set([
  "1", "4", "5", "6", "7", "8", "9", "10", "11", "12",
  "13", "14", "15", "16", "17", "18", "19", "20", "22"
]);

// Descriptions containing these are institutional/edge entries that pollute
// alias matching without ever being logged by a human.
const REJECT_PATTERNS = [
  /\bbaby food\b/i, /\binfant\b/i, /\bformula\b/i, /\busda commodity\b/i,
  /\bschool\b/i, /\bimitation\b/i, /\bunprepared\b/i, /\bdry mix\b/i,
  /\breduced sodium\b/i, /\bnfs\b/i, /\bpuerto rican\b/i, /\bfrozen concentrate\b/i,
  /\bwith salt\b/i, /\bfor use\b/i, /\bindustrial\b/i, /\bcarcass\b/i,
  /\braw, variety\b/i, /\bmechanically separated\b/i, /\balaska native\b/i,
  /\bmeatless\b/i, /\bsubstitute\b/i, /\blow sodium\b/i, /\bfrozen\b/i,
  /\bready-to-eat\b/i, /\bmoisture\b/i, /\bvitamin\b/i,
  /\bdehydrated\b/i, /\bsulfured\b/i, /\bstewing\b/i, /\bhome-prepared\b/i
];

// Portion descriptors that mean "one countable item".
const PIECE_WORDS = /\b(piece|slice|large|medium|small|whole|each|fruit|egg|link|patty|fillet|breast|thigh|wing|leg|banana|item|unit|bar|cookie|muffin|roll|bun|tortilla|chapati|roti)\b/i;

// Eaten by volume rather than counted.
const VOLUME_FOODS = /\brice\b|\bpasta\b|\bnoodle|\blentil|\bbean|\bchickpea|\bpea\b|\bpeas\b|\bquinoa\b|\bmilk\b|\byogurt\b|\bcurd\b|\bjuice\b|\bcereal|\boat|\bsoup\b|\bdal\b|\bcouscous\b|\bbarley\b/;

// Portion labels that describe a bulk measure, not one countable item.
const NOT_COUNTABLE = /\b(cup|chopped|sliced|diced|shredded|halves|pieces|crumbled|mashed|ground|tbsp|tablespoon|tsp|teaspoon|spear|floret|kernel|bunch|package|container|bottle|can)\b/i;

// Always weighed, never counted -- "1 almonds" is meaningless.
const WEIGHED_FOODS = /\balmond|\bcashew|\bwalnut|\bpeanut|\bpistachio|\bnuts?\b|\bseeds?\b|\braisin|\bflour\b|\bsugar\b|\bbutter\b|\bcheese\b|\brice\b|\bpaneer\b|\bmince|\bpowder\b/;

function log(...args) {
  process.stderr.write(args.join(" ") + "\n");
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          return resolve(download(res.headers.location, dest));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", reject);
  });
}

/** Minimal RFC4180 CSV parser; USDA files contain quoted commas. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift();
  return rows
    .filter((entry) => entry.length === header.length)
    .map((entry) => {
      const obj = {};
      header.forEach((key, idx) => {
        obj[key] = entry[idx];
      });
      return obj;
    });
}

function readCsv(dir, name) {
  return parseCsv(fs.readFileSync(path.join(dir, name), "utf8"));
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function round(value) {
  return Math.round(value);
}

function roundOne(value) {
  return Math.round(value * 10) / 10;
}

// USDA groups some foods under a container word. "Nuts, almonds" is really
// "almonds". Only words that are never themselves a logged food belong here --
// "oil", "juice" and "soup" are real foods, so promoting them would make
// "Oil, almond" masquerade as "almonds".
const GENERIC_PREFIXES = new Set([
  "nuts", "seeds", "beans", "cereals ready-to-eat", "cereals", "fish",
  "mollusks", "crustaceans", "game meat", "leavening agents", "babyfood"
]);

// Foods that must be logged in their cooked form. Grains and legumes roughly
// triple in weight when cooked, so serving the dry value silently inflates
// calories ~3x -- the single worst error this catalog could ship.
const NEEDS_COOKED = /\brice\b|\bpasta\b|\bnoodle|\blentil|\bbean|\bchickpea|\bpea\b|\bpeas\b|\bquinoa\b|\bbarley\b|\bmillet\b|\boat|\bwheat\b|\bcouscous\b|\bdal\b|\bgram\b/;

const RAW_FORM = /\braw\b|\buncooked\b|\bdry\b|\bdried\b/;
const COOKED_FORM = /\bcooked\b|\bboiled\b|\bsteamed\b/;

/**
 * "Lentils, mature seeds, cooked, boiled, without salt" -> "lentils".
 * "Nuts, almonds" -> "almonds".
 */
function primaryName(description) {
  // Strip parentheticals first -- "Chickpeas (garbanzo beans, bengal gram)"
  // contains a comma inside the parens that would otherwise split the name.
  const cleaned = String(description).replace(/\([^)]*\)/g, " ");
  const segments = cleaned
    .split(",")
    .map((part) => normalizeText(part).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!segments.length) return "";

  let name = segments[0];
  if (GENERIC_PREFIXES.has(name) && segments[1] && !/^(raw|cooked|dry|dried)$/.test(segments[1])) {
    name = segments[1];
  }
  return name;
}

/** Lower is better: the least-qualified, everyday, ready-to-eat form. */
function specificityScore(description) {
  const desc = normalizeText(description);
  let score = desc.split(",").length * 10 + desc.length / 10;

  if (COOKED_FORM.test(desc)) score -= 25;
  if (/\bwithout salt\b/.test(desc)) score -= 8;
  // Note: "raw" is NOT penalized. Fruit and vegetables are normally eaten raw,
  // and penalizing it handed wins to dried/sulfured variants at 5x the
  // calories. Grains and legumes that must be cooked are excluded upstream by
  // isWrongForm(), which is the correct place for that rule.
  if (/\bcanned\b|\bdehydrated\b|\bfreeze\b|\bconcentrate\b/.test(desc)) score += 25;
  if (/\bdried\b|\bsulfured\b|\bdry\b/.test(desc)) score += 40;
  if (/\broasted\b|\bfried\b|\bsalted\b|\bsweetened\b|\bflavor|\bglazed\b|\bhoney\b/.test(desc)) score += 18;
  if (/\bfortified\b|\benriched\b|\badded\b|\bprotein fortified\b/.test(desc)) score += 8;
  if (/\bfilled\b|\bimitation\b|\bhydrogenated\b|\blauric\b/.test(desc)) score += 60;
  // Unusual animals and offal should never win a common name like "milk" or
  // "chicken" over the ordinary cut.
  if (/\bsheep\b|\bgoat\b|\bbuffalo\b|\bcamel\b|\bhuman\b|\breindeer\b|\bwhale\b|\bseal\b/.test(desc)) score += 70;
  if (/\bfeet\b|\bgiblet|\bliver\b|\bheart\b|\bkidney|\bbrain\b|\bgizzard|\bneck\b|\bskin\b|\btail\b|\bblood\b/.test(desc)) score += 70;
  if (/\brestaurant\b|\bfast food\b|\bchinese\b/.test(desc)) score += 30;
  return score;
}

/** True when this description is an unusable form for the given food name. */
function isWrongForm(name, description) {
  const desc = normalizeText(description);
  if (NEEDS_COOKED.test(name) && RAW_FORM.test(desc) && !COOKED_FORM.test(desc)) {
    return true;
  }
  return false;
}

function pickPortion(portions, name) {
  const usable = portions.filter((p) => Number(p.gram_weight) > 0);
  if (!usable.length) return null;

  const cup = usable.find(
    (p) => p.unitName === "cup" && Math.abs(Number(p.amount) - 1) < 0.01
  );
  // A "piece" basis only makes sense for genuinely countable foods. USDA also
  // lists things like a 5 g tofu cube or a 143 g cup of almonds, both of which
  // would make "1 almonds" nonsense.
  const piece = usable.find((p) => {
    const label = `${p.portion_description || ""} ${p.modifier || ""} ${p.unitName || ""}`;
    const grams = Number(p.gram_weight);
    if (NOT_COUNTABLE.test(label)) return false;
    return (
      PIECE_WORDS.test(label) &&
      Math.abs(Number(p.amount) - 1) < 0.01 &&
      grams >= 20 &&
      grams <= 250
    );
  });

  // Grains, legumes and liquids are eaten by volume, not by count. Nuts and
  // similar bulk foods are weighed, so never give them a piece basis.
  if (WEIGHED_FOODS.test(name)) {
    return null;
  }
  if (VOLUME_FOODS.test(name) && cup) {
    return { measure: "cup", baseAmount: 1, grams: Number(cup.gram_weight) };
  }
  if (piece) {
    return { measure: "piece", baseAmount: 1, grams: Number(piece.gram_weight) };
  }
  if (cup) {
    return { measure: "cup", baseAmount: 1, grams: Number(cup.gram_weight) };
  }
  return null;
}

function build(sourceDir) {
  log("Reading USDA CSVs from", sourceDir);
  const foods = readCsv(sourceDir, "food.csv");
  const measureUnits = new Map(
    readCsv(sourceDir, "measure_unit.csv").map((u) => [u.id, normalizeText(u.name)])
  );

  const wanted = new Set(Object.values(NUTRIENT_IDS));
  const nutrients = new Map();
  readCsv(sourceDir, "food_nutrient.csv").forEach((row) => {
    if (!wanted.has(row.nutrient_id)) return;
    if (!nutrients.has(row.fdc_id)) nutrients.set(row.fdc_id, {});
    nutrients.get(row.fdc_id)[row.nutrient_id] = Number(row.amount);
  });

  const portions = new Map();
  readCsv(sourceDir, "food_portion.csv").forEach((row) => {
    if (!portions.has(row.fdc_id)) portions.set(row.fdc_id, []);
    portions.get(row.fdc_id).push({ ...row, unitName: measureUnits.get(row.measure_unit_id) });
  });

  // Collapse USDA's many qualified variants down to one row per everyday name,
  // keeping the least-qualified variant.
  const byName = new Map();
  foods.forEach((food) => {
    if (!KEEP_CATEGORIES.has(food.food_category_id)) return;
    if (REJECT_PATTERNS.some((re) => re.test(food.description))) return;

    const nutrient = nutrients.get(food.fdc_id);
    if (!nutrient || nutrient[NUTRIENT_IDS.calories] === undefined) return;

    const name = primaryName(food.description);
    if (name.length < 3 || name.length > 28) return;
    if (/\d/.test(name)) return;
    if (isWrongForm(name, food.description)) return;

    const score = specificityScore(food.description);
    const existing = byName.get(name);
    if (!existing || score < existing.score) {
      byName.set(name, { food, nutrient, score });
    }
  });

  const catalog = [];
  byName.forEach(({ food, nutrient }, name) => {
    const per100 = {
      calories: nutrient[NUTRIENT_IDS.calories] || 0,
      protein: nutrient[NUTRIENT_IDS.protein] || 0,
      carbs: nutrient[NUTRIENT_IDS.carbs] || 0,
      fat: nutrient[NUTRIENT_IDS.fat] || 0
    };
    if (!per100.calories) return;

    const portion = pickPortion(portions.get(food.fdc_id) || [], name);
    // Default to a 100 g basis. A bare number then reads as grams, which is what
    // "200 curd" means; count-style foods get a piece/cup basis instead.
    const basis = portion || { measure: "g", baseAmount: 100, grams: 100 };
    const factor = basis.grams / 100;

    const aliases = [name];
    if (name.endsWith("s") && name.length > 4) {
      aliases.push(name.slice(0, -1));
    } else {
      aliases.push(`${name}s`);
    }

    catalog.push({
      aliases,
      measure: basis.measure,
      baseAmount: basis.baseAmount,
      calories: round(per100.calories * factor),
      protein: roundOne(per100.protein * factor),
      carbs: roundOne(per100.carbs * factor),
      fat: roundOne(per100.fat * factor),
      // Kept so a surprising number can be traced back to its USDA row.
      usda: food.description,
      grams: round(basis.grams)
    });
  });

  catalog.sort((a, b) => a.aliases[0].localeCompare(b.aliases[0]));
  return catalog;
}

async function resolveSource(argv) {
  const sourceIdx = argv.indexOf("--source");
  if (sourceIdx !== -1 && argv[sourceIdx + 1]) {
    return argv[sourceIdx + 1];
  }

  const cacheDir = path.join(os.tmpdir(), "fdc-sr-legacy");
  const extracted = path.join(cacheDir, "FoodData_Central_sr_legacy_food_csv_2018-04");
  if (fs.existsSync(path.join(extracted, "food.csv"))) {
    return extracted;
  }
  if (!argv.includes("--download")) {
    throw new Error(
      "No USDA source found. Re-run with --download, or pass --source <dir>."
    );
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const zipPath = path.join(cacheDir, "sr-legacy.zip");
  log("Downloading USDA SR Legacy (public domain, ~6 MB)...");
  await download(SR_LEGACY_URL, zipPath);
  log("Extracting...");
  execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${cacheDir}' -Force`
  ]);
  return extracted;
}

async function main() {
  const argv = process.argv.slice(2);
  const sourceDir = await resolveSource(argv);
  const catalog = build(sourceDir);

  const outIdx = argv.indexOf("--out");
  const outPath = outIdx !== -1 && argv[outIdx + 1]
    ? argv[outIdx + 1]
    : path.join(__dirname, "..", "food-catalog.json");

  const payload = {
    source: "USDA FoodData Central, SR Legacy (public domain, CC0)",
    sourceUrl: SR_LEGACY_URL,
    generatedAt: new Date().toISOString(),
    count: catalog.length,
    foods: catalog
  };

  fs.writeFileSync(outPath, JSON.stringify(payload), "utf8");
  const bytes = fs.statSync(outPath).size;
  log(`Wrote ${catalog.length} foods to ${outPath} (${Math.round(bytes / 1024)} KB raw)`);
}

main().catch((error) => {
  log("Failed:", error.message);
  process.exit(1);
});
