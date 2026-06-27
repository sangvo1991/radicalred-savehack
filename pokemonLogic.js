import { DEFAULT_GROWTH_RATE_ID, GROWTH_RATE_BY_DEX_ID } from './growthRates.js';

const hardcoreStateCache = new WeakMap();
const preEvolutionLookupCache = new WeakMap();

// Returns the display name used elsewhere in the repo, including As One special cases.
export function getAbilityDisplayName(coreData, abilityId, nameIndex = 0) {
  if (!coreData.abilities?.[abilityId]) {
    return '';
  }

	if (abilityId === 73) {
		return 'As One (Grim Neigh)';
	}

	if (abilityId === 77) {
		return 'As One (Moxie)';
	}

  return coreData.abilities[abilityId].names[nameIndex] || coreData.abilities[abilityId].names[0];
}

// Resolves the hardcore move-ban and ability-replacement tables into fast lookups.
export function buildHardcoreState(coreData) {
  if (hardcoreStateCache.has(coreData)) {
    return hardcoreStateCache.get(coreData);
  }

  const moveIdsByName = new Map();
  for (const move of Object.values(coreData.moves || {})) {
    moveIdsByName.set(move.name, move.ID);
  }

  const abilityIdsByName = new Map();
  for (const ability of Object.values(coreData.abilities || {})) {
    for (const name of ability.names) {
      abilityIdsByName.set(name, ability.ID);
    }
    abilityIdsByName.set(getAbilityDisplayName(coreData, ability.ID), ability.ID);
  }

  const bannedMoveIds = new Set(
    coreData.advancedSearch.HARDCORE_BANNED_MOVES
      .map(name => moveIdsByName.get(name))
      .filter(id => id !== undefined)
  );
  const restrictedMoveIds = new Set(
    coreData.advancedSearch.HARDCORE_RESTRICTED_MOVES
      .map(name => moveIdsByName.get(name))
      .filter(id => id !== undefined)
  );
  const restrictedSpeciesIds = new Set(coreData.advancedSearch.HARDCORE_RESTRICTED_SPECIES_IDS);

  const abilityReplacements = new Map();
  for (const [fromName, toName] of Object.entries(coreData.advancedSearch.HARDCORE_ABILITY_REPLACEMENTS)) {
    const fromId = abilityIdsByName.get(fromName);
    const toId = abilityIdsByName.get(toName);
    if (fromId !== undefined && toId !== undefined) {
      abilityReplacements.set(fromId, toId);
    }
  }

  const specialAbilityReplacements = new Map();
  for (const [speciesId, overrides] of Object.entries(coreData.advancedSearch.HARDCORE_SPECIAL_ABILITY_REPLACEMENTS)) {
    const speciesOverrides = new Map();
    for (const [fromName, toName] of Object.entries(overrides)) {
      const fromId = abilityIdsByName.get(fromName);
      const toId = abilityIdsByName.get(toName);
      if (fromId !== undefined && toId !== undefined) {
        speciesOverrides.set(fromId, toId);
      }
    }
    specialAbilityReplacements.set(Number(speciesId), speciesOverrides);
  }

  const state = {
    bannedMoveIds,
    restrictedMoveIds,
    restrictedSpeciesIds,
    abilityReplacements,
    specialAbilityReplacements
  };
  hardcoreStateCache.set(coreData, state);
  return state;
}

// Returns whether hardcore-only move restrictions should be applied for this save.
function isHardcoreEnabled(saveMetadata) {
  return Boolean(saveMetadata?.hardmode);
}

// Builds a child-to-parent lookup once so inherited move checks stay fast in the editor.
function getPreEvolutionLookup(coreData) {
  if (preEvolutionLookupCache.has(coreData)) {
    return preEvolutionLookupCache.get(coreData);
  }

  const lookup = new Map();
  for (const mon of Object.values(coreData.species || {})) {
    for (const evolution of mon.evolutions || []) {
      const childSpeciesId = evolution?.[2];
      if (childSpeciesId && !lookup.has(childSpeciesId)) {
        lookup.set(childSpeciesId, mon.ID);
      }
    }
  }

  preEvolutionLookupCache.set(coreData, lookup);
  return lookup;
}

