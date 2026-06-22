import { buildPokemonBlueprint, estimateLevelFromExperience } from './pokemonLogic.js';

const NAME_OFFSET = 0x000;
const TRAINED_ID_OFFSET = 0x00A;
const SAVE_SECTOR_COUNT = 14;
const SAVE_SLOT_COUNT = 2;
const SAVE_SECTOR_SIZE = 0x1000;
const SAVE_SECTOR_DATA_SIZE = 0x0FF4;
const SAVE_SECTOR_CHECKSUM_SIZES = [
  3876, 4084, 4084, 4084, 3500, 4084, 4084,
  4084, 4084, 4084, 4084, 4084, 4084, 1324
];
const TRAINER_INFO_LOGICAL_OFFSET = 0x0000;
const GAME_SPECIFIC_LOGICAL_OFFSET = SAVE_SECTOR_DATA_SIZE * 4;
const PARTY_COUNT_LOGICAL_OFFSET = SAVE_SECTOR_DATA_SIZE + 0x34;
const PARTY_POKEMON_LOGICAL_OFFSET = SAVE_SECTOR_DATA_SIZE + 0x38;
const PARTY_POKEMON_SIZE = 100;
const PARTY_POKEMON_CAPACITY = 6;
const PARTY_POKEMON_SPECIES_OFFSET = 0x20;
const PARTY_POKEMON_HELD_ITEM_OFFSET = 0x22;
const PARTY_POKEMON_EXP_OFFSET = 0x24;
const PARTY_POKEMON_MOVES_OFFSET = 0x2C;
const PARTY_POKEMON_PP_OFFSET = 0x34;
const PARTY_POKEMON_IVS_OFFSET = 0x48;
const PARTY_POKEMON_LEVEL_OFFSET = 0x54;
const PARTY_POKEMON_CURRENT_HP_OFFSET = 0x56;
const PARTY_POKEMON_MAX_HP_OFFSET = 0x58;
const PARTY_POKEMON_ATTACK_OFFSET = 0x5A;
const PARTY_POKEMON_DEFENSE_OFFSET = 0x5C;
const PARTY_POKEMON_SPEED_OFFSET = 0x5E;
const PARTY_POKEMON_SP_ATTACK_OFFSET = 0x60;
const PARTY_POKEMON_SP_DEFENSE_OFFSET = 0x62;
const BOX_STORAGE_LOGICAL_OFFSET = SAVE_SECTOR_DATA_SIZE * 5 + 0x04;
const BOX_POKEMON_SIZE = 58;
const BOX_POKEMON_SPECIES_OFFSET = 0x1C;
const BOX_POKEMON_HELD_ITEM_OFFSET = 0x1E;
const BOX_POKEMON_EXP_OFFSET = 0x20;
const BOX_POKEMON_MOVES_OFFSET = 0x27;
const BOX_POKEMON_IVS_OFFSET = 0x36;
const BOX_CAPACITY = 30;
const BOX_COUNT = 25;
const PRIMARY_BOX_COUNT = 23;
const EXTRA_BOX_REGIONS = [
  { boxNumber: 24, logicalOffset: 13776 },
  { boxNumber: 25, logicalOffset: 176 }
];
const POKEMON_NAME_OFFSET = 0x08;
const POKEMON_NAME_LENGTH = 10;
const POKEMON_LANGUAGE_OFFSET = 0x12;
const POKEMON_FLAGS_OFFSET = 0x13;
const POKEMON_OT_NAME_OFFSET = 0x14;
const POKEMON_OT_NAME_LENGTH = 8;
const POKEMON_HAS_SPECIES_MASK = 0x02;
const POKEMON_LANGUAGE_MIN = 0x01;
const POKEMON_LANGUAGE_MAX = 0x07;
const MAX_SPECIES_ID = 1375;
const HARDMODE_BITFLAG = 0x0DB2;
const RESTRICTED_BITFLAG = 0x0DC3;
const SCALED_SPECIES_BITFLAG = 0x0F2B;
const NORMAL_SPECIES_LEARNSET_ABILITY_BITFLAG = 0x0F2C;
const EVENT_FLAG_BASE = 0x0EE0;
const RANDOMIZER_SPECIES_EVENT_FLAGS = [
  0x53,
  0x821,
  0x823,
  0x825,
  0x827,
  0x930,
  0x93A,
  0x940,
  0x94F,
  0x103E,
  0x104A,
  0x104E
];
const ALL_31_IVS_BITFIELD = 0x3FFFFFFF;
const PARTY_TEMPLATE_HEX = 'f37706ef909346ffc4dde6d5d7dcddff2c220202c2ffffffffffff000000000099018b00dd0000000065030011015d009c0000000a190523000000000000000000000000009d0502ffffff3f000000000000000005ff19001a00100010000e0010001100';
const BOX_TEMPLATE_HEX = '64d792b5074d8766bdd9e0d9e7e8d9d9e0d50202cdffffffffffff00f60300009c000000000003644d74440800000000000000590502ffffff3f';

