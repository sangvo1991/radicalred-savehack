let cachedCoreDataPromise = null;

const DATA_URL = '../data.js';
const ABILITY_RANDOMIZER_URL = '../src/abilityRandomizer.js';
const ADVANCED_SEARCH_URL = '../src/advancedSearch.js';
const RANDOMIZER_METADATA_URL = '../src/randomizerMetadata.js';
const ABILITY_RANDOMIZER_TRUNCATE_MARKER = 'const saveFileInputElement = document.getElementById("saveFileInput");';

// Normalizes species names so the editor can accept punctuation-insensitive input.
export function normalizeSpeciesLookupKey(value) {
  return String(value ?? '')
    .replace(/♀/g, ' female ')
    .replace(/♂/g, ' male ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

// Normalizes item names so the editor can accept punctuation-insensitive input.
export function normalizeItemLookupKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

// Returns the best matching species for the provided user input.
export function lookupSpeciesByName(coreData, input) {
  const key = normalizeSpeciesLookupKey(input);
  return key ? coreData.speciesNameLookup.get(key) || null : null;
}

// Returns the best matching item for the provided user input.
export function lookupItemByName(coreData, input) {
  const key = normalizeItemLookupKey(input);
  return key ? coreData.itemNameLookup.get(key) || null : null;
}

// Fetches plain text so repo source files can be evaluated locally in the browser.
async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unable to load ${url}: HTTP ${response.status}`);
  }

  return response.text();
}

// Parses the repo's data.js object-literal payload into a normal JavaScript object.
function parseRepoObject(source) {
  return new Function(`return (${source});`)();
}

// Evaluates one repo script inside a safe sandbox and returns only the requested globals.
function extractScriptExports(source, exportNames, truncateMarker = null) {
  const safeSource = truncateMarker && source.includes(truncateMarker)
    ? source.slice(0, source.indexOf(truncateMarker))
    : source;
  const sandbox = {};
  const evaluator = new Function('sandbox', `
    const document = {
      getElementById() { return null; },
      querySelector() { return null; },
      createElement() { return {}; }
    };
    const localStorage = {
      getItem() { return null; },
      setItem() {},
      removeItem() {}
    };
    const window = {};
    let species = null;
    let moves = null;
    let abilities = null;
    let items = null;
    let areas = null;
    let tmMoves = null;
    let tutorMoves = null;
    let trainers = null;
    let natures = null;
    let eggGroups = null;
    let types = null;
    let splits = null;
    let evolutions = null;
    let scaledLevels = null;
    let caps = null;
    let sprites = null;
    let saveData = null;
    ${safeSource}
    sandbox.exports = { ${exportNames.join(', ')} };
  `);

  evaluator(sandbox);
  return sandbox.exports;
}

// Builds a reverse lookup so save strings can be written back into the Pokemon encoding.
function buildCharacterEncodingMap(characterEncodings) {
  const encodingMap = new Map();
  characterEncodings.forEach((character, index) => {
    if (character && !encodingMap.has(character)) {
      encodingMap.set(character, index);
    }
  });

  return encodingMap;
}

// Counts how many times each display name appears so duplicate-form labels can be disambiguated.
function buildSpeciesNameCounts(speciesMap) {
  const nameCounts = new Map();
  Object.values(speciesMap).forEach(mon => {
    nameCounts.set(mon.name, (nameCounts.get(mon.name) || 0) + 1);
  });
  return nameCounts;
}

// Returns the primary type name used for type-driven display labels such as Arceus forms.
function getPrimaryTypeName(mon, typesMap) {
  const typeId = Array.isArray(mon?.type) ? mon.type[0] : null;
  return typeId !== null && typesMap?.[typeId]?.name
    ? typesMap[typeId].name
    : null;
}

// Builds the human-friendly species label shown in the editor suggestions and slot cards.
function formatSpeciesDisplayLabel(mon, typesMap, nameCounts) {
  if (mon.name === 'Arceus' || mon.name === 'Silvally') {
    return `${mon.name} (${getPrimaryTypeName(mon, typesMap) || 'Normal'})`;
  }

  if ((nameCounts.get(mon.name) || 0) > 1 && mon.key !== mon.name && mon.key.startsWith(`${mon.name}-`)) {
    return `${mon.name} (${mon.key.slice(mon.name.length + 1).replace(/-/g, ' ')})`;
  }

  return mon.name;
}

// Indexes species names, labels, and keys so the editor can resolve user input quickly.
function buildSpeciesLookup(speciesMap, typesMap) {
  const speciesList = Object.values(speciesMap).sort((left, right) =>
    left.name.localeCompare(right.name) || left.ID - right.ID
  );
  const nameCounts = buildSpeciesNameCounts(speciesMap);
  const speciesNameLookup = new Map();
  const speciesDisplayNames = new Map();
  const speciesSuggestions = [];

  for (const mon of speciesList) {
    const displayLabel = formatSpeciesDisplayLabel(mon, typesMap, nameCounts);
    speciesDisplayNames.set(mon.ID, displayLabel);
    const aliases = [
      mon.name,
      mon.key,
      displayLabel,
      mon.name.replace(/♀/g, 'F').replace(/♂/g, 'M'),
      mon.key.replace(/female/gi, 'f').replace(/male/gi, 'm')
    ];

    for (const alias of aliases) {
      const normalized = normalizeSpeciesLookupKey(alias);
      if (normalized && !speciesNameLookup.has(normalized)) {
        speciesNameLookup.set(normalized, mon);
      }
    }

    speciesSuggestions.push({
      speciesId: mon.ID,
      label: displayLabel,
      value: displayLabel,
      key: mon.key,
      normalizedLabel: normalizeSpeciesLookupKey(displayLabel),
      normalizedKey: normalizeSpeciesLookupKey(mon.key),
      normalizedName: normalizeSpeciesLookupKey(mon.name)
    });
  }

  return { speciesList, speciesNameLookup, speciesDisplayNames, speciesSuggestions };
}

// Indexes item names so the editor can resolve and suggest PC box items quickly.
function buildItemLookup(itemsMap) {
  const itemList = Object.values(itemsMap).sort((left, right) =>
    left.name.localeCompare(right.name) || left.ID - right.ID
  );
  const itemNameLookup = new Map();
  const itemDisplayNames = new Map();
  const itemSuggestions = [];

  for (const item of itemList) {
    itemDisplayNames.set(item.ID, item.name);
    const aliases = [
      item.name,
      item.name.replace(/-/g, ' '),
      item.name.replace(/\s+/g, '')
    ];

    for (const alias of aliases) {
      const normalized = normalizeItemLookupKey(alias);
      if (normalized && !itemNameLookup.has(normalized)) {
        itemNameLookup.set(normalized, item);
      }
    }

    itemSuggestions.push({
      itemId: item.ID,
      label: item.name,
      value: item.name,
      description: item.description || '',
      normalizedLabel: normalizeItemLookupKey(item.name)
    });
  }

  return { itemList, itemNameLookup, itemDisplayNames, itemSuggestions };
}

// Loads repo data and the few constants/functions the standalone editor needs.
export async function loadCoreData() {
  if (!cachedCoreDataPromise) {
    cachedCoreDataPromise = (async () => {
      const [dataSource, abilityRandomizerSource, advancedSearchSource, randomizerSource] = await Promise.all([
        fetchText(DATA_URL),
        fetchText(ABILITY_RANDOMIZER_URL),
        fetchText(ADVANCED_SEARCH_URL),
        fetchText(RANDOMIZER_METADATA_URL)
      ]);

      const data = parseRepoObject(dataSource);
      const abilityRandomizer = extractScriptExports(
        abilityRandomizerSource,
        ['CHARACTER_ENCODINGS', 'tryRandomizeAbility', 'tryRandomizeMove'],
        ABILITY_RANDOMIZER_TRUNCATE_MARKER
      );
      const advancedSearch = extractScriptExports(advancedSearchSource, [
        'HARDCORE_BANNED_MOVES',
        'HARDCORE_RESTRICTED_MOVES',
        'HARDCORE_RESTRICTED_SPECIES_IDS',
        'HARDCORE_ABILITY_REPLACEMENTS',
        'HARDCORE_SPECIAL_ABILITY_REPLACEMENTS'
      ]);
      const randomizerMetadata = extractScriptExports(randomizerSource, [
        'RANDOMIZER_SPECIES_POOLS',
        'RANDOMIZER_SPECIES_BRANCHES',
        'DEFAULT_RANDOMIZER_SPECIES_POOL'
      ]);
      const {
        speciesList,
        speciesNameLookup,
        speciesDisplayNames,
        speciesSuggestions
      } = buildSpeciesLookup(data.species, data.types);
      const {
        itemList,
        itemNameLookup,
        itemDisplayNames,
        itemSuggestions
      } = buildItemLookup(data.items);

      return {
        ...data,
        speciesList,
        speciesNameLookup,
        speciesDisplayNames,
        speciesSuggestions,
        itemList,
        itemNameLookup,
        itemDisplayNames,
        itemSuggestions,
        abilityRandomizer,
        advancedSearch,
        randomizerMetadata,
        characterEncodingMap: buildCharacterEncodingMap(abilityRandomizer.CHARACTER_ENCODINGS)
      };
    })();
  }

  return cachedCoreDataPromise;
}