// Walks backward through the full evolution line so parent-stage level-up moves can be inherited.
function getPreEvolutionLine(mon, coreData) {
  const lookup = getPreEvolutionLookup(coreData);
  const line = [];
  const seenSpeciesIds = new Set([mon.ID]);
  let parentSpeciesId = lookup.get(mon.ID);

  while (parentSpeciesId && !seenSpeciesIds.has(parentSpeciesId)) {
    const parent = coreData.species?.[parentSpeciesId];
    if (!parent) {
      break;
    }

    line.push(parent);
    seenSpeciesIds.add(parentSpeciesId);
    parentSpeciesId = lookup.get(parentSpeciesId);
  }

  return line;
}

// Applies the active save's randomized learnset table to one move id.
function resolveMoveId(moveId, mon, saveMetadata, coreData) {
  if (!saveMetadata?.random?.learnset) {
    return moveId;
  }

  return coreData.abilityRandomizer.tryRandomizeMove(
    saveMetadata.trainedId,
    Boolean(saveMetadata.restricted),
    moveId,
    mon.ID
  );
}

// Returns whether a move remains legal for the species under Hardcore restrictions.
export function isHardcoreMoveLegal(mon, moveId, coreData) {
  const state = buildHardcoreState(coreData);
  if (state.bannedMoveIds.has(moveId)) {
    return false;
  }

  if (!state.restrictedMoveIds.has(moveId)) {
    return true;
  }

  return state.restrictedSpeciesIds.has(mon.ID);
}

// Adds one learnable move to the editable pool after randomizer and Hardcore rules are applied.
function pushEditableMoveOption(pool, byId, mon, saveMetadata, coreData, rawMoveId, sourceLabel, level = null) {
  if (!rawMoveId) {
    return;
  }

  const resolvedMoveId = resolveMoveId(rawMoveId, mon, saveMetadata, coreData);
  if (!resolvedMoveId || !coreData.moves?.[resolvedMoveId]) {
    return;
  }

  if (isHardcoreEnabled(saveMetadata) && !isHardcoreMoveLegal(mon, resolvedMoveId, coreData)) {
    return;
  }

  if (byId.has(resolvedMoveId)) {
    const existing = byId.get(resolvedMoveId);
    if (existing.level === null && level !== null) {
      existing.level = level;
      existing.source = sourceLabel;
    } else if (existing.level !== null && level !== null && level < existing.level) {
      existing.level = level;
      existing.source = sourceLabel;
    }
    return;
  }

  const move = coreData.moves[resolvedMoveId];
  const detail = {
    id: move.ID,
    name: move.name,
    pp: move.pp || 0,
    source: sourceLabel,
    level
  };
  byId.set(resolvedMoveId, detail);
  pool.push(detail);
}

