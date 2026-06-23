import { buildPokemonBlueprint, estimateLevelFromExperience, isHardcoreMoveLegal } from './pokemonLogic.js';

const NAME_OFFSET = 0x000;
const TRAINED_ID_OFFSET = 0x00A;
const SAVE_SECTOR_COUNT = 14;
const SAVE_SLOT_COUNT = 2;
const SAVE_SECTOR_SIZE = 0x1000;
const SAVE_SECTOR_DATA_SIZE = 0x0FF4;
const EXTRA_BOX_SECTOR_DATA_SIZE = 0x0FF0;
const SAVE_SECTOR_CHECKSUM_SIZES = [
  0x0F24,
  0x0FF0,
  0x0FF0,
  0x0FF0,
  0x0D98,
  0x0FF0,
  0x0FF0,
  0x0FF0,
  0x0FF0,
  0x0FF0,
  0x0FF0,
  0x0FF0,
  0x0FF0,
  0x0450
];
const SAVE_BLOCK2_SIZE = SAVE_SECTOR_CHECKSUM_SIZES[0];
const SAVE_BLOCK1_CHUNK_SIZES = SAVE_SECTOR_CHECKSUM_SIZES.slice(1, 5);
const POKEMON_STORAGE_CHUNK_SIZES = SAVE_SECTOR_CHECKSUM_SIZES.slice(5);
const SAVE_BLOCK1_SIZE = SAVE_BLOCK1_CHUNK_SIZES.reduce((sum, size) => sum + size, 0);
const POKEMON_STORAGE_SIZE = POKEMON_STORAGE_CHUNK_SIZES.reduce((sum, size) => sum + size, 0);
const EXTRA_BOX_STORAGE_SIZE = EXTRA_BOX_SECTOR_DATA_SIZE * 2;
const EXTRA_BOX_SECTOR_IDS = [30, 31];
const SAVE_BLOCK1_FLAGS_OFFSET = 0x0EE0;
const PARTY_COUNT_SAVE_BLOCK1_OFFSET = 0x0034;
const PARTY_POKEMON_SAVE_BLOCK1_OFFSET = 0x0038;
const PARTY_POKEMON_SIZE = 100;
const PARTY_POKEMON_CAPACITY = 6;
const PC_ITEM_STORAGE_OFFSET = 0x0298;
const PC_ITEM_COUNT = 30;
const PC_ITEM_SLOT_SIZE = 4;
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
const POKEMON_STORAGE_PRIMARY_BOX_OFFSET = 0x0004;
const BOX_POKEMON_SIZE = 58;
const BOX_CAPACITY = 30;
const BOX_COUNT = 25;
const PRIMARY_BOX_COUNT = 19;
const BOX_20_SAVE_OFFSET = 0x0B0C;
const BOX_23_SAVE_BLOCK1_OFFSET = 0x1F08;
const BOX_24_SAVE_BLOCK1_OFFSET = BOX_23_SAVE_BLOCK1_OFFSET + BOX_CAPACITY * BOX_POKEMON_SIZE;
const BOX_25_SAVE_BLOCK2_OFFSET = 0x00B0;
const POKEMON_NAME_OFFSET = 0x08;
const POKEMON_NAME_LENGTH = 10;
const POKEMON_LANGUAGE_OFFSET = 0x12;
const POKEMON_FLAGS_OFFSET = 0x13;
const POKEMON_OT_NAME_OFFSET = 0x14;
const POKEMON_OT_NAME_LENGTH = 7;
const POKEMON_MARKINGS_OFFSET = 0x1B;
const POKEMON_HAS_SPECIES_MASK = 0x02;
const POKEMON_LANGUAGE_MIN = 0x01;
const POKEMON_LANGUAGE_MAX = 0x07;
const BOX_POKEMON_SPECIES_OFFSET = 0x1C;
const BOX_POKEMON_HELD_ITEM_OFFSET = 0x1E;
const BOX_POKEMON_EXP_OFFSET = 0x20;
const BOX_POKEMON_PP_BONUSES_OFFSET = 0x24;
const BOX_POKEMON_FRIENDSHIP_OFFSET = 0x25;
const BOX_POKEMON_POKEBALL_OFFSET = 0x26;
const BOX_POKEMON_MOVES_OFFSET = 0x27;
const BOX_POKEMON_EVS_OFFSET = 0x2C;
const BOX_POKEMON_POKERUS_OFFSET = 0x32;
const BOX_POKEMON_MET_LOCATION_OFFSET = 0x33;
const BOX_POKEMON_MET_INFO_OFFSET = 0x34;
const BOX_POKEMON_IVS_OFFSET = 0x36;
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
const DEFAULT_LANGUAGE = 0x02;
const DEFAULT_FRIENDSHIP = 70;
const DEFAULT_MET_GAME = 0x04;
const DEFAULT_POKEBALL_ID = 0x03;
const ALL_31_IVS_BITFIELD = 0x3FFFFFFF;
const PARTY_TEMPLATE_HEX = 'f37706ef909346ffc4dde6d5d7dcddff2c220202c2ffffffffffff000000000099018b00dd0000000065030011015d009c0000000a190523000000000000000000000000009d0502ffffff3f000000000000000005ff19001a00100010000e0010001100';