// Converts a compact hex template into mutable bytes for fallback entry creation.
function hexToBytes(hex) {
  const clean = hex.trim();
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

const PARTY_TEMPLATE_BYTES = hexToBytes(PARTY_TEMPLATE_HEX);
const BOX_TEMPLATE_BYTES = hexToBytes(BOX_TEMPLATE_HEX);

// Returns the logical save offset and wrap mode for one boxed slot.
function getBoxSlotLocation(boxNumber, slotIndex) {
  const extraRegion = EXTRA_BOX_REGIONS.find(region => region.boxNumber === boxNumber);
  if (extraRegion) {
    return {
      entryOffset: extraRegion.logicalOffset + slotIndex * BOX_POKEMON_SIZE,
      wrap: false
    };
  }

  return {
    entryOffset: BOX_STORAGE_LOGICAL_OFFSET + ((boxNumber - 1) * BOX_CAPACITY + slotIndex) * BOX_POKEMON_SIZE,
    wrap: true
  };
}

// Builds a placeholder empty boxed slot so the editor can still target sparse data safely.
function buildSyntheticEmptyBoxSlot(boxNumber, slotIndex) {
  const { entryOffset, wrap } = getBoxSlotLocation(boxNumber, slotIndex);
  return {
    kind: 'box',
    boxNumber,
    slotIndex,
    slotNumber: slotIndex + 1,
    entryOffset,
    wrap,
    rawBytes: new Uint8Array(BOX_POKEMON_SIZE),
    present: false,
    speciesId: 0,
    nickname: '',
    trainerName: '',
    trainerId: 0,
    level: 0,
    exp: 0,
    heldItemId: 0,
    moveIds: []
  };
}

// Pads a box to the full 30 visible/editable positions when parsed data comes back sparse.
function ensureBoxHasAllSlots(box) {
  const slotsByIndex = new Map(box.slots.map(slot => [slot.slotIndex, slot]));
  box.slots = Array.from({ length: BOX_CAPACITY }, (_, slotIndex) =>
    slotsByIndex.get(slotIndex) || buildSyntheticEmptyBoxSlot(box.boxNumber, slotIndex)
  );
}

// Reads one little-endian 16-bit value from a Uint8Array.
function readUint16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

// Reads one little-endian 32-bit value from a Uint8Array.
function readUint32LE(bytes, offset) {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

// Writes one little-endian 16-bit value into a Uint8Array.
function writeUint16LE(bytes, offset, value) {
  bytes[offset] = value & 0xFF;
  bytes[offset + 1] = (value >>> 8) & 0xFF;
}

// Writes one little-endian 32-bit value into a Uint8Array.
function writeUint32LE(bytes, offset, value) {
  bytes[offset] = value & 0xFF;
  bytes[offset + 1] = (value >>> 8) & 0xFF;
  bytes[offset + 2] = (value >>> 16) & 0xFF;
  bytes[offset + 3] = (value >>> 24) & 0xFF;
}

// Decodes one save-format string using the same terminators as the live parser.
function decodeSaveString(bytes, offset, maxLength, characterEncodings) {
  let value = '';
  for (let index = 0; index < maxLength; index += 1) {
    const charCode = bytes[offset + index];
    if (charCode === 0xFF || charCode === 0x00) {
      break;
    }
    value += characterEncodings[charCode] || '';
  }
  return value;
}

// Encodes nicknames and trainer names back into the save's text format.
function encodeSaveString(value, maxLength, encodingMap, keepTrailingZero = false) {
  const bytes = new Uint8Array(maxLength);
  bytes.fill(0xFF);
  const characters = Array.from(String(value ?? ''));
  const writableLength = keepTrailingZero ? maxLength - 1 : maxLength;
  for (let index = 0; index < Math.min(characters.length, writableLength); index += 1) {
    const encoded = encodingMap.get(characters[index]);
    bytes[index] = encoded ?? encodingMap.get('?') ?? 0xAB;
  }
  if (keepTrailingZero) {
    bytes[maxLength - 1] = 0x00;
  }
  return bytes;
}

// Copies one logical-save slice, wrapping around the storage stream when required.
function copyLogicalBytes(logicalSave, entryOffset, entrySize, wrap = false) {
  const out = new Uint8Array(entrySize);
  for (let index = 0; index < entrySize; index += 1) {
    const sourceIndex = wrap ? (entryOffset + index) % logicalSave.length : entryOffset + index;
    out[index] = logicalSave[sourceIndex];
  }
  return out;
}

// Writes one entry-sized slice back into the logical save with the matching wrap rules.
function writeLogicalBytes(logicalSave, entryOffset, entryBytes, wrap = false) {
  for (let index = 0; index < entryBytes.length; index += 1) {
    const targetIndex = wrap ? (entryOffset + index) % logicalSave.length : entryOffset + index;
    logicalSave[targetIndex] = entryBytes[index];
  }
}

// Returns whether the lightweight Radical Red record contains a real stored Pokemon.
function hasValidStoredPokemonMetadata(entryBytes) {
  const language = entryBytes[POKEMON_LANGUAGE_OFFSET];
  const flags = entryBytes[POKEMON_FLAGS_OFFSET];
  return language >= POKEMON_LANGUAGE_MIN
    && language <= POKEMON_LANGUAGE_MAX
    && (flags & POKEMON_HAS_SPECIES_MASK) !== 0;
}

// Builds the folded checksum stored in each active sector footer.
function calculateSectorChecksum(sectorData, size) {
  let checksum = 0;
  const wordCount = Math.floor(size / 4);
  for (let index = 0; index < wordCount; index += 1) {
    checksum = (checksum + readUint32LE(sectorData, index * 4)) >>> 0;
  }
  return ((checksum & 0xFFFF) + (checksum >>> 16)) & 0xFFFF;
}

// Finds the newest physical sector for every logical save sector.
function findActiveSectorOffsets(fileBytes) {
  const activeOffsets = Array(SAVE_SECTOR_COUNT).fill(-1);
  const latestSaveIndices = Array(SAVE_SECTOR_COUNT).fill(-1);
  const saveSize = SAVE_SECTOR_COUNT * SAVE_SLOT_COUNT * SAVE_SECTOR_SIZE;

  for (let offset = 0; offset < saveSize; offset += SAVE_SECTOR_SIZE) {
    const sectorId = readUint16LE(fileBytes, offset + 0x0FF4);
    const saveIndex = readUint32LE(fileBytes, offset + 0x0FFC);
    if (sectorId >= 0 && sectorId < SAVE_SECTOR_COUNT && saveIndex > latestSaveIndices[sectorId]) {
      latestSaveIndices[sectorId] = saveIndex;
      activeOffsets[sectorId] = offset;
    }
  }

  if (activeOffsets.some(offset => offset < 0)) {
    throw new Error('Unable to locate all active save sectors.');
  }

  return activeOffsets;
}

// Reassembles the active scattered sectors into one linear logical save image.
function buildLogicalSave(fileBytes, activeSectorOffsets) {
  const logicalSave = new Uint8Array(SAVE_SECTOR_COUNT * SAVE_SECTOR_DATA_SIZE);
  for (let sectorId = 0; sectorId < SAVE_SECTOR_COUNT; sectorId += 1) {
    const physicalOffset = activeSectorOffsets[sectorId];
    const logicalOffset = sectorId * SAVE_SECTOR_DATA_SIZE;
    logicalSave.set(
      fileBytes.subarray(physicalOffset, physicalOffset + SAVE_SECTOR_DATA_SIZE),
      logicalOffset
    );
  }
  return logicalSave;
}

// Writes the edited logical image back into the file and refreshes sector checksums.
function scatterLogicalSave(fileBytes, logicalSave, activeSectorOffsets) {
  for (let sectorId = 0; sectorId < SAVE_SECTOR_COUNT; sectorId += 1) {
    const physicalOffset = activeSectorOffsets[sectorId];
    const logicalOffset = sectorId * SAVE_SECTOR_DATA_SIZE;
    const sectorData = logicalSave.subarray(logicalOffset, logicalOffset + SAVE_SECTOR_DATA_SIZE);
    fileBytes.set(sectorData, physicalOffset);

    const checksum = calculateSectorChecksum(sectorData, SAVE_SECTOR_CHECKSUM_SIZES[sectorId]);
    writeUint16LE(fileBytes, physicalOffset + 0x0FF6, checksum);
  }
}

// Reads the event flags that reveal which deterministic species pool the save uses.
function readSpeciesRandomizerEventFlags(logicalSave) {
  return Object.fromEntries(
    RANDOMIZER_SPECIES_EVENT_FLAGS.map(flagId => {
      const byteIndex = TRAINER_INFO_LOGICAL_OFFSET + EVENT_FLAG_BASE + (flagId >> 3);
      const bitIndex = flagId & 7;
      return [
        `0x${flagId.toString(16).toLowerCase()}`,
        ((logicalSave[byteIndex] >> bitIndex) & 1) === 1
      ];
    })
  );
}

// Mirrors the repo's branch inference so generated summaries match the main site.
function inferSpeciesRandomizerBranchFromFlags(eventFlags) {
  const hasFlag = flagId => Boolean(eventFlags[`0x${flagId.toString(16).toLowerCase()}`]);
  if (!hasFlag(0x930) && hasFlag(0x104E)) return 'direct_1032';
  if (!hasFlag(0x930) && hasFlag(0x827) && hasFlag(0x93A)) return 'direct_1032';
  if (!hasFlag(0x930) && hasFlag(0x825) && hasFlag(0x93A)) return 'direct_979';
  if (!hasFlag(0x930) && hasFlag(0x53) && hasFlag(0x93A)) return 'direct_927';
  if (!hasFlag(0x930) && hasFlag(0x823) && hasFlag(0x93A)) return 'direct_904';
  if (!hasFlag(0x930) && hasFlag(0x821) && hasFlag(0x93A)) return 'direct_569';
  if (!hasFlag(0x930) && hasFlag(0x93A)) return 'direct_330';
  if (!hasFlag(0x930) && hasFlag(0x940)) return 'direct_1032';
  if (!hasFlag(0x930) && hasFlag(0x94F)) return 'special_132_a';
  if (!hasFlag(0x930) && hasFlag(0x103E)) return 'special_132_b';
  if (hasFlag(0x104A)) return 'special_921';
  return null;
}

// Extracts trainer metadata and randomizer flags from the active logical save.
function parseSaveMetadata(logicalSave, coreData) {
  const trainerName = decodeSaveString(logicalSave, TRAINER_INFO_LOGICAL_OFFSET + NAME_OFFSET, 8, coreData.abilityRandomizer.CHARACTER_ENCODINGS);
  const trainedId = readUint32LE(logicalSave, TRAINER_INFO_LOGICAL_OFFSET + TRAINED_ID_OFFSET);
  const speciesEventFlags = readSpeciesRandomizerEventFlags(logicalSave);
  const branchKey = inferSpeciesRandomizerBranchFromFlags(speciesEventFlags);
  const branches = coreData.randomizerMetadata.RANDOMIZER_SPECIES_BRANCHES || {};
  const pools = coreData.randomizerMetadata.RANDOMIZER_SPECIES_POOLS || {};
  let poolKey = null;

  if (branchKey && branches[branchKey]?.deterministic && typeof branches[branchKey].poolKey === 'string') {
    poolKey = pools[branches[branchKey].poolKey] ? branches[branchKey].poolKey : null;
  }
  if (!poolKey && typeof coreData.randomizerMetadata.DEFAULT_RANDOMIZER_SPECIES_POOL === 'string') {
    poolKey = coreData.randomizerMetadata.DEFAULT_RANDOMIZER_SPECIES_POOL;
  }

  return {
    name: trainerName,
    trainedId,
    hardmode: (logicalSave[GAME_SPECIFIC_LOGICAL_OFFSET + HARDMODE_BITFLAG] & 0x10) !== 0,
    restricted: (logicalSave[GAME_SPECIFIC_LOGICAL_OFFSET + RESTRICTED_BITFLAG] & 0x40) !== 0,
    random: {
      scaledSpecies: (logicalSave[TRAINER_INFO_LOGICAL_OFFSET + SCALED_SPECIES_BITFLAG] & 0x04) !== 0,
      normalSpecies: (logicalSave[TRAINER_INFO_LOGICAL_OFFSET + NORMAL_SPECIES_LEARNSET_ABILITY_BITFLAG] & 0x01) !== 0,
      learnset: (logicalSave[TRAINER_INFO_LOGICAL_OFFSET + NORMAL_SPECIES_LEARNSET_ABILITY_BITFLAG] & 0x02) !== 0,
      abilities: (logicalSave[TRAINER_INFO_LOGICAL_OFFSET + NORMAL_SPECIES_LEARNSET_ABILITY_BITFLAG] & 0x04) !== 0,
      speciesBranchKey: branchKey,
      speciesPoolKey: poolKey,
      speciesEventFlags
    }
  };
}

// Unpacks the 4x10-bit boxed move encoding Radical Red uses for PC storage.
function unpackBoxMoveIds(entryBytes) {
  const packed = (
    entryBytes[BOX_POKEMON_MOVES_OFFSET]
    | (entryBytes[BOX_POKEMON_MOVES_OFFSET + 1] << 8)
    | (entryBytes[BOX_POKEMON_MOVES_OFFSET + 2] << 16)
    | (entryBytes[BOX_POKEMON_MOVES_OFFSET + 3] << 24)
  ) >>> 0;
  const packedHi = entryBytes[BOX_POKEMON_MOVES_OFFSET + 4];
  const full = packed + packedHi * 0x100000000;
  const moveIds = [];

  for (let moveIndex = 0; moveIndex < 4; moveIndex += 1) {
    const moveId = Math.floor(full / (2 ** (moveIndex * 10))) & 0x03FF;
    if (moveId > 0) {
      moveIds.push(moveId);
    }
  }

  return moveIds;
}

// Packs up to four move ids into the 5-byte boxed move representation.
function packBoxMoveIds(moveIds) {
  let packed = 0n;
  for (let moveIndex = 0; moveIndex < 4; moveIndex += 1) {
    const moveId = BigInt(moveIds[moveIndex] || 0);
    packed |= (moveId & 0x03FFn) << BigInt(moveIndex * 10);
  }

  return new Uint8Array([
    Number(packed & 0xFFn),
    Number((packed >> 8n) & 0xFFn),
    Number((packed >> 16n) & 0xFFn),
    Number((packed >> 24n) & 0xFFn),
    Number((packed >> 32n) & 0xFFn)
  ]);
}

// Reads one party slot into a UI-friendly object without mutating the save image.
function parsePartySlot(logicalSave, slotIndex, coreData) {
  const entryOffset = PARTY_POKEMON_LOGICAL_OFFSET + slotIndex * PARTY_POKEMON_SIZE;
  const rawBytes = copyLogicalBytes(logicalSave, entryOffset, PARTY_POKEMON_SIZE, false);
  const speciesId = readUint16LE(rawBytes, PARTY_POKEMON_SPECIES_OFFSET);
  const nickname = decodeSaveString(rawBytes, POKEMON_NAME_OFFSET, POKEMON_NAME_LENGTH, coreData.abilityRandomizer.CHARACTER_ENCODINGS);
  const present = hasValidStoredPokemonMetadata(rawBytes)
    && speciesId > 0
    && speciesId <= MAX_SPECIES_ID
    && nickname.length > 0;

  const moveIds = [];
  for (let moveIndex = 0; moveIndex < 4; moveIndex += 1) {
    const moveId = readUint16LE(rawBytes, PARTY_POKEMON_MOVES_OFFSET + moveIndex * 2);
    if (moveId > 0) {
      moveIds.push(moveId);
    }
  }

  return {
    kind: 'party',
    slotIndex,
    slotNumber: slotIndex + 1,
    entryOffset,
    wrap: false,
    rawBytes,
    present,
    speciesId: present ? speciesId : 0,
    nickname: present ? nickname : '',
    trainerName: decodeSaveString(rawBytes, POKEMON_OT_NAME_OFFSET, POKEMON_OT_NAME_LENGTH, coreData.abilityRandomizer.CHARACTER_ENCODINGS),
    trainerId: readUint32LE(rawBytes, 0x04),
    level: present ? rawBytes[PARTY_POKEMON_LEVEL_OFFSET] : 0,
    exp: present ? readUint32LE(rawBytes, PARTY_POKEMON_EXP_OFFSET) : 0,
    heldItemId: present ? readUint16LE(rawBytes, PARTY_POKEMON_HELD_ITEM_OFFSET) : 0,
    moveIds,
    currentHp: present ? readUint16LE(rawBytes, PARTY_POKEMON_CURRENT_HP_OFFSET) : 0,
    maxHp: present ? readUint16LE(rawBytes, PARTY_POKEMON_MAX_HP_OFFSET) : 0,
    attack: present ? readUint16LE(rawBytes, PARTY_POKEMON_ATTACK_OFFSET) : 0,
    defense: present ? readUint16LE(rawBytes, PARTY_POKEMON_DEFENSE_OFFSET) : 0,
    speed: present ? readUint16LE(rawBytes, PARTY_POKEMON_SPEED_OFFSET) : 0,
    specialAttack: present ? readUint16LE(rawBytes, PARTY_POKEMON_SP_ATTACK_OFFSET) : 0,
    specialDefense: present ? readUint16LE(rawBytes, PARTY_POKEMON_SP_DEFENSE_OFFSET) : 0
  };
}

// Reads one boxed slot into a UI-friendly object and estimates its level from stored exp.
function parseBoxSlot(logicalSave, boxNumber, slotIndex, coreData, logicalOffset, wrap) {
  const rawBytes = copyLogicalBytes(logicalSave, logicalOffset, BOX_POKEMON_SIZE, wrap);
  const speciesId = readUint16LE(rawBytes, BOX_POKEMON_SPECIES_OFFSET);
  const nickname = decodeSaveString(rawBytes, POKEMON_NAME_OFFSET, POKEMON_NAME_LENGTH, coreData.abilityRandomizer.CHARACTER_ENCODINGS);
  const present = hasValidStoredPokemonMetadata(rawBytes)
    && speciesId > 0
    && speciesId <= MAX_SPECIES_ID
    && nickname.length > 0;
  const mon = present ? coreData.species[speciesId] : null;
  const exp = present ? readUint32LE(rawBytes, BOX_POKEMON_EXP_OFFSET) : 0;

  return {
    kind: 'box',
    boxNumber,
    slotIndex,
    slotNumber: slotIndex + 1,
    entryOffset: logicalOffset,
    wrap,
    rawBytes,
    present,
    speciesId: present ? speciesId : 0,
    nickname: present ? nickname : '',
    trainerName: decodeSaveString(rawBytes, POKEMON_OT_NAME_OFFSET, POKEMON_OT_NAME_LENGTH, coreData.abilityRandomizer.CHARACTER_ENCODINGS),
    trainerId: readUint32LE(rawBytes, 0x04),
    level: present && mon ? estimateLevelFromExperience(mon, exp, coreData) : 0,
    exp,
    heldItemId: present ? readUint16LE(rawBytes, BOX_POKEMON_HELD_ITEM_OFFSET) : 0,
    moveIds: present ? unpackBoxMoveIds(rawBytes) : []
  };
}

// Rebuilds every team slot and PC box slot from the current working logical image.
function hydrateSaveState(state, coreData) {
  const rawPartyCount = readUint32LE(state.logicalSave, PARTY_COUNT_LOGICAL_OFFSET);
  state.partyCount = Math.min(PARTY_POKEMON_CAPACITY, Math.max(0, rawPartyCount));
  state.partySlots = Array.from({ length: PARTY_POKEMON_CAPACITY }, (_, slotIndex) => parsePartySlot(state.logicalSave, slotIndex, coreData));
  state.boxes = Array.from({ length: BOX_COUNT }, (_, boxIndex) => ({
    boxNumber: boxIndex + 1,
    slots: []
  }));

  for (let slotIndex = 0; slotIndex < PRIMARY_BOX_COUNT * BOX_CAPACITY; slotIndex += 1) {
    const boxNumber = Math.floor(slotIndex / BOX_CAPACITY) + 1;
    const logicalOffset = BOX_STORAGE_LOGICAL_OFFSET + slotIndex * BOX_POKEMON_SIZE;
    state.boxes[boxNumber - 1].slots.push(
      parseBoxSlot(state.logicalSave, boxNumber, slotIndex % BOX_CAPACITY, coreData, logicalOffset, true)
    );
  }

  for (const region of EXTRA_BOX_REGIONS) {
    const box = state.boxes[region.boxNumber - 1];
    box.slots = [];
    for (let slotIndex = 0; slotIndex < BOX_CAPACITY; slotIndex += 1) {
      box.slots.push(
        parseBoxSlot(
          state.logicalSave,
          region.boxNumber,
          slotIndex,
          coreData,
          region.logicalOffset + slotIndex * BOX_POKEMON_SIZE,
          false
        )
      );
    }
  }

  for (const box of state.boxes) {
    ensureBoxHasAllSlots(box);
  }

  return state;
}

// Loads one save file into editable working state.
export async function loadSaveFile(file, coreData) {
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const activeSectorOffsets = findActiveSectorOffsets(fileBytes);
  const logicalSave = buildLogicalSave(fileBytes, activeSectorOffsets);
  const state = {
    fileName: file.name,
    fileBytes,
    activeSectorOffsets,
    logicalSave,
    metadata: parseSaveMetadata(logicalSave, coreData)
  };
  return hydrateSaveState(state, coreData);
}

// Returns a compact flag summary for the loaded save.
export function formatSaveFlags(metadata) {
  const flags = [];
  if (metadata.hardmode) {
    flags.push('Hardcore');
  } else if (metadata.restricted) {
    flags.push('Restricted');
  }
  if (metadata.random.normalSpecies) {
    flags.push('Random Species');
  }
  if (metadata.random.abilities) {
    flags.push('Random Abilities');
  }
  if (metadata.random.learnset) {
    flags.push('Random Learnset');
  }
  return flags.length ? flags.join(' / ') : 'No changes';
}

// Chooses a stable personality value while forcing a neutral nature for generated stats.
function buildPersonalityValue(trainedId, speciesId, positionSeed) {
  let value = (
    Math.imul((trainedId >>> 0) || 1, 1664525)
    + Math.imul((speciesId >>> 0) || 1, 1013904223)
    + positionSeed * 97
  ) >>> 0;
  value = (value - (value % 25)) >>> 0;
  return value === 0 ? 25 : value;
}

// Selects an occupied party slot as a donor so unknown bytes stay close to a real save entry.
function findPartyDonorBytes(state) {
  return state.partySlots.find(slot => slot.present)?.rawBytes || PARTY_TEMPLATE_BYTES;
}

// Selects an occupied box slot as a donor so boxed entries inherit valid metadata bytes.
// Prefer the same slot index across other boxes because that tends to preserve the most stable box-only data.
function findBoxDonorBytes(state, preferredSlotIndex = null) {
  if (Number.isInteger(preferredSlotIndex)) {
    for (const box of state.boxes) {
      const donor = box.slots.find(slot => slot.present && slot.slotIndex === preferredSlotIndex);
      if (donor) {
        return donor.rawBytes;
      }
    }
  }

  for (const box of state.boxes) {
    const donor = box.slots.find(slot => slot.present);
    if (donor) {
      return donor.rawBytes;
    }
  }
  return BOX_TEMPLATE_BYTES;
}

// Creates one fully populated party record from a target species and the save's trainer metadata.
function buildPartyEntry(speciesId, slotIndex, state, coreData) {
  const mon = coreData.species[speciesId];
  if (!mon) {
    throw new Error(`Unknown species id ${speciesId}.`);
  }

  const blueprint = buildPokemonBlueprint(mon, state.metadata, coreData, 5);
  const donorBytes = state.partySlots[slotIndex]?.present
    ? state.partySlots[slotIndex].rawBytes
    : findPartyDonorBytes(state);
  const entryBytes = new Uint8Array(donorBytes);
  const personality = buildPersonalityValue(state.metadata.trainedId, speciesId, slotIndex + 1);

  writeUint32LE(entryBytes, 0x00, personality);
  writeUint32LE(entryBytes, 0x04, state.metadata.trainedId);
  entryBytes.set(encodeSaveString(mon.name, POKEMON_NAME_LENGTH, coreData.characterEncodingMap), POKEMON_NAME_OFFSET);
  entryBytes.set(encodeSaveString(state.metadata.name, POKEMON_OT_NAME_LENGTH, coreData.characterEncodingMap, true), POKEMON_OT_NAME_OFFSET);
  entryBytes[POKEMON_LANGUAGE_OFFSET] = entryBytes[POKEMON_LANGUAGE_OFFSET] || 0x02;
  entryBytes[POKEMON_FLAGS_OFFSET] |= POKEMON_HAS_SPECIES_MASK;
  writeUint16LE(entryBytes, PARTY_POKEMON_SPECIES_OFFSET, speciesId);
  writeUint16LE(entryBytes, PARTY_POKEMON_HELD_ITEM_OFFSET, 0);
  writeUint32LE(entryBytes, PARTY_POKEMON_EXP_OFFSET, blueprint.exp);
  entryBytes.subarray(PARTY_POKEMON_MOVES_OFFSET, PARTY_POKEMON_MOVES_OFFSET + 8).fill(0);
  entryBytes.subarray(PARTY_POKEMON_PP_OFFSET, PARTY_POKEMON_PP_OFFSET + 4).fill(0);

  blueprint.moveIds.forEach((moveId, moveIndex) => {
    writeUint16LE(entryBytes, PARTY_POKEMON_MOVES_OFFSET + moveIndex * 2, moveId);
    entryBytes[PARTY_POKEMON_PP_OFFSET + moveIndex] = blueprint.pp[moveIndex];
  });

  writeUint32LE(entryBytes, PARTY_POKEMON_IVS_OFFSET, ALL_31_IVS_BITFIELD);
  entryBytes.subarray(0x4C, 0x54).fill(0);
  entryBytes[PARTY_POKEMON_LEVEL_OFFSET] = blueprint.level;
  entryBytes[PARTY_POKEMON_LEVEL_OFFSET + 1] = 0xFF;
  writeUint16LE(entryBytes, PARTY_POKEMON_CURRENT_HP_OFFSET, blueprint.stats.maxHp);
  writeUint16LE(entryBytes, PARTY_POKEMON_MAX_HP_OFFSET, blueprint.stats.maxHp);
  writeUint16LE(entryBytes, PARTY_POKEMON_ATTACK_OFFSET, blueprint.stats.attack);
  writeUint16LE(entryBytes, PARTY_POKEMON_DEFENSE_OFFSET, blueprint.stats.defense);
  writeUint16LE(entryBytes, PARTY_POKEMON_SPEED_OFFSET, blueprint.stats.speed);
  writeUint16LE(entryBytes, PARTY_POKEMON_SP_ATTACK_OFFSET, blueprint.stats.specialAttack);
  writeUint16LE(entryBytes, PARTY_POKEMON_SP_DEFENSE_OFFSET, blueprint.stats.specialDefense);

  return entryBytes;
}

// Creates one fully populated boxed entry using the known 58-byte Radical Red box format.
function buildBoxEntry(speciesId, boxNumber, slotIndex, state, coreData) {
  const mon = coreData.species[speciesId];
  if (!mon) {
    throw new Error(`Unknown species id ${speciesId}.`);
  }

  const blueprint = buildPokemonBlueprint(mon, state.metadata, coreData, 5);
  const existingSlot = state.boxes[boxNumber - 1].slots[slotIndex];
  const reusesOccupiedSlot = Boolean(existingSlot?.present);
  const donorBytes = existingSlot?.present ? existingSlot.rawBytes : findBoxDonorBytes(state, slotIndex);
  const entryBytes = new Uint8Array(donorBytes);

  // Brand-new box slots are the most fragile case, so always start from a real donor and only change the
  // minimum identity bytes unless the slot was already occupied.
  entryBytes.set(encodeSaveString(mon.name, POKEMON_NAME_LENGTH, coreData.characterEncodingMap), POKEMON_NAME_OFFSET);
  entryBytes[POKEMON_LANGUAGE_OFFSET] = entryBytes[POKEMON_LANGUAGE_OFFSET] || 0x02;
  entryBytes[POKEMON_FLAGS_OFFSET] |= POKEMON_HAS_SPECIES_MASK;
  writeUint16LE(entryBytes, BOX_POKEMON_SPECIES_OFFSET, speciesId);

  if (reusesOccupiedSlot) {
    // Replacing an already-real slot is much safer because the hidden storage bytes are already initialized.
    entryBytes.set(encodeSaveString(state.metadata.name, POKEMON_OT_NAME_LENGTH, coreData.characterEncodingMap, true), POKEMON_OT_NAME_OFFSET);
    writeUint16LE(entryBytes, BOX_POKEMON_HELD_ITEM_OFFSET, 0);
    writeUint32LE(entryBytes, BOX_POKEMON_EXP_OFFSET, blueprint.exp);
    entryBytes.set(packBoxMoveIds(blueprint.moveIds), BOX_POKEMON_MOVES_OFFSET);
    writeUint32LE(entryBytes, BOX_POKEMON_IVS_OFFSET, ALL_31_IVS_BITFIELD);
  }

  return entryBytes;
}

// Applies one species replacement to a selected party slot and refreshes derived state.
export function applyPartySpeciesChange(state, slotIndex, speciesId, coreData) {
  const entryBytes = buildPartyEntry(speciesId, slotIndex, state, coreData);
  const entryOffset = PARTY_POKEMON_LOGICAL_OFFSET + slotIndex * PARTY_POKEMON_SIZE;
  writeLogicalBytes(state.logicalSave, entryOffset, entryBytes, false);
  const nextPartyCount = Math.max(readUint32LE(state.logicalSave, PARTY_COUNT_LOGICAL_OFFSET), slotIndex + 1);
  writeUint32LE(state.logicalSave, PARTY_COUNT_LOGICAL_OFFSET, nextPartyCount);
  hydrateSaveState(state, coreData);
}

// Applies one species replacement to a selected box slot and refreshes derived state.
export function applyBoxSpeciesChange(state, boxNumber, slotIndex, speciesId, coreData) {
  const existingSlot = state.boxes[boxNumber - 1]?.slots?.[slotIndex] || buildSyntheticEmptyBoxSlot(boxNumber, slotIndex);
  const entryBytes = buildBoxEntry(speciesId, boxNumber, slotIndex, state, coreData);
  writeLogicalBytes(state.logicalSave, existingSlot.entryOffset, entryBytes, existingSlot.wrap);
  hydrateSaveState(state, coreData);
}

// Builds a downloadable edited save file while preserving the original slot layout and checksums.
export function exportEditedSave(state) {
  const outputBytes = new Uint8Array(state.fileBytes);
  scatterLogicalSave(outputBytes, state.logicalSave, state.activeSectorOffsets);
  return outputBytes;
}

// Derives a safe download name for the edited save file.
export function buildOutputFileName(inputName) {
  if (!inputName) {
    return 'rr-save-edited.sav';
  }

  return inputName.toLowerCase().endsWith('.sav')
    ? `${inputName.slice(0, -4)}.edited.sav`
    : `${inputName}.edited.sav`;
}