// Builds the full editable move pool for one species at its current level and save rules.
export function buildEditableMovePool(mon, saveMetadata, coreData, level = 100) {
  const pool = [];
  const byId = new Map();

  for (const [rawMoveId, moveLevel] of mon.levelupMoves || []) {
    if (moveLevel > level) {
      continue;
    }
    pushEditableMoveOption(pool, byId, mon, saveMetadata, coreData, rawMoveId, 'Level Up', moveLevel);
  }

  for (const parent of getPreEvolutionLine(mon, coreData)) {
    for (const [rawMoveId, moveLevel] of parent.levelupMoves || []) {
      if (moveLevel > level) {
        continue;
      }
      pushEditableMoveOption(pool, byId, mon, saveMetadata, coreData, rawMoveId, 'Pre-Evolution', moveLevel);
    }
  }

  for (const tmIndex of mon.tmMoves || []) {
    const tmMoveId = coreData.tmMoves?.[tmIndex];
    pushEditableMoveOption(pool, byId, mon, saveMetadata, coreData, tmMoveId, 'TM/HM');
  }

  for (const tutorIndex of mon.tutorMoves || []) {
    const tutorMoveId = coreData.tutorMoves?.[tutorIndex];
    pushEditableMoveOption(pool, byId, mon, saveMetadata, coreData, tutorMoveId, 'Tutor');
  }

  for (const moveId of mon.eggMoves || []) {
    pushEditableMoveOption(pool, byId, mon, saveMetadata, coreData, moveId, 'Egg');
  }

  for (const moveId of mon.eventMoves || []) {
    pushEditableMoveOption(pool, byId, mon, saveMetadata, coreData, moveId, 'Event');
  }

  for (const moveId of mon.prevoMoves || []) {
    pushEditableMoveOption(pool, byId, mon, saveMetadata, coreData, moveId, 'Pre-Evolution');
  }

  return pool;
}

// Builds the default level-up moveset a generated Pokemon should know at a target level.
export function buildDefaultMoveset(mon, saveMetadata, coreData, level = 5) {
  const learnedMoves = [];

  for (const [rawMoveId, moveLevel] of mon.levelupMoves || []) {
    if (moveLevel > level) {
      continue;
    }

    const resolvedMoveId = resolveMoveId(rawMoveId, mon, saveMetadata, coreData);
    if (!resolvedMoveId || !coreData.moves[resolvedMoveId]) {
      continue;
    }

    if (isHardcoreEnabled(saveMetadata) && !isHardcoreMoveLegal(mon, resolvedMoveId, coreData)) {
      continue;
    }

    const duplicateIndex = learnedMoves.indexOf(resolvedMoveId);
    if (duplicateIndex >= 0) {
      learnedMoves.splice(duplicateIndex, 1);
    }
    learnedMoves.push(resolvedMoveId);
  }

  return learnedMoves.slice(-4);
}

// Returns the displayable ability pool after randomizer and Hardcore overrides are applied.
export function resolveAbilityPool(mon, saveMetadata, coreData) {
  const slotDefinitions = [
    { slotKey: 'primary', slotLabel: 'Primary', ability: mon.abilities?.[1] },
    { slotKey: 'secondary', slotLabel: 'Secondary', ability: mon.abilities?.[2] },
    { slotKey: 'hidden', slotLabel: 'Hidden', ability: mon.abilities?.[0] }
  ];
  const state = buildHardcoreState(coreData);
  const results = [];

  for (const slot of slotDefinitions) {
    if (!slot.ability || slot.ability[0] === 0) {
      continue;
    }

    const originalId = slot.ability[0];
    let resolvedId = originalId;
    if (saveMetadata?.random?.abilities) {
      resolvedId = coreData.abilityRandomizer.tryRandomizeAbility(
        saveMetadata.trainedId,
        Boolean(saveMetadata.restricted),
        originalId,
        mon.ID
      );
    }

    if (isHardcoreEnabled(saveMetadata)) {
      const specialOverride = state.specialAbilityReplacements.get(mon.ID);
      if (specialOverride?.has(resolvedId)) {
        resolvedId = specialOverride.get(resolvedId);
      } else if (state.abilityReplacements.has(resolvedId)) {
        resolvedId = state.abilityReplacements.get(resolvedId);
      }
    }

    results.push({
      slotKey: slot.slotKey,
      slotLabel: slot.slotLabel,
      originalId,
      resolvedId,
      originalName: getAbilityDisplayName(coreData, originalId, slot.ability[1]),
      resolvedName: getAbilityDisplayName(coreData, resolvedId),
      changedForRandomizer: resolvedId !== originalId && !isHardcoreEnabled(saveMetadata),
      changedForHardcore: isHardcoreEnabled(saveMetadata) && resolvedId !== originalId
    });
  }

  return results;
}