// Converts a compact hex template into mutable bytes for fallback party entry creation.
function hexToBytes(hex) {
  const clean = hex.trim();
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

const PARTY_TEMPLATE_BYTES = hexToBytes(PARTY_TEMPLATE_HEX);

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
function encodeSaveString(value, maxLength, encodingMap) {
  const bytes = new Uint8Array(maxLength);
  bytes.fill(0xFF);
  const characters = Array.from(String(value ?? ''));
  for (let index = 0; index < Math.min(characters.length, maxLength); index += 1) {
    const encoded = encodingMap.get(characters[index]);
    bytes[index] = encoded ?? encodingMap.get('?') ?? 0xAB;
  }
  return bytes;
}

// Copies one byte slice into a standalone buffer so callers can mutate safely.
function copyBufferBytes(bytes, offset, size) {
  return bytes.slice(offset, offset + size);
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

// Locates the newest valid physical sector for every logical RR save chunk.
function findActiveSectorOffsets(fileBytes) {
  const activeOffsets = Array(SAVE_SECTOR_COUNT).fill(-1);
  const latestCounters = Array(SAVE_SECTOR_COUNT).fill(-1);
  const saveSize = SAVE_SECTOR_COUNT * SAVE_SLOT_COUNT * SAVE_SECTOR_SIZE;

  for (let offset = 0; offset < saveSize; offset += SAVE_SECTOR_SIZE) {
    const sectorId = readUint16LE(fileBytes, offset + 0x0FF4);
    if (sectorId < 0 || sectorId >= SAVE_SECTOR_COUNT) {
      continue;
    }

    const expectedChecksum = calculateSectorChecksum(
      fileBytes.subarray(offset, offset + SAVE_SECTOR_CHECKSUM_SIZES[sectorId]),
      SAVE_SECTOR_CHECKSUM_SIZES[sectorId]
    );
    const storedChecksum = readUint16LE(fileBytes, offset + 0x0FF6);
    if (storedChecksum !== expectedChecksum) {
      continue;
    }

    const saveCounter = readUint32LE(fileBytes, offset + 0x0FFC);
    if (saveCounter > latestCounters[sectorId]) {
      latestCounters[sectorId] = saveCounter;
      activeOffsets[sectorId] = offset;
    }
  }

  if (activeOffsets.some(offset => offset < 0)) {
    throw new Error('Unable to locate all active save sectors.');
  }

  return activeOffsets;
}

// Reassembles the save chunks the game actually serializes instead of assuming vanilla layout.
function buildSaveBlocks(fileBytes, activeSectorOffsets) {
  const saveBlock2 = copyBufferBytes(fileBytes, activeSectorOffsets[0], SAVE_BLOCK2_SIZE);
  const saveBlock1 = new Uint8Array(SAVE_BLOCK1_SIZE);
  const pokemonStorage = new Uint8Array(POKEMON_STORAGE_SIZE);
  const extraBoxStorage = new Uint8Array(EXTRA_BOX_STORAGE_SIZE);

  let cursor = 0;
  for (let index = 0; index < SAVE_BLOCK1_CHUNK_SIZES.length; index += 1) {
    const size = SAVE_BLOCK1_CHUNK_SIZES[index];
    const sectorOffset = activeSectorOffsets[index + 1];
    saveBlock1.set(fileBytes.subarray(sectorOffset, sectorOffset + size), cursor);
    cursor += size;
  }

  cursor = 0;
  for (let index = 0; index < POKEMON_STORAGE_CHUNK_SIZES.length; index += 1) {
    const size = POKEMON_STORAGE_CHUNK_SIZES[index];
    const sectorOffset = activeSectorOffsets[index + 5];
    pokemonStorage.set(fileBytes.subarray(sectorOffset, sectorOffset + size), cursor);
    cursor += size;
  }

  EXTRA_BOX_SECTOR_IDS.forEach((sectorId, index) => {
    const fileOffset = sectorId * SAVE_SECTOR_SIZE;
    extraBoxStorage.set(
      fileBytes.subarray(fileOffset, fileOffset + EXTRA_BOX_SECTOR_DATA_SIZE),
      index * EXTRA_BOX_SECTOR_DATA_SIZE
    );
  });

  return { saveBlock1, saveBlock2, pokemonStorage, extraBoxStorage };
}

// Writes the edited save chunks back into their physical sectors with RR's checksum sizes.
function scatterSaveBlocks(fileBytes, state) {
  const { activeSectorOffsets, saveBlock1, saveBlock2, pokemonStorage, extraBoxStorage } = state;

  fileBytes.set(saveBlock2, activeSectorOffsets[0]);
  writeUint16LE(
    fileBytes,
    activeSectorOffsets[0] + 0x0FF6,
    calculateSectorChecksum(saveBlock2, SAVE_BLOCK2_SIZE)
  );

  let cursor = 0;
  for (let index = 0; index < SAVE_BLOCK1_CHUNK_SIZES.length; index += 1) {
    const size = SAVE_BLOCK1_CHUNK_SIZES[index];
    const sectorOffset = activeSectorOffsets[index + 1];
    const chunk = saveBlock1.subarray(cursor, cursor + size);
    fileBytes.set(chunk, sectorOffset);
    writeUint16LE(fileBytes, sectorOffset + 0x0FF6, calculateSectorChecksum(chunk, size));
    cursor += size;
  }

  cursor = 0;
  for (let index = 0; index < POKEMON_STORAGE_CHUNK_SIZES.length; index += 1) {
    const size = POKEMON_STORAGE_CHUNK_SIZES[index];
    const sectorOffset = activeSectorOffsets[index + 5];
    const chunk = pokemonStorage.subarray(cursor, cursor + size);
    fileBytes.set(chunk, sectorOffset);
    writeUint16LE(fileBytes, sectorOffset + 0x0FF6, calculateSectorChecksum(chunk, size));
    cursor += size;
  }

  EXTRA_BOX_SECTOR_IDS.forEach((sectorId, index) => {
    const fileOffset = sectorId * SAVE_SECTOR_SIZE;
    const sourceOffset = index * EXTRA_BOX_SECTOR_DATA_SIZE;
    fileBytes.set(
      extraBoxStorage.subarray(sourceOffset, sourceOffset + EXTRA_BOX_SECTOR_DATA_SIZE),
      fileOffset
    );
  });
}

// Reads the event flags that reveal which deterministic species pool the save uses.
function readSpeciesRandomizerEventFlags(saveBlock1) {
  return Object.fromEntries(
    RANDOMIZER_SPECIES_EVENT_FLAGS.map(flagId => {
      const byteIndex = SAVE_BLOCK1_FLAGS_OFFSET + (flagId >> 3);
      const bitIndex = flagId & 7;
      return [
        `0x${flagId.toString(16).toLowerCase()}`,
        ((saveBlock1[byteIndex] >> bitIndex) & 1) === 1
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

// Extracts trainer metadata and randomizer flags from the active save blocks.
function parseSaveMetadata(saveBlocks, coreData) {
  const trainerName = decodeSaveString(
    saveBlocks.saveBlock2,
    NAME_OFFSET,
    8,
    coreData.abilityRandomizer.CHARACTER_ENCODINGS
  );
  const trainedId = readUint32LE(saveBlocks.saveBlock2, TRAINED_ID_OFFSET);
  const speciesEventFlags = readSpeciesRandomizerEventFlags(saveBlocks.saveBlock1);
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
    playerGender: saveBlocks.saveBlock2[0x08] || 0,
    hardmode: (saveBlocks.saveBlock1[HARDMODE_BITFLAG] & 0x10) !== 0,
    restricted: (saveBlocks.saveBlock1[RESTRICTED_BITFLAG] & 0x40) !== 0,
    random: {
      scaledSpecies: (saveBlocks.saveBlock1[SCALED_SPECIES_BITFLAG] & 0x04) !== 0,
      normalSpecies: (saveBlocks.saveBlock1[NORMAL_SPECIES_LEARNSET_ABILITY_BITFLAG] & 0x01) !== 0,
      learnset: (saveBlocks.saveBlock1[NORMAL_SPECIES_LEARNSET_ABILITY_BITFLAG] & 0x02) !== 0,
      abilities: (saveBlocks.saveBlock1[NORMAL_SPECIES_LEARNSET_ABILITY_BITFLAG] & 0x04) !== 0,
      speciesBranchKey: branchKey,
      speciesPoolKey: poolKey,
      speciesEventFlags
    }
  };
}

// Unpacks the 4x10-bit boxed move encoding Radical Red uses for PC storage.
function unpackBoxMoveIds(entryBytes) {
  let packed = 0n;
  for (let index = 0; index < 5; index += 1) {
    packed |= BigInt(entryBytes[BOX_POKEMON_MOVES_OFFSET + index]) << BigInt(index * 8);
  }

  const moveIds = [];
  for (let moveIndex = 0; moveIndex < 4; moveIndex += 1) {
    const moveId = Number((packed >> BigInt(moveIndex * 10)) & 0x03FFn);
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

// Returns the underlying editable buffer for one storage region key.
function getStateBuffer(state, storageKey) {
  switch (storageKey) {
    case 'saveBlock1':
      return state.saveBlock1;
    case 'saveBlock2':
      return state.saveBlock2;
    case 'pokemonStorage':
      return state.pokemonStorage;
    case 'extraBoxStorage':
      return state.extraBoxStorage;
    default:
      throw new Error(`Unknown save buffer "${storageKey}".`);
  }
}

// Maps one visible box slot to the real RR save buffer and entry offset.
function getBoxSlotLocation(boxNumber, slotIndex) {
  if (boxNumber >= 1 && boxNumber <= PRIMARY_BOX_COUNT) {
    return {
      storageKey: 'pokemonStorage',
      entryOffset: POKEMON_STORAGE_PRIMARY_BOX_OFFSET
        + (((boxNumber - 1) * BOX_CAPACITY) + slotIndex) * BOX_POKEMON_SIZE
    };
  }

  if (boxNumber >= 20 && boxNumber <= 22) {
    return {
      storageKey: 'extraBoxStorage',
      entryOffset: BOX_20_SAVE_OFFSET
        + ((boxNumber - 20) * BOX_CAPACITY + slotIndex) * BOX_POKEMON_SIZE
    };
  }

  if (boxNumber === 23) {
    return {
      storageKey: 'saveBlock1',
      entryOffset: BOX_23_SAVE_BLOCK1_OFFSET + slotIndex * BOX_POKEMON_SIZE
    };
  }

  if (boxNumber === 24) {
    return {
      storageKey: 'saveBlock1',
      entryOffset: BOX_24_SAVE_BLOCK1_OFFSET + slotIndex * BOX_POKEMON_SIZE
    };
  }

  if (boxNumber === 25) {
    return {
      storageKey: 'saveBlock2',
      entryOffset: BOX_25_SAVE_BLOCK2_OFFSET + slotIndex * BOX_POKEMON_SIZE
    };
  }

  throw new Error(`Unsupported box number ${boxNumber}.`);
}

// Builds a placeholder empty boxed slot so the editor can still target sparse data safely.
function buildSyntheticEmptyBoxSlot(boxNumber, slotIndex) {
  const { storageKey, entryOffset } = getBoxSlotLocation(boxNumber, slotIndex);
  return {
    kind: 'box',
    boxNumber,
    slotIndex,
    slotNumber: slotIndex + 1,
    storageKey,
    entryOffset,
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

// Reads one party slot into a UI-friendly object without mutating the save image.
function parsePartySlot(saveBlock1, slotIndex, coreData) {
  const entryOffset = PARTY_POKEMON_SAVE_BLOCK1_OFFSET + slotIndex * PARTY_POKEMON_SIZE;
  const rawBytes = copyBufferBytes(saveBlock1, entryOffset, PARTY_POKEMON_SIZE);
  const speciesId = readUint16LE(rawBytes, PARTY_POKEMON_SPECIES_OFFSET);
  const nickname = decodeSaveString(
    rawBytes,
    POKEMON_NAME_OFFSET,
    POKEMON_NAME_LENGTH,
    coreData.abilityRandomizer.CHARACTER_ENCODINGS
  );
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
    storageKey: 'saveBlock1',
    entryOffset,
    rawBytes,
    present,
    speciesId: present ? speciesId : 0,
    nickname: present ? nickname : '',
    trainerName: decodeSaveString(
      rawBytes,
      POKEMON_OT_NAME_OFFSET,
      POKEMON_OT_NAME_LENGTH,
      coreData.abilityRandomizer.CHARACTER_ENCODINGS
    ),
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
function parseBoxSlot(state, boxNumber, slotIndex, coreData) {
  const { storageKey, entryOffset } = getBoxSlotLocation(boxNumber, slotIndex);
  const buffer = getStateBuffer(state, storageKey);
  const rawBytes = copyBufferBytes(buffer, entryOffset, BOX_POKEMON_SIZE);
  const speciesId = readUint16LE(rawBytes, BOX_POKEMON_SPECIES_OFFSET);
  const nickname = decodeSaveString(
    rawBytes,
    POKEMON_NAME_OFFSET,
    POKEMON_NAME_LENGTH,
    coreData.abilityRandomizer.CHARACTER_ENCODINGS
  );
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
    storageKey,
    entryOffset,
    rawBytes,
    present,
    speciesId: present ? speciesId : 0,
    nickname: present ? nickname : '',
    trainerName: decodeSaveString(
      rawBytes,
      POKEMON_OT_NAME_OFFSET,
      POKEMON_OT_NAME_LENGTH,
      coreData.abilityRandomizer.CHARACTER_ENCODINGS
    ),
    trainerId: readUint32LE(rawBytes, 0x04),
    level: present && mon ? estimateLevelFromExperience(mon, exp, coreData) : 0,
    exp,
    heldItemId: present ? readUint16LE(rawBytes, BOX_POKEMON_HELD_ITEM_OFFSET) : 0,
    moveIds: present ? unpackBoxMoveIds(rawBytes) : []
  };
}

// Reads one PC item storage slot into a UI-friendly object.
function parsePcItemSlot(saveBlock1, slotIndex) {
  const entryOffset = PC_ITEM_STORAGE_OFFSET + slotIndex * PC_ITEM_SLOT_SIZE;
  const itemId = readUint16LE(saveBlock1, entryOffset);
  const quantity = readUint16LE(saveBlock1, entryOffset + 2);

  return {
    slotIndex,
    slotNumber: slotIndex + 1,
    entryOffset,
    itemId,
    quantity,
    present: itemId > 0 && quantity > 0
  };
}

// Rebuilds every team slot and PC box slot from the current working save buffers.
function hydrateSaveState(state, coreData) {
  const rawPartyCount = state.saveBlock1[PARTY_COUNT_SAVE_BLOCK1_OFFSET] || 0;
  state.partyCount = Math.min(PARTY_POKEMON_CAPACITY, Math.max(0, rawPartyCount));
  state.partySlots = Array.from(
    { length: PARTY_POKEMON_CAPACITY },
    (_, slotIndex) => parsePartySlot(state.saveBlock1, slotIndex, coreData)
  );
  state.boxes = Array.from({ length: BOX_COUNT }, (_, boxIndex) => ({
    boxNumber: boxIndex + 1,
    slots: []
  }));
  state.pcItems = Array.from(
    { length: PC_ITEM_COUNT },
    (_, slotIndex) => parsePcItemSlot(state.saveBlock1, slotIndex)
  );

  for (let boxNumber = 1; boxNumber <= BOX_COUNT; boxNumber += 1) {
    const box = state.boxes[boxNumber - 1];
    for (let slotIndex = 0; slotIndex < BOX_CAPACITY; slotIndex += 1) {
      box.slots.push(parseBoxSlot(state, boxNumber, slotIndex, coreData));
    }
    ensureBoxHasAllSlots(box);
  }

  return state;
}

// Loads one save file into editable working state.
export async function loadSaveFile(file, coreData) {
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const activeSectorOffsets = findActiveSectorOffsets(fileBytes);
  const saveBlocks = buildSaveBlocks(fileBytes, activeSectorOffsets);
  const state = {
    fileName: file.name,
    fileBytes,
    activeSectorOffsets,
    ...saveBlocks,
    metadata: parseSaveMetadata(saveBlocks, coreData)
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

// Chooses a stable personality value while forcing neutral nature and the primary ability slot.
function buildPersonalityValue(trainedId, speciesId, positionSeed) {
  let value = (
    Math.imul((trainedId >>> 0) || 1, 1664525)
    + Math.imul((speciesId >>> 0) || 1, 1013904223)
    + positionSeed * 97
  ) >>> 0;
  value = (value - (value % 50)) >>> 0;
  return value === 0 ? 50 : value;
}

// Selects an occupied party slot as a donor so unknown bytes stay close to a real save entry.
function findPartyDonorBytes(state) {
  return state.partySlots.find(slot => slot.present)?.rawBytes || PARTY_TEMPLATE_BYTES;
}

// Selects an occupied box slot as a donor so met-location defaults stay close to the real save.
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

  return new Uint8Array(BOX_POKEMON_SIZE);
}

// Packs the level, game id, and OT gender bits into RR's compressed met-info field.
function buildMetInfo(level, playerGender) {
  return ((level & 0x7F) | (DEFAULT_MET_GAME << 7) | ((playerGender & 0x01) << 15)) & 0xFFFF;
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
  entryBytes.set(
    encodeSaveString(mon.name, POKEMON_NAME_LENGTH, coreData.characterEncodingMap),
    POKEMON_NAME_OFFSET
  );
  entryBytes[POKEMON_LANGUAGE_OFFSET] = entryBytes[POKEMON_LANGUAGE_OFFSET] || DEFAULT_LANGUAGE;
  entryBytes[POKEMON_FLAGS_OFFSET] = POKEMON_HAS_SPECIES_MASK;
  entryBytes.set(
    encodeSaveString(state.metadata.name, POKEMON_OT_NAME_LENGTH, coreData.characterEncodingMap),
    POKEMON_OT_NAME_OFFSET
  );
  entryBytes[POKEMON_MARKINGS_OFFSET] = 0;
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

// Creates one fully populated boxed entry using RR's 58-byte compressed box format.
function buildBoxEntry(speciesId, boxNumber, slotIndex, state, coreData) {
  const mon = coreData.species[speciesId];
  if (!mon) {
    throw new Error(`Unknown species id ${speciesId}.`);
  }

  const blueprint = buildPokemonBlueprint(mon, state.metadata, coreData, 5);
  const existingSlot = state.boxes[boxNumber - 1]?.slots?.[slotIndex];
  const donorBytes = existingSlot?.present ? existingSlot.rawBytes : findBoxDonorBytes(state, slotIndex);
  const donorLanguage = donorBytes[POKEMON_LANGUAGE_OFFSET];
  const donorMetLocation = donorBytes[BOX_POKEMON_MET_LOCATION_OFFSET];
  const personality = buildPersonalityValue(
    state.metadata.trainedId,
    speciesId,
    ((boxNumber - 1) * BOX_CAPACITY) + slotIndex + 1
  );
  const entryBytes = new Uint8Array(BOX_POKEMON_SIZE);

  writeUint32LE(entryBytes, 0x00, personality);
  writeUint32LE(entryBytes, 0x04, state.metadata.trainedId);
  entryBytes.set(
    encodeSaveString(mon.name, POKEMON_NAME_LENGTH, coreData.characterEncodingMap),
    POKEMON_NAME_OFFSET
  );
  entryBytes[POKEMON_LANGUAGE_OFFSET] = donorLanguage >= POKEMON_LANGUAGE_MIN && donorLanguage <= POKEMON_LANGUAGE_MAX
    ? donorLanguage
    : DEFAULT_LANGUAGE;
  entryBytes[POKEMON_FLAGS_OFFSET] = POKEMON_HAS_SPECIES_MASK;
  entryBytes.set(
    encodeSaveString(state.metadata.name, POKEMON_OT_NAME_LENGTH, coreData.characterEncodingMap),
    POKEMON_OT_NAME_OFFSET
  );
  entryBytes[POKEMON_MARKINGS_OFFSET] = existingSlot?.present ? existingSlot.rawBytes[POKEMON_MARKINGS_OFFSET] : 0;

  writeUint16LE(entryBytes, BOX_POKEMON_SPECIES_OFFSET, speciesId);
  writeUint16LE(entryBytes, BOX_POKEMON_HELD_ITEM_OFFSET, 0);
  writeUint32LE(entryBytes, BOX_POKEMON_EXP_OFFSET, blueprint.exp);
  entryBytes[BOX_POKEMON_PP_BONUSES_OFFSET] = 0;
  entryBytes[BOX_POKEMON_FRIENDSHIP_OFFSET] = DEFAULT_FRIENDSHIP;
  entryBytes[BOX_POKEMON_POKEBALL_OFFSET] = DEFAULT_POKEBALL_ID;
  entryBytes.set(packBoxMoveIds(blueprint.moveIds), BOX_POKEMON_MOVES_OFFSET);
  entryBytes.subarray(BOX_POKEMON_EVS_OFFSET, BOX_POKEMON_EVS_OFFSET + 6).fill(0);
  entryBytes[BOX_POKEMON_POKERUS_OFFSET] = 0;
  entryBytes[BOX_POKEMON_MET_LOCATION_OFFSET] = donorMetLocation || 0;
  writeUint16LE(
    entryBytes,
    BOX_POKEMON_MET_INFO_OFFSET,
    buildMetInfo(blueprint.level, state.metadata.playerGender)
  );
  writeUint32LE(entryBytes, BOX_POKEMON_IVS_OFFSET, ALL_31_IVS_BITFIELD);

  return entryBytes;
}

// Applies the active save's learnset randomizer to one move id before move-edit validation.
function resolveEditableMoveId(state, coreData, mon, rawMoveId) {
  if (!rawMoveId) {
    return 0;
  }

  if (!state.metadata?.random?.learnset) {
    return rawMoveId;
  }

  return coreData.abilityRandomizer.tryRandomizeMove(
    state.metadata.trainedId,
    Boolean(state.metadata.restricted),
    rawMoveId,
    mon.ID
  );
}

// Adds one legal move candidate to the selected Pokemon's editable move pool.
function pushEditableMoveOption(pool, byId, state, coreData, mon, rawMoveId, sourceLabel, level = null) {
  const resolvedMoveId = resolveEditableMoveId(state, coreData, mon, rawMoveId);
  if (!resolvedMoveId || !coreData.moves?.[resolvedMoveId]) {
    return;
  }

  if (state.metadata?.hardmode && !isHardcoreMoveLegal(mon, resolvedMoveId, coreData)) {
    return;
  }

  if (byId.has(resolvedMoveId)) {
    const existing = byId.get(resolvedMoveId);
    if (existing.level === null && level !== null) {
      existing.level = level;
      existing.source = sourceLabel;
    } else if (existing.level !== null && level !== null) {
      existing.level = Math.min(existing.level, level);
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

// Builds the selected Pokemon's full legal move pool for save-aware move editing.
function buildEditableMovePoolForSlot(slot, state, coreData) {
  const mon = coreData.species?.[slot.speciesId];
  if (!mon) {
    return [];
  }

  const pool = [];
  const byId = new Map();

  for (const [rawMoveId, moveLevel] of mon.levelupMoves || []) {
    if (moveLevel > slot.level) {
      continue;
    }
    pushEditableMoveOption(pool, byId, state, coreData, mon, rawMoveId, 'Level Up', moveLevel);
  }

  for (const tmIndex of mon.tmMoves || []) {
    pushEditableMoveOption(pool, byId, state, coreData, mon, coreData.tmMoves?.[tmIndex], 'TM/HM');
  }

  for (const tutorIndex of mon.tutorMoves || []) {
    pushEditableMoveOption(pool, byId, state, coreData, mon, coreData.tutorMoves?.[tutorIndex], 'Tutor');
  }

  for (const moveId of mon.eggMoves || []) {
    pushEditableMoveOption(pool, byId, state, coreData, mon, moveId, 'Egg');
  }

  for (const moveId of mon.eventMoves || []) {
    pushEditableMoveOption(pool, byId, state, coreData, mon, moveId, 'Event');
  }

  for (const moveId of mon.prevoMoves || []) {
    pushEditableMoveOption(pool, byId, state, coreData, mon, moveId, 'Pre-Evolution');
  }

  return pool;
}

// Normalizes the edited move list into four-or-fewer stored move ids.
function normalizeEditedMoveIds(moveIds) {
  return (moveIds || [])
    .map(moveId => Number(moveId) || 0)
    .filter(moveId => moveId > 0)
    .slice(0, 4);
}

// Validates one edited move list against the selected Pokemon's legal move pool.
function validateEditedMoveIds(slot, moveIds, state, coreData) {
  if (!slot?.present) {
    throw new Error('Only existing Pokemon can have their moves edited.');
  }

  const mon = coreData.species?.[slot.speciesId];
  if (!mon) {
    throw new Error(`Unknown species id ${slot.speciesId}.`);
  }

  const normalizedMoveIds = normalizeEditedMoveIds(moveIds);
  if (new Set(normalizedMoveIds).size !== normalizedMoveIds.length) {
    throw new Error('Duplicate moves are not allowed in the edited moveset.');
  }

  const legalMoveIds = new Set(
    buildEditableMovePoolForSlot(slot, state, coreData).map(move => move.id)
  );

  for (const moveId of normalizedMoveIds) {
    if (!legalMoveIds.has(moveId)) {
      throw new Error(`${coreData.moves?.[moveId]?.name || `Move ${moveId}`} is not legal for this Pokemon at its current save settings.`);
    }
  }

  return normalizedMoveIds;
}

// Applies one item-box change to the save's PC item storage and refreshes derived state.
export function applyPcItemChange(state, slotIndex, itemId, quantity, coreData) {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= PC_ITEM_COUNT) {
    throw new Error(`Unsupported PC item slot ${slotIndex}.`);
  }

  const safeQuantity = Math.min(999, Math.max(0, Number(quantity) || 0));
  const safeItemId = safeQuantity > 0 ? (Number.isInteger(itemId) ? itemId : Number(itemId) || 0) : 0;
  const entryOffset = PC_ITEM_STORAGE_OFFSET + slotIndex * PC_ITEM_SLOT_SIZE;

  writeUint16LE(state.saveBlock1, entryOffset, safeItemId > 0 ? safeItemId : 0);
  writeUint16LE(state.saveBlock1, entryOffset + 2, safeItemId > 0 ? safeQuantity : 0);
  hydrateSaveState(state, coreData);
}

// Applies one edited move list to a selected party slot and refreshes derived state.
export function applyPartyMoveChange(state, slotIndex, moveIds, coreData) {
  const slot = state.partySlots?.[slotIndex];
  const appliedMoveIds = validateEditedMoveIds(slot, moveIds, state, coreData);
  const entryOffset = PARTY_POKEMON_SAVE_BLOCK1_OFFSET + slotIndex * PARTY_POKEMON_SIZE;
  const entryBytes = state.saveBlock1.subarray(entryOffset, entryOffset + PARTY_POKEMON_SIZE);

  entryBytes.subarray(PARTY_POKEMON_MOVES_OFFSET, PARTY_POKEMON_MOVES_OFFSET + 8).fill(0);
  entryBytes.subarray(PARTY_POKEMON_PP_OFFSET, PARTY_POKEMON_PP_OFFSET + 4).fill(0);
  appliedMoveIds.forEach((moveId, moveIndex) => {
    writeUint16LE(entryBytes, PARTY_POKEMON_MOVES_OFFSET + moveIndex * 2, moveId);
    entryBytes[PARTY_POKEMON_PP_OFFSET + moveIndex] = coreData.moves?.[moveId]?.pp || 0;
  });

  hydrateSaveState(state, coreData);
}

// Applies one edited move list to a selected box slot and refreshes derived state.
export function applyBoxMoveChange(state, boxNumber, slotIndex, moveIds, coreData) {
  const slot = state.boxes?.[boxNumber - 1]?.slots?.[slotIndex];
  const appliedMoveIds = validateEditedMoveIds(slot, moveIds, state, coreData);
  const { storageKey, entryOffset } = getBoxSlotLocation(boxNumber, slotIndex);
  const buffer = getStateBuffer(state, storageKey);
  const entryBytes = buffer.subarray(entryOffset, entryOffset + BOX_POKEMON_SIZE);

  entryBytes[BOX_POKEMON_PP_BONUSES_OFFSET] = 0;
  entryBytes.set(packBoxMoveIds(appliedMoveIds), BOX_POKEMON_MOVES_OFFSET);
  hydrateSaveState(state, coreData);
}

// Applies one species replacement to a selected party slot and refreshes derived state.
export function applyPartySpeciesChange(state, slotIndex, speciesId, coreData) {
  const entryBytes = buildPartyEntry(speciesId, slotIndex, state, coreData);
  const entryOffset = PARTY_POKEMON_SAVE_BLOCK1_OFFSET + slotIndex * PARTY_POKEMON_SIZE;
  state.saveBlock1.set(entryBytes, entryOffset);
  state.saveBlock1[PARTY_COUNT_SAVE_BLOCK1_OFFSET] = Math.max(state.saveBlock1[PARTY_COUNT_SAVE_BLOCK1_OFFSET] || 0, slotIndex + 1);
  hydrateSaveState(state, coreData);
}

// Applies one species replacement to a selected box slot and refreshes derived state.
export function applyBoxSpeciesChange(state, boxNumber, slotIndex, speciesId, coreData) {
  const { storageKey, entryOffset } = getBoxSlotLocation(boxNumber, slotIndex);
  const buffer = getStateBuffer(state, storageKey);
  const entryBytes = buildBoxEntry(speciesId, boxNumber, slotIndex, state, coreData);
  buffer.set(entryBytes, entryOffset);
  hydrateSaveState(state, coreData);
}

// Builds a downloadable edited save file while preserving untouched sectors and footers.
export function exportEditedSave(state) {
  const outputBytes = new Uint8Array(state.fileBytes);
  scatterSaveBlocks(outputBytes, state);
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