// Picks the growth-rate group for one species, falling back cleanly for custom dex ids.
export function getGrowthRateId(mon, coreData) {
  if (!mon) {
    return DEFAULT_GROWTH_RATE_ID;
  }

  const direct = GROWTH_RATE_BY_DEX_ID[mon.dexID];
  if (direct) {
    return direct;
  }

  if (mon.ancestor && coreData.species?.[mon.ancestor]) {
    const ancestorDexId = coreData.species[mon.ancestor].dexID;
    const inherited = GROWTH_RATE_BY_DEX_ID[ancestorDexId];
    if (inherited) {
      return inherited;
    }
  }

  return DEFAULT_GROWTH_RATE_ID;
}

// Calculates the exact experience threshold for a level in the standard six growth groups.
export function calculateExperienceForLevel(growthRateId, level) {
  const x = Number(level);
  switch (growthRateId) {
    case 1:
      return Math.floor((5 * x ** 3) / 4);
    case 2:
      return x ** 3;
    case 3:
      return Math.floor((4 * x ** 3) / 5);
    case 4:
      return Math.floor((6 * x ** 3) / 5 - 15 * x ** 2 + 100 * x - 140);
    case 5:
      if (x <= 50) {
        return Math.floor((x ** 3 * (100 - x)) / 50);
      }
      if (x <= 68) {
        return Math.floor((x ** 3 * (150 - x)) / 100);
      }
      if (x <= 98) {
        return Math.floor((x ** 3 * (1274 + (x % 3) ** 2 - 9 * (x % 3) - 20 * Math.floor(x / 3))) / 1000);
      }
      return Math.floor((x ** 3 * (160 - x)) / 100);
    case 6:
      if (x <= 15) {
        return Math.floor((x ** 3 * (24 + Math.floor((x + 1) / 3))) / 50);
      }
      if (x <= 35) {
        return Math.floor((x ** 3 * (14 + x)) / 50);
      }
      return Math.floor((x ** 3 * (32 + Math.floor(x / 2))) / 50);
    default:
      return x ** 3;
  }
}

// Estimates a box Pokemon's level from its stored experience total.
export function estimateLevelFromExperience(mon, exp, coreData) {
  const growthRateId = getGrowthRateId(mon, coreData);
  let level = 1;

  for (let candidate = 1; candidate <= 100; candidate += 1) {
    const minExp = calculateExperienceForLevel(growthRateId, candidate);
    if (exp >= minExp) {
      level = candidate;
    } else {
      break;
    }
  }

  return level;
}

// Calculates neutral-nature stats for a generated level-5 Pokemon with 31 IVs and 0 EVs.
export function buildNeutralStatSet(mon, level = 5) {
  const iv = 31;
  const ev = 0;
  const [hpBase, atkBase, defBase, speBase, spaBase, spdBase] = mon.stats;
  const hp = Math.floor(((2 * hpBase + iv + Math.floor(ev / 4)) * level) / 100) + level + 10;
  const stat = base => Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + 5;

  return {
    maxHp: hp,
    attack: stat(atkBase),
    defense: stat(defBase),
    speed: stat(speBase),
    specialAttack: stat(spaBase),
    specialDefense: stat(spdBase)
  };
}

// Bundles every generated field the save writer needs for one target species.
export function buildPokemonBlueprint(mon, saveMetadata, coreData, level = 5) {
  const moveIds = buildDefaultMoveset(mon, saveMetadata, coreData, level);
  return {
    mon,
    level,
    exp: calculateExperienceForLevel(getGrowthRateId(mon, coreData), level),
    moveIds,
    pp: moveIds.map(moveId => coreData.moves[moveId]?.pp || 0),
    stats: buildNeutralStatSet(mon, level),
    abilityPool: resolveAbilityPool(mon, saveMetadata, coreData)
  };
}
