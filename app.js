import {
  loadCoreData,
  lookupItemByName,
  lookupSpeciesByName,
  normalizeItemLookupKey,
  normalizeMoveLookupKey,
  normalizeSpeciesLookupKey
} from './coreData.js';
import {
  buildPokemonBlueprint,
  isHardcoreMoveLegal,
  resolveAbilityPool
} from './pokemonLogic.js';
import {
  applyBoxMoveChange,
  applyPcItemChange,
  applyBoxSpeciesChange,
  applyPartyMoveChange,
  applyPartySpeciesChange,
  buildOutputFileName,
  exportEditedSave,
  formatSaveFlags,
  loadSaveFile
} from './saveCodec.js';

const elements = {
  saveFileInput: document.getElementById('saveFileInput'),
  exportSaveButton: document.getElementById('exportSaveButton'),
  applySpeciesButton: document.getElementById('applySpeciesButton'),
  speciesNameInput: document.getElementById('speciesNameInput'),
  speciesSuggestionList: document.getElementById('speciesSuggestionList'),
  statusBanner: document.getElementById('statusBanner'),
  trainerName: document.getElementById('trainerName'),
  trainerId: document.getElementById('trainerId'),
  saveFlags: document.getElementById('saveFlags'),
  speciesPool: document.getElementById('speciesPool'),
  progressionSummary: document.getElementById('progressionSummary'),
  partyCountBadge: document.getElementById('partyCountBadge'),
  boxCountBadge: document.getElementById('boxCountBadge'),
  partyGrid: document.getElementById('partyGrid'),
  boxTabs: document.getElementById('boxTabs'),
  boxGrid: document.getElementById('boxGrid'),
  selectedTargetLabel: document.getElementById('selectedTargetLabel'),
  selectedCurrentPokemon: document.getElementById('selectedCurrentPokemon'),
  currentSlotDetail: document.getElementById('currentSlotDetail'),
  replacementPreview: document.getElementById('replacementPreview'),
  replacementMovePreview: document.getElementById('replacementMovePreview'),
  applyMoveButton: document.getElementById('applyMoveButton'),
  itemCountBadge: document.getElementById('itemCountBadge'),
  itemGrid: document.getElementById('itemGrid'),
  selectedItemTargetLabel: document.getElementById('selectedItemTargetLabel'),
  selectedCurrentItem: document.getElementById('selectedCurrentItem'),
  itemNameInput: document.getElementById('itemNameInput'),
  itemSuggestionList: document.getElementById('itemSuggestionList'),
  itemQuantityInput: document.getElementById('itemQuantityInput'),
  applyItemButton: document.getElementById('applyItemButton'),
  currentItemDetail: document.getElementById('currentItemDetail'),
  replacementItemPreview: document.getElementById('replacementItemPreview'),
  moveNameInputs: Array.from(document.querySelectorAll('.moveNameInput')),
  moveSuggestionLists: Array.from(document.querySelectorAll('[data-move-suggestions]'))
};

let coreData = null;
let workingSave = null;
let selectedBoxNumber = 1;
let selectedTarget = null;
let selectedItemSlotIndex = 0;
let visibleSpeciesSuggestions = [];
let activeSpeciesSuggestionIndex = -1;
let speciesSuggestionHideTimer = null;
let visibleItemSuggestions = [];
let activeItemSuggestionIndex = -1;
let itemSuggestionHideTimer = null;
let visibleMoveSuggestions = [];
let activeMoveSuggestionIndex = -1;
let activeMoveSuggestionFieldIndex = -1;
let moveSuggestionHideTimer = null;
const BOX_CAPACITY = 30;
const ITEM_SLOT_COUNT = 30;
const MOVE_SLOT_COUNT = 4;
const MAX_SPECIES_SUGGESTIONS = 5;
const MAX_ITEM_SUGGESTIONS = 5;
const MAX_MOVE_SUGGESTIONS = 5;
const PERSISTED_SAVE_STORAGE_KEY = 'rr-save-hack.persisted-save';

// Updates the shared status banner so file-load and export steps stay obvious.
function setStatus(message, tone = 'info') {
  elements.statusBanner.textContent = message;
  elements.statusBanner.className = `status-banner ${tone}`;
}

// Encodes one save buffer into base64 so the current edited save fits in localStorage cleanly.
function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = '';

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

// Decodes the stored base64 payload back into raw save bytes during startup restore.
function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

// Removes the last persisted save snapshot when the editor no longer has a valid working save.
function clearPersistedSave() {
  try {
    localStorage.removeItem(PERSISTED_SAVE_STORAGE_KEY);
  } catch (error) {
    console.warn('Unable to clear persisted RR save hack data.', error);
  }
}

// Serializes the current working save and selection so a refresh can restore the editor state.
function persistWorkingSave() {
  if (!workingSave) {
    clearPersistedSave();
    return;
  }

  try {
    const bytes = exportEditedSave(workingSave);
    localStorage.setItem(
      PERSISTED_SAVE_STORAGE_KEY,
      JSON.stringify({
        fileName: workingSave.fileName,
        saveBase64: bytesToBase64(bytes),
        selectedBoxNumber,
        selectedTarget,
        selectedItemSlotIndex
      })
    );
  } catch (error) {
    console.warn('Unable to persist the current RR save hack session.', error);
  }
}

// Validates one restored selection object before reusing it in the live editor state.
function normalizePersistedTarget(target, boxNumber) {
  if (target?.kind === 'party' && Number.isInteger(target.slotIndex) && target.slotIndex >= 0 && target.slotIndex < 6) {
    return { kind: 'party', slotIndex: target.slotIndex };
  }

  if (
    target?.kind === 'box'
    && Number.isInteger(target.boxNumber)
    && target.boxNumber >= 1
    && target.boxNumber <= 25
    && Number.isInteger(target.slotIndex)
    && target.slotIndex >= 0
    && target.slotIndex < BOX_CAPACITY
  ) {
    return {
      kind: 'box',
      boxNumber: target.boxNumber,
      slotIndex: target.slotIndex
    };
  }

  return { kind: 'party', slotIndex: 0 };
}

// Validates one restored item-slot index before reusing it in the live editor state.
function normalizePersistedItemSlotIndex(slotIndex) {
  return Number.isInteger(slotIndex) && slotIndex >= 0 && slotIndex < ITEM_SLOT_COUNT
    ? slotIndex
    : 0;
}

// Rehydrates the last edited save from localStorage after the repo data finishes loading.
async function restorePersistedSave() {
  let rawSnapshot = null;

  try {
    rawSnapshot = localStorage.getItem(PERSISTED_SAVE_STORAGE_KEY);
  } catch (error) {
    console.warn('Unable to read persisted RR save hack data.', error);
    return false;
  }

  if (!rawSnapshot) {
    return false;
  }

  try {
    const snapshot = JSON.parse(rawSnapshot);
    if (typeof snapshot?.saveBase64 !== 'string') {
      throw new Error('Missing persisted save payload.');
    }

    const restoredBytes = base64ToBytes(snapshot.saveBase64);
    const restoredFileName = typeof snapshot.fileName === 'string' && snapshot.fileName
      ? snapshot.fileName
      : 'rr-save-hack.autosave.sav';

    workingSave = await loadSaveFile(new File([restoredBytes], restoredFileName), coreData);
    selectedBoxNumber = Number.isInteger(snapshot.selectedBoxNumber)
      && snapshot.selectedBoxNumber >= 1
      && snapshot.selectedBoxNumber <= 25
      ? snapshot.selectedBoxNumber
      : 1;
    selectedTarget = normalizePersistedTarget(snapshot.selectedTarget, selectedBoxNumber);
    selectedItemSlotIndex = normalizePersistedItemSlotIndex(snapshot.selectedItemSlotIndex);
    if (selectedTarget.kind === 'box') {
      selectedBoxNumber = selectedTarget.boxNumber;
    }
    return true;
  } catch (error) {
    console.warn('Unable to restore persisted RR save hack data.', error);
    clearPersistedSave();
    return false;
  }
}

// Returns the display label used for one species id in the UI.
function getSpeciesName(speciesId) {
  return speciesId && coreData?.species?.[speciesId]
    ? coreData.speciesDisplayNames?.get(speciesId) || coreData.species[speciesId].name
    : 'Empty';
}

// Returns the display label used for one item id in the UI.
function getItemName(itemId) {
  return itemId && coreData?.items?.[itemId]
    ? coreData.itemDisplayNames?.get(itemId) || coreData.items[itemId].name
    : 'Empty';
}

// Formats one move list into the compact text used by the detail panels.
function formatMoveNames(moveIds) {
  if (!moveIds?.length) {
    return 'None';
  }

  return moveIds
    .map(moveId => coreData.moves?.[moveId]?.name || `Move ${moveId}`)
    .join(', ');
}

// Builds one small detail line for the right-side inspector cards.
function createDetailLine(label, value) {
  const line = document.createElement('div');
  line.className = 'detail-line';

  const key = document.createElement('span');
  key.className = 'detail-key';
  key.textContent = `${label}:`;

  const body = document.createElement('span');
  body.textContent = value;

  line.replaceChildren(key, body);
  return line;
}

// Resolves the current slot's visible abilities using the loaded save's randomizer rules.
function formatSlotAbilityNames(slot) {
  if (!workingSave || !slot?.present) {
    return 'None';
  }

  const mon = coreData.species?.[slot.speciesId];
  if (!mon) {
    return 'Unknown';
  }

  const abilityPool = resolveAbilityPool(mon, workingSave.metadata, coreData);
  return abilityPool.length
    ? abilityPool.map(ability => ability.resolvedName).join(', ')
    : 'None';
}

// Scores one suggestion against the current query so the five visible rows stay relevant.
function scoreSpeciesSuggestionMatch(suggestion, normalizedQuery) {
  if (!normalizedQuery) {
    return null;
  }

  if (suggestion.normalizedLabel === normalizedQuery || suggestion.normalizedKey === normalizedQuery) {
    return 0;
  }
  if (suggestion.normalizedLabel.startsWith(normalizedQuery)) {
    return 1;
  }
  if (suggestion.normalizedKey.startsWith(normalizedQuery)) {
    return 2;
  }
  if (suggestion.normalizedName.startsWith(normalizedQuery)) {
    return 3;
  }
  if (suggestion.normalizedLabel.includes(normalizedQuery)) {
    return 4;
  }
  if (suggestion.normalizedKey.includes(normalizedQuery) || suggestion.normalizedName.includes(normalizedQuery)) {
    return 5;
  }

  return null;
}

// Builds at most five ranked suggestion rows for the current species input value.
function buildSpeciesSuggestionMatches(query) {
  const normalizedQuery = normalizeSpeciesLookupKey(query);
  if (!normalizedQuery || !coreData) {
    return [];
  }

  return coreData.speciesSuggestions
    .map(suggestion => ({
      suggestion,
      score: scoreSpeciesSuggestionMatch(suggestion, normalizedQuery)
    }))
    .filter(entry => entry.score !== null)
    .sort((left, right) =>
      left.score - right.score
      || left.suggestion.label.localeCompare(right.suggestion.label)
      || left.suggestion.speciesId - right.suggestion.speciesId
    )
    .slice(0, MAX_SPECIES_SUGGESTIONS)
    .map(entry => entry.suggestion);
}

// Cancels any pending delayed hide so focus changes do not collapse the popup too early.
function clearSpeciesSuggestionHideTimer() {
  if (speciesSuggestionHideTimer) {
    clearTimeout(speciesSuggestionHideTimer);
    speciesSuggestionHideTimer = null;
  }
}

// Hides the species popup after clicks and blur transitions settle.
function hideSpeciesSuggestions() {
  clearSpeciesSuggestionHideTimer();
  visibleSpeciesSuggestions = [];
  activeSpeciesSuggestionIndex = -1;
  elements.speciesSuggestionList.hidden = true;
  elements.speciesSuggestionList.replaceChildren();
}

// Applies one suggestion into the input while keeping the preview and button state in sync.
function applySpeciesSuggestion(suggestion) {
  if (!suggestion) {
    return;
  }

  elements.speciesNameInput.value = suggestion.value;
  hideSpeciesSuggestions();
  renderReplacementPreview();
  syncControls();
  elements.speciesNameInput.focus();
  const cursor = elements.speciesNameInput.value.length;
  elements.speciesNameInput.setSelectionRange(cursor, cursor);
}

// Moves the active keyboard selection through the visible five-row suggestion popup.
function moveActiveSpeciesSuggestion(delta) {
  if (!visibleSpeciesSuggestions.length) {
    return;
  }

  if (activeSpeciesSuggestionIndex < 0) {
    activeSpeciesSuggestionIndex = delta > 0 ? 0 : visibleSpeciesSuggestions.length - 1;
  } else {
    activeSpeciesSuggestionIndex = (activeSpeciesSuggestionIndex + delta + visibleSpeciesSuggestions.length) % visibleSpeciesSuggestions.length;
  }

  renderSpeciesSuggestions(elements.speciesNameInput.value, true);
}

// Syncs the active row highlight without rebuilding the popup on every pointer move.
function updateActiveSpeciesSuggestionRow() {
  Array.from(elements.speciesSuggestionList.children).forEach((row, index) => {
    row.classList.toggle('active', index === activeSpeciesSuggestionIndex);
  });
}

// Rebuilds the popup rows for the current query and keeps the active row highlighted when needed.
function renderSpeciesSuggestions(query, preserveActiveIndex = false) {
  const matches = buildSpeciesSuggestionMatches(query);
  visibleSpeciesSuggestions = matches;

  if (!matches.length || document.activeElement !== elements.speciesNameInput) {
    hideSpeciesSuggestions();
    return;
  }

  if (!preserveActiveIndex || activeSpeciesSuggestionIndex >= matches.length) {
    activeSpeciesSuggestionIndex = -1;
  }

  const rows = matches.map((suggestion, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'species-suggestion';
    if (index === activeSpeciesSuggestionIndex) {
      button.classList.add('active');
    }

    const label = document.createElement('span');
    label.textContent = suggestion.label;

    button.appendChild(label);
    if (suggestion.key !== suggestion.label) {
      const meta = document.createElement('span');
      meta.className = 'species-suggestion-meta';
      meta.textContent = suggestion.key;
      button.appendChild(meta);
    }

    button.addEventListener('mousedown', event => {
      event.preventDefault();
      applySpeciesSuggestion(suggestion);
    });
    button.addEventListener('mouseenter', () => {
      activeSpeciesSuggestionIndex = index;
      updateActiveSpeciesSuggestionRow();
    });

    return button;
  });

  clearSpeciesSuggestionHideTimer();
  elements.speciesSuggestionList.hidden = false;
  elements.speciesSuggestionList.replaceChildren(...rows);
  updateActiveSpeciesSuggestionRow();
}

// Starts the delayed close used when the species field loses focus or hover.
function scheduleSpeciesSuggestionHide() {
  clearSpeciesSuggestionHideTimer();
  speciesSuggestionHideTimer = window.setTimeout(() => {
    hideSpeciesSuggestions();
  }, 120);
}

// Scores one item suggestion against the current query so the five visible rows stay relevant.
function scoreItemSuggestionMatch(suggestion, normalizedQuery) {
  if (!normalizedQuery) {
    return null;
  }

  if (suggestion.normalizedLabel === normalizedQuery) {
    return 0;
  }
  if (suggestion.normalizedLabel.startsWith(normalizedQuery)) {
    return 1;
  }
  if (suggestion.normalizedLabel.includes(normalizedQuery)) {
    return 2;
  }

  return null;
}

// Builds at most five ranked suggestion rows for the current item input value.
function buildItemSuggestionMatches(query) {
  const normalizedQuery = normalizeItemLookupKey(query);
  if (!normalizedQuery || !coreData) {
    return [];
  }

  return coreData.itemSuggestions
    .map(suggestion => ({
      suggestion,
      score: scoreItemSuggestionMatch(suggestion, normalizedQuery)
    }))
    .filter(entry => entry.score !== null)
    .sort((left, right) =>
      left.score - right.score
      || left.suggestion.label.localeCompare(right.suggestion.label)
      || left.suggestion.itemId - right.suggestion.itemId
    )
    .slice(0, MAX_ITEM_SUGGESTIONS)
    .map(entry => entry.suggestion);
}

// Cancels any pending delayed hide so focus changes do not collapse the item popup too early.
function clearItemSuggestionHideTimer() {
  if (itemSuggestionHideTimer) {
    clearTimeout(itemSuggestionHideTimer);
    itemSuggestionHideTimer = null;
  }
}

// Hides the item popup after clicks and blur transitions settle.
function hideItemSuggestions() {
  clearItemSuggestionHideTimer();
  visibleItemSuggestions = [];
  activeItemSuggestionIndex = -1;
  elements.itemSuggestionList.hidden = true;
  elements.itemSuggestionList.replaceChildren();
}

// Applies one item suggestion into the input while keeping the preview and button state in sync.
function applyItemSuggestion(suggestion) {
  if (!suggestion) {
    return;
  }

  elements.itemNameInput.value = suggestion.value;
  hideItemSuggestions();
  renderReplacementItemPreview();
  syncControls();
  elements.itemNameInput.focus();
  const cursor = elements.itemNameInput.value.length;
  elements.itemNameInput.setSelectionRange(cursor, cursor);
}

// Moves the active keyboard selection through the visible item suggestion popup.
function moveActiveItemSuggestion(delta) {
  if (!visibleItemSuggestions.length) {
    return;
  }

  if (activeItemSuggestionIndex < 0) {
    activeItemSuggestionIndex = delta > 0 ? 0 : visibleItemSuggestions.length - 1;
  } else {
    activeItemSuggestionIndex = (activeItemSuggestionIndex + delta + visibleItemSuggestions.length) % visibleItemSuggestions.length;
  }

  renderItemSuggestions(elements.itemNameInput.value, true);
}

// Syncs the active item row highlight without rebuilding the popup on every pointer move.
function updateActiveItemSuggestionRow() {
  Array.from(elements.itemSuggestionList.children).forEach((row, index) => {
    row.classList.toggle('active', index === activeItemSuggestionIndex);
  });
}

// Rebuilds the popup rows for the current item query and keeps the active row highlighted.
function renderItemSuggestions(query, preserveActiveIndex = false) {
  const matches = buildItemSuggestionMatches(query);
  visibleItemSuggestions = matches;

  if (!matches.length || document.activeElement !== elements.itemNameInput) {
    hideItemSuggestions();
    return;
  }

  if (!preserveActiveIndex || activeItemSuggestionIndex >= matches.length) {
    activeItemSuggestionIndex = -1;
  }

  const rows = matches.map((suggestion, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'species-suggestion';
    if (index === activeItemSuggestionIndex) {
      button.classList.add('active');
    }

    const label = document.createElement('span');
    label.textContent = suggestion.label;

    button.appendChild(label);
    if (suggestion.description) {
      const meta = document.createElement('span');
      meta.className = 'species-suggestion-meta';
      meta.textContent = `#${suggestion.itemId}`;
      button.appendChild(meta);
    }

    button.addEventListener('mousedown', event => {
      event.preventDefault();
      applyItemSuggestion(suggestion);
    });
    button.addEventListener('mouseenter', () => {
      activeItemSuggestionIndex = index;
      updateActiveItemSuggestionRow();
    });

    return button;
  });

  clearItemSuggestionHideTimer();
  elements.itemSuggestionList.hidden = false;
  elements.itemSuggestionList.replaceChildren(...rows);
  updateActiveItemSuggestionRow();
}

// Starts the delayed close used when the item field loses focus or hover.
function scheduleItemSuggestionHide() {
  clearItemSuggestionHideTimer();
  itemSuggestionHideTimer = window.setTimeout(() => {
    hideItemSuggestions();
  }, 120);
}

// Applies the active save's learnset randomizer to one move id for the selected species.
function resolveEditableMoveId(mon, rawMoveId) {
  if (!rawMoveId) {
    return 0;
  }

  if (!workingSave?.metadata?.random?.learnset) {
    return rawMoveId;
  }

  return coreData.abilityRandomizer.tryRandomizeMove(
    workingSave.metadata.trainedId,
    Boolean(workingSave.metadata.restricted),
    rawMoveId,
    mon.ID
  );
}

// Adds one legal move candidate to the selected-slot move pool after save-specific remapping.
function pushEditableMoveOption(pool, byId, mon, rawMoveId, sourceLabel, level = null) {
  const resolvedMoveId = resolveEditableMoveId(mon, rawMoveId);
  if (!resolvedMoveId || !coreData.moves?.[resolvedMoveId]) {
    return;
  }

  if (workingSave?.metadata?.hardmode && !isHardcoreMoveLegal(mon, resolvedMoveId, coreData)) {
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
    level,
    normalizedLabel: normalizeMoveLookupKey(move.name)
  };
  byId.set(resolvedMoveId, detail);
  pool.push(detail);
}

// Returns whether the selected slot currently holds a real Pokemon whose moves can be edited.
function isMoveEditableSlot(slot = getSelectedSlot()) {
  return Boolean(workingSave && slot?.present);
}

// Builds the legal move pool for the selected slot using its current species, level, and save rules.
function buildSelectedSlotMovePool() {
  const slot = getSelectedSlot();
  if (!isMoveEditableSlot(slot)) {
    return [];
  }

  const mon = coreData?.species?.[slot.speciesId];
  if (!mon) {
    return [];
  }

  const pool = [];
  const byId = new Map();

  for (const [rawMoveId, moveLevel] of mon.levelupMoves || []) {
    if (moveLevel > slot.level) {
      continue;
    }
    pushEditableMoveOption(pool, byId, mon, rawMoveId, 'Level Up', moveLevel);
  }

  for (const tmIndex of mon.tmMoves || []) {
    pushEditableMoveOption(pool, byId, mon, coreData.tmMoves?.[tmIndex], 'TM/HM');
  }

  for (const tutorIndex of mon.tutorMoves || []) {
    pushEditableMoveOption(pool, byId, mon, coreData.tutorMoves?.[tutorIndex], 'Tutor');
  }

  for (const moveId of mon.eggMoves || []) {
    pushEditableMoveOption(pool, byId, mon, moveId, 'Egg');
  }

  for (const moveId of mon.eventMoves || []) {
    pushEditableMoveOption(pool, byId, mon, moveId, 'Event');
  }

  for (const moveId of mon.prevoMoves || []) {
    pushEditableMoveOption(pool, byId, mon, moveId, 'Pre-Evolution');
  }

  return pool;
}

// Summarizes the current move-editor input state so previews and apply validation stay in sync.
function buildEditedMoveSelectionState() {
  const slot = getSelectedSlot();
  const movePool = buildSelectedSlotMovePool();
  const moveLookup = new Map(movePool.map(move => [move.normalizedLabel, move]));
  const enteredMoveIds = [];
  const enteredMoves = [];
  const errors = [];
  const seenMoveIds = new Set();

  elements.moveNameInputs.forEach((input, fieldIndex) => {
    const value = input.value.trim();
    if (!value) {
      return;
    }

    const move = moveLookup.get(normalizeMoveLookupKey(value));
    if (!move) {
      errors.push(`Move ${fieldIndex + 1} is not legal for the selected Pokemon right now.`);
      return;
    }

    if (seenMoveIds.has(move.id)) {
      errors.push(`Move ${fieldIndex + 1} duplicates another selected move.`);
      return;
    }

    seenMoveIds.add(move.id);
    enteredMoveIds.push(move.id);
    enteredMoves.push(move);
  });

  return {
    slot,
    movePool,
    moveLookup,
    enteredMoveIds,
    enteredMoves,
    errors
  };
}

// Clears the move editor inputs when switching targets or when no editable Pokemon is selected.
function hydrateMoveEditorFromSelectedSlot() {
  const slot = getSelectedSlot();
  const moveNames = slot?.present
    ? slot.moveIds.map(moveId => coreData?.moves?.[moveId]?.name || `Move ${moveId}`)
    : [];

  elements.moveNameInputs.forEach((input, fieldIndex) => {
    input.value = moveNames[fieldIndex] || '';
  });
  hideMoveSuggestions();
}

// Scores one legal move suggestion against the active text query.
function scoreMoveSuggestionMatch(suggestion, normalizedQuery) {
  if (!normalizedQuery) {
    return null;
  }

  if (suggestion.normalizedLabel === normalizedQuery) {
    return 0;
  }
  if (suggestion.normalizedLabel.startsWith(normalizedQuery)) {
    return 1;
  }
  if (suggestion.normalizedLabel.includes(normalizedQuery)) {
    return 2;
  }

  return null;
}

// Builds at most five ranked legal move suggestions for one active move editor field.
function buildMoveSuggestionMatches(query) {
  const normalizedQuery = normalizeMoveLookupKey(query);
  if (!normalizedQuery) {
    return [];
  }

  return buildSelectedSlotMovePool()
    .map(suggestion => ({
      suggestion,
      score: scoreMoveSuggestionMatch(suggestion, normalizedQuery)
    }))
    .filter(entry => entry.score !== null)
    .sort((left, right) =>
      left.score - right.score
      || left.suggestion.name.localeCompare(right.suggestion.name)
      || left.suggestion.id - right.suggestion.id
    )
    .slice(0, MAX_MOVE_SUGGESTIONS)
    .map(entry => entry.suggestion);
}

// Cancels any pending delayed hide so the active move autocomplete can stay open while hovering.
function clearMoveSuggestionHideTimer() {
  if (moveSuggestionHideTimer) {
    clearTimeout(moveSuggestionHideTimer);
    moveSuggestionHideTimer = null;
  }
}

// Hides every move suggestion popup and clears the active keyboard-selection state.
function hideMoveSuggestions() {
  clearMoveSuggestionHideTimer();
  visibleMoveSuggestions = [];
  activeMoveSuggestionIndex = -1;
  activeMoveSuggestionFieldIndex = -1;
  elements.moveSuggestionLists.forEach(list => {
    list.hidden = true;
    list.replaceChildren();
  });
}

// Applies one legal move suggestion into the active move field and refreshes previews immediately.
function applyMoveSuggestion(fieldIndex, suggestion) {
  const input = elements.moveNameInputs[fieldIndex];
  if (!input || !suggestion) {
    return;
  }

  input.value = suggestion.name;
  hideMoveSuggestions();
  renderReplacementMovePreview();
  syncControls();
  input.focus();
  const cursor = input.value.length;
  input.setSelectionRange(cursor, cursor);
}

// Moves the active keyboard selection through the visible move suggestion popup.
function moveActiveMoveSuggestion(delta) {
  if (!visibleMoveSuggestions.length || activeMoveSuggestionFieldIndex < 0) {
    return;
  }

  if (activeMoveSuggestionIndex < 0) {
    activeMoveSuggestionIndex = delta > 0 ? 0 : visibleMoveSuggestions.length - 1;
  } else {
    activeMoveSuggestionIndex = (activeMoveSuggestionIndex + delta + visibleMoveSuggestions.length) % visibleMoveSuggestions.length;
  }

  renderMoveSuggestions(activeMoveSuggestionFieldIndex, elements.moveNameInputs[activeMoveSuggestionFieldIndex].value, true);
}

// Updates the highlighted move suggestion row after keyboard or pointer navigation.
function updateActiveMoveSuggestionRow() {
  const list = elements.moveSuggestionLists[activeMoveSuggestionFieldIndex];
  if (!list) {
    return;
  }

  Array.from(list.children).forEach((row, index) => {
    row.classList.toggle('active', index === activeMoveSuggestionIndex);
  });
}

// Rebuilds one move suggestion popup for the currently focused move input field.
function renderMoveSuggestions(fieldIndex, query, preserveActiveIndex = false) {
  const input = elements.moveNameInputs[fieldIndex];
  const list = elements.moveSuggestionLists[fieldIndex];
  const matches = buildMoveSuggestionMatches(query);
  visibleMoveSuggestions = matches;
  activeMoveSuggestionFieldIndex = fieldIndex;

  elements.moveSuggestionLists.forEach((otherList, otherIndex) => {
    if (otherIndex !== fieldIndex) {
      otherList.hidden = true;
      otherList.replaceChildren();
    }
  });

  if (!matches.length || document.activeElement !== input) {
    list.hidden = true;
    list.replaceChildren();
    visibleMoveSuggestions = [];
    activeMoveSuggestionIndex = -1;
    if (document.activeElement !== input) {
      activeMoveSuggestionFieldIndex = -1;
    }
    return;
  }

  if (!preserveActiveIndex || activeMoveSuggestionIndex >= matches.length) {
    activeMoveSuggestionIndex = -1;
  }

  const rows = matches.map((suggestion, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'species-suggestion';
    if (index === activeMoveSuggestionIndex) {
      button.classList.add('active');
    }

    const label = document.createElement('span');
    label.textContent = suggestion.name;
    button.appendChild(label);

    const meta = document.createElement('span');
    meta.className = 'species-suggestion-meta';
    meta.textContent = suggestion.level !== null ? `Lv ${suggestion.level}` : suggestion.source;
    button.appendChild(meta);

    button.addEventListener('mousedown', event => {
      event.preventDefault();
      applyMoveSuggestion(fieldIndex, suggestion);
    });
    button.addEventListener('mouseenter', () => {
      activeMoveSuggestionFieldIndex = fieldIndex;
      activeMoveSuggestionIndex = index;
      updateActiveMoveSuggestionRow();
    });

    return button;
  });

  clearMoveSuggestionHideTimer();
  list.hidden = false;
  list.replaceChildren(...rows);
  updateActiveMoveSuggestionRow();
}

// Starts the delayed close used when one move input loses focus or hover.
function scheduleMoveSuggestionHide() {
  clearMoveSuggestionHideTimer();
  moveSuggestionHideTimer = window.setTimeout(() => {
    hideMoveSuggestions();
  }, 120);
}

// Returns the active slot object currently selected in the UI.
function getSelectedSlot() {
  if (!workingSave || !selectedTarget) {
    return null;
  }

  if (selectedTarget.kind === 'party') {
    return workingSave.partySlots[selectedTarget.slotIndex];
  }

  return workingSave.boxes[selectedTarget.boxNumber - 1]?.slots[selectedTarget.slotIndex]
    || buildPlaceholderBoxSlot(selectedTarget.boxNumber, selectedTarget.slotIndex);
}

// Returns the active PC item slot currently selected in the UI.
function getSelectedItemSlot() {
  return workingSave?.pcItems?.[selectedItemSlotIndex] || null;
}

// Creates the visual label for one selected target.
function formatTargetLabel(target) {
  if (!target) {
    return 'No slot selected';
  }

  return target.kind === 'party'
    ? `Team Slot ${target.slotIndex + 1}`
    : `Box ${target.boxNumber}, Slot ${target.slotIndex + 1}`;
}

// Creates the visual label for one selected PC item slot.
function formatItemTargetLabel(slotIndex) {
  return Number.isInteger(slotIndex) ? `Item Slot ${slotIndex + 1}` : 'No item slot selected';
}

// Builds a UI-only placeholder so empty box positions still render and can be selected.
function buildPlaceholderBoxSlot(boxNumber, slotIndex) {
  return {
    kind: 'box',
    boxNumber,
    slotIndex,
    slotNumber: slotIndex + 1,
    present: false,
    speciesId: 0,
    level: 0,
    moveIds: []
  };
}

// Guarantees the box grid always shows all 30 positions even if the parsed box data is sparse.
function getRenderableBoxSlots(currentBox) {
  const slotsByIndex = new Map((currentBox?.slots || []).map(slot => [slot.slotIndex, slot]));
  return Array.from({ length: BOX_CAPACITY }, (_, slotIndex) =>
    slotsByIndex.get(slotIndex) || buildPlaceholderBoxSlot(currentBox.boxNumber, slotIndex)
  );
}

// Parses the requested item quantity and clamps it to the game's visible stack range.
function parseRequestedItemQuantity() {
  const value = Number.parseInt(elements.itemQuantityInput.value, 10);
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(999, Math.max(0, value));
}

// Loads the currently selected item slot values into the editor inputs.
function hydrateItemEditorFromSelectedSlot() {
  const slot = getSelectedItemSlot();
  if (!slot) {
    elements.itemNameInput.value = '';
    elements.itemQuantityInput.value = '0';
    return;
  }

  elements.itemNameInput.value = slot.present ? getItemName(slot.itemId) : '';
  elements.itemQuantityInput.value = String(slot.present ? slot.quantity : 0);
  hideItemSuggestions();
}

// Renders trainer metadata and save flags from the currently loaded save.
function renderMetadata() {
  if (!workingSave) {
    elements.trainerName.textContent = '-';
    elements.trainerId.textContent = '-';
    elements.saveFlags.textContent = '-';
    elements.speciesPool.textContent = '-';
    elements.progressionSummary.textContent = '-';
    return;
  }

  elements.trainerName.textContent = workingSave.metadata.name || '(unknown)';
  elements.trainerId.textContent = String(workingSave.metadata.trainedId || 0);
  elements.saveFlags.textContent = formatSaveFlags(workingSave.metadata);
  elements.speciesPool.textContent = workingSave.metadata.random.speciesPoolKey || 'None';
  elements.progressionSummary.textContent = workingSave.metadata.progression?.summary || 'Unknown';
}

// Rebuilds the six-slot team grid and keeps the selected slot highlighted.
function renderPartyGrid() {
  elements.partyGrid.replaceChildren();
  if (!workingSave) {
    elements.partyCountBadge.textContent = '0 / 6 occupied';
    return;
  }

  const occupied = workingSave.partySlots.filter(slot => slot.present).length;
  elements.partyCountBadge.textContent = `${occupied} / 6 occupied`;

  for (const slot of workingSave.partySlots) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'slot-card';
    if (selectedTarget?.kind === 'party' && selectedTarget.slotIndex === slot.slotIndex) {
      button.classList.add('selected');
    }

    const label = document.createElement('span');
    label.className = 'slot-label';
    label.textContent = `Slot ${slot.slotNumber}`;

    const name = document.createElement('span');
    name.className = 'slot-name';
    name.textContent = getSpeciesName(slot.speciesId);

    const subtext = document.createElement('span');
    subtext.className = 'slot-subtext';
    subtext.textContent = slot.present
      ? `Lv ${slot.level} | ${formatMoveNames(slot.moveIds)}`
      : 'Click to target this empty team slot.';

    button.replaceChildren(label, name, subtext);
    button.addEventListener('click', () => {
      selectedTarget = { kind: 'party', slotIndex: slot.slotIndex };
      hydrateMoveEditorFromSelectedSlot();
      persistWorkingSave();
      renderAll();
    });
    elements.partyGrid.appendChild(button);
  }
}

// Renders the list of available PC boxes and their occupied counts.
function renderBoxTabs() {
  elements.boxTabs.replaceChildren();
  if (!workingSave) {
    elements.boxCountBadge.textContent = '0 occupied';
    return;
  }

  const occupiedCount = workingSave.boxes.reduce(
    (count, box) => count + box.slots.filter(slot => slot.present).length,
    0
  );
  elements.boxCountBadge.textContent = `${occupiedCount} occupied`;

  for (const box of workingSave.boxes) {
    const occupied = box.slots.filter(slot => slot.present).length;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'box-tab';
    if (selectedBoxNumber === box.boxNumber) {
      button.classList.add('selected');
    }
    button.textContent = `Box ${box.boxNumber} (${occupied})`;
    button.addEventListener('click', () => {
      selectedBoxNumber = box.boxNumber;
      persistWorkingSave();
      renderAll();
    });
    elements.boxTabs.appendChild(button);
  }
}

// Renders the thirty slots from the currently selected PC box.
function renderBoxGrid() {
  elements.boxGrid.replaceChildren();
  if (!workingSave) {
    return;
  }

  const currentBox = workingSave.boxes[selectedBoxNumber - 1];
  if (!currentBox) {
    return;
  }

  for (const slot of getRenderableBoxSlots(currentBox)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'slot-card';
    if (
      selectedTarget?.kind === 'box'
      && selectedTarget.boxNumber === currentBox.boxNumber
      && selectedTarget.slotIndex === slot.slotIndex
    ) {
      button.classList.add('selected');
    }

    const label = document.createElement('span');
    label.className = 'slot-label';
    label.textContent = `Slot ${slot.slotNumber}`;

    const name = document.createElement('span');
    name.className = 'slot-name';
    name.textContent = getSpeciesName(slot.speciesId);

    const subtext = document.createElement('span');
    subtext.className = 'slot-subtext';
    subtext.textContent = slot.present
      ? `Lv ${slot.level} | ${formatMoveNames(slot.moveIds)}`
      : 'Click to target this empty box slot.';

    button.replaceChildren(label, name, subtext);
    button.addEventListener('click', () => {
      selectedTarget = {
        kind: 'box',
        boxNumber: currentBox.boxNumber,
        slotIndex: slot.slotIndex
      };
      hydrateMoveEditorFromSelectedSlot();
      persistWorkingSave();
      renderAll();
    });
    elements.boxGrid.appendChild(button);
  }
}

// Rebuilds the PC item storage grid and keeps the selected item slot highlighted.
function renderItemGrid() {
  elements.itemGrid.replaceChildren();
  if (!workingSave) {
    elements.itemCountBadge.textContent = '0 / 30 occupied';
    return;
  }

  const occupied = workingSave.pcItems.filter(slot => slot.present).length;
  elements.itemCountBadge.textContent = `${occupied} / 30 occupied`;

  for (const slot of workingSave.pcItems) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'slot-card';
    if (selectedItemSlotIndex === slot.slotIndex) {
      button.classList.add('selected');
    }

    const label = document.createElement('span');
    label.className = 'slot-label';
    label.textContent = `Slot ${slot.slotNumber}`;

    const name = document.createElement('span');
    name.className = 'slot-name';
    name.textContent = getItemName(slot.itemId);

    const subtext = document.createElement('span');
    subtext.className = 'slot-subtext';
    subtext.textContent = slot.present
      ? `x${slot.quantity}`
      : 'Click to target this empty item slot.';

    button.replaceChildren(label, name, subtext);
    button.addEventListener('click', () => {
      selectedItemSlotIndex = slot.slotIndex;
      hydrateItemEditorFromSelectedSlot();
      persistWorkingSave();
      renderAll();
    });
    elements.itemGrid.appendChild(button);
  }
}

// Refreshes the current-slot inspector on the right side.
function renderCurrentSlotDetail() {
  const slot = getSelectedSlot();
  elements.currentSlotDetail.replaceChildren();

  if (!slot) {
    elements.currentSlotDetail.textContent = 'Load a save and click a team or box slot.';
    elements.currentSlotDetail.className = 'detail-body muted';
    return;
  }

  elements.currentSlotDetail.className = 'detail-body';
  const lines = [
    createDetailLine('Target', formatTargetLabel(selectedTarget)),
    createDetailLine('Species', slot.present ? getSpeciesName(slot.speciesId) : 'Empty'),
    createDetailLine('Trainer', slot.present ? `${slot.trainerName || '-'} / ${slot.trainerId}` : '-'),
    createDetailLine('Level', slot.present ? String(slot.level) : '-'),
    createDetailLine('Abilities', formatSlotAbilityNames(slot)),
    createDetailLine('Moves', slot.present ? formatMoveNames(slot.moveIds) : 'None')
  ];

  if (slot.kind === 'party' && slot.present) {
    lines.push(createDetailLine('Stats', `HP ${slot.currentHp}/${slot.maxHp} | Atk ${slot.attack} | Def ${slot.defense} | Spe ${slot.speed} | SpA ${slot.specialAttack} | SpD ${slot.specialDefense}`));
  }

  elements.currentSlotDetail.replaceChildren(...lines);
}

// Refreshes the current PC item slot inspector on the right side.
function renderCurrentItemDetail() {
  const slot = getSelectedItemSlot();
  elements.currentItemDetail.replaceChildren();

  if (!workingSave || !slot) {
    elements.currentItemDetail.textContent = 'Load a save and click an item slot.';
    elements.currentItemDetail.className = 'detail-body muted';
    return;
  }

  elements.currentItemDetail.className = 'detail-body';
  const item = slot.present ? coreData.items?.[slot.itemId] || null : null;
  const lines = [
    createDetailLine('Target', formatItemTargetLabel(selectedItemSlotIndex)),
    createDetailLine('Item', slot.present ? getItemName(slot.itemId) : 'Empty'),
    createDetailLine('Quantity', slot.present ? String(slot.quantity) : '0')
  ];

  if (item?.description) {
    lines.push(createDetailLine('Description', item.description));
  }

  elements.currentItemDetail.replaceChildren(...lines);
}

// Builds the generated replacement preview for the currently typed species name.
function renderReplacementPreview() {
  elements.replacementPreview.replaceChildren();
  const inputValue = elements.speciesNameInput.value.trim();

  if (!workingSave || !selectedTarget) {
    elements.replacementPreview.textContent = 'Select a team or box slot first.';
    elements.replacementPreview.className = 'detail-body muted';
    return;
  }

  if (!inputValue) {
    elements.replacementPreview.textContent = 'Type a Pokemon name to preview the generated entry.';
    elements.replacementPreview.className = 'detail-body muted';
    return;
  }

  const mon = lookupSpeciesByName(coreData, inputValue);
  if (!mon) {
    elements.replacementPreview.textContent = 'Pokemon not found in the current dex data.';
    elements.replacementPreview.className = 'detail-body muted';
    return;
  }

  elements.replacementPreview.className = 'detail-body';
  const blueprint = buildPokemonBlueprint(mon, workingSave.metadata, coreData, 5);
  const abilityNames = blueprint.abilityPool.length
    ? blueprint.abilityPool.map(ability => ability.resolvedName).join(', ')
    : 'None';

  const moveNames = blueprint.moveIds.length
    ? blueprint.moveIds.map(moveId => coreData.moves[moveId]?.name || `Move ${moveId}`).join(', ')
    : 'None';

  const lines = [
    createDetailLine('Species', `${getSpeciesName(mon.ID)} (#${mon.dexID})`),
    createDetailLine('Level', String(blueprint.level)),
    createDetailLine('Experience', String(blueprint.exp)),
    createDetailLine('Abilities', abilityNames),
    createDetailLine('Moves', moveNames),
    createDetailLine('Stats', `HP ${blueprint.stats.maxHp} | Atk ${blueprint.stats.attack} | Def ${blueprint.stats.defense} | Spe ${blueprint.stats.speed} | SpA ${blueprint.stats.specialAttack} | SpD ${blueprint.stats.specialDefense}`),
    createDetailLine('Owner', `${workingSave.metadata.name || '-'} / ${workingSave.metadata.trainedId}`)
  ];

  elements.replacementPreview.replaceChildren(...lines);
}

// Builds the edited move preview for the selected existing Pokemon slot.
function renderReplacementMovePreview() {
  elements.replacementMovePreview.replaceChildren();
  const slot = getSelectedSlot();

  if (!workingSave || !selectedTarget) {
    elements.replacementMovePreview.textContent = 'Select a team or box slot first.';
    elements.replacementMovePreview.className = 'detail-body muted';
    return;
  }

  if (!slot?.present) {
    elements.replacementMovePreview.textContent = 'Only existing Pokemon can have their moves edited.';
    elements.replacementMovePreview.className = 'detail-body muted';
    return;
  }

  const selection = buildEditedMoveSelectionState();
  if (selection.errors.length) {
    elements.replacementMovePreview.textContent = selection.errors[0];
    elements.replacementMovePreview.className = 'detail-body muted';
    return;
  }

  elements.replacementMovePreview.className = 'detail-body';
  const lines = [
    createDetailLine('Species', getSpeciesName(slot.speciesId)),
    createDetailLine('Level', String(slot.level)),
    createDetailLine('Edited Moves', selection.enteredMoveIds.length ? formatMoveNames(selection.enteredMoveIds) : 'None'),
    createDetailLine('Legal Move Pool', `${selection.movePool.length} moves`)
  ];

  elements.replacementMovePreview.replaceChildren(...lines);
}

// Builds the replacement item preview for the currently typed item name and quantity.
function renderReplacementItemPreview() {
  elements.replacementItemPreview.replaceChildren();

  if (!workingSave) {
    elements.replacementItemPreview.textContent = 'Load a save to start editing the PC item box.';
    elements.replacementItemPreview.className = 'detail-body muted';
    return;
  }

  const quantity = parseRequestedItemQuantity();
  const inputValue = elements.itemNameInput.value.trim();

  if (!inputValue && quantity === 0) {
    elements.replacementItemPreview.textContent = 'Type an item name and quantity to preview the selected item slot.';
    elements.replacementItemPreview.className = 'detail-body muted';
    return;
  }

  if (quantity === 0) {
    elements.replacementItemPreview.textContent = 'Quantity 0 will clear the selected item slot.';
    elements.replacementItemPreview.className = 'detail-body muted';
    return;
  }

  const item = lookupItemByName(coreData, inputValue);
  if (!item) {
    elements.replacementItemPreview.textContent = 'Item not found in the current item data.';
    elements.replacementItemPreview.className = 'detail-body muted';
    return;
  }

  elements.replacementItemPreview.className = 'detail-body';
  const lines = [
    createDetailLine('Item', `${getItemName(item.ID)} (#${item.ID})`),
    createDetailLine('Quantity', String(quantity)),
    createDetailLine('Description', item.description || 'None')
  ];

  elements.replacementItemPreview.replaceChildren(...lines);
}

// Keeps button state and selected-slot labels consistent with the active UI state.
function syncControls() {
  const selectedSlot = getSelectedSlot();
  const selectedItemSlot = getSelectedItemSlot();
  const moveSelection = buildEditedMoveSelectionState();
  elements.exportSaveButton.disabled = !workingSave;
  elements.applySpeciesButton.disabled = !(workingSave && selectedTarget && elements.speciesNameInput.value.trim());
  elements.applyMoveButton.disabled = !Boolean(
    workingSave
    && selectedTarget
    && selectedSlot?.present
    && moveSelection.errors.length === 0
  );
  const itemQuantity = parseRequestedItemQuantity();
  const itemMatch = lookupItemByName(coreData, elements.itemNameInput.value);
  const canApplyItem = Boolean(
    workingSave
    && Number.isInteger(selectedItemSlotIndex)
    && selectedItemSlotIndex >= 0
    && selectedItemSlotIndex < ITEM_SLOT_COUNT
    && (itemQuantity === 0 || (itemMatch && itemQuantity > 0))
  );
  elements.applyItemButton.disabled = !canApplyItem;
  elements.selectedTargetLabel.textContent = workingSave ? formatTargetLabel(selectedTarget) : 'No slot selected';
  elements.selectedCurrentPokemon.textContent = selectedSlot?.present ? getSpeciesName(selectedSlot.speciesId) : (workingSave ? 'Empty' : '-');
  elements.selectedItemTargetLabel.textContent = workingSave ? formatItemTargetLabel(selectedItemSlotIndex) : 'No item slot selected';
  elements.selectedCurrentItem.textContent = selectedItemSlot?.present ? getItemName(selectedItemSlot.itemId) : (workingSave ? 'Empty' : '-');
}

// Re-renders every view that depends on the working save or selected slot.
function renderAll() {
  renderMetadata();
  renderPartyGrid();
  renderBoxTabs();
  renderBoxGrid();
  renderItemGrid();
  renderCurrentSlotDetail();
  renderReplacementPreview();
  renderReplacementMovePreview();
  renderCurrentItemDetail();
  renderReplacementItemPreview();
  syncControls();
}

// Loads the selected save file and initializes the first visible selection.
async function handleSaveUpload(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  elements.saveFileInput.value = '';
  setStatus(`Reading ${file.name}...`, 'info');

  try {
    workingSave = await loadSaveFile(file, coreData);
    selectedBoxNumber = 1;
    selectedTarget = { kind: 'party', slotIndex: 0 };
    selectedItemSlotIndex = 0;
    hydrateMoveEditorFromSelectedSlot();
    hydrateItemEditorFromSelectedSlot();
    renderAll();
    persistWorkingSave();
    setStatus(`Loaded ${file.name}. Edit Pokemon slots, existing moves, or PC item slots, then apply or export.`, 'success');
  } catch (error) {
    workingSave = null;
    selectedTarget = null;
    selectedItemSlotIndex = 0;
    hydrateMoveEditorFromSelectedSlot();
    hydrateItemEditorFromSelectedSlot();
    renderAll();
    clearPersistedSave();
    setStatus(error.message || 'Unable to read that save file.', 'error');
  }
}

// Applies the selected species replacement to either a party slot or a box slot.
function handleApplySpecies() {
  if (!workingSave || !selectedTarget) {
    return;
  }

  const mon = lookupSpeciesByName(coreData, elements.speciesNameInput.value);
  if (!mon) {
    setStatus('Choose a valid Pokemon name from the loaded dex data.', 'error');
    return;
  }

  try {
    if (selectedTarget.kind === 'party') {
      applyPartySpeciesChange(workingSave, selectedTarget.slotIndex, mon.ID, coreData);
    } else {
      applyBoxSpeciesChange(workingSave, selectedTarget.boxNumber, selectedTarget.slotIndex, mon.ID, coreData);
      selectedBoxNumber = selectedTarget.boxNumber;
    }

    hydrateMoveEditorFromSelectedSlot();
    renderAll();
    persistWorkingSave();
    setStatus(`Applied ${getSpeciesName(mon.ID)} to ${formatTargetLabel(selectedTarget)}.`, 'success');
  } catch (error) {
    setStatus(error.message || 'Unable to apply that Pokemon.', 'error');
  }
}

// Applies the edited move list to the currently selected existing Pokemon slot.
function handleApplyMoves() {
  if (!workingSave || !selectedTarget) {
    return;
  }

  const slot = getSelectedSlot();
  if (!slot?.present) {
    setStatus('Select an existing Pokemon before editing moves.', 'error');
    return;
  }

  const selection = buildEditedMoveSelectionState();
  if (selection.errors.length) {
    setStatus(selection.errors[0], 'error');
    return;
  }

  try {
    if (selectedTarget.kind === 'party') {
      applyPartyMoveChange(workingSave, selectedTarget.slotIndex, selection.enteredMoveIds, coreData);
    } else {
      applyBoxMoveChange(workingSave, selectedTarget.boxNumber, selectedTarget.slotIndex, selection.enteredMoveIds, coreData);
      selectedBoxNumber = selectedTarget.boxNumber;
    }

    hydrateMoveEditorFromSelectedSlot();
    renderAll();
    persistWorkingSave();
    setStatus(`Applied ${selection.enteredMoveIds.length ? formatMoveNames(selection.enteredMoveIds) : 'an empty moveset'} to ${formatTargetLabel(selectedTarget)}.`, 'success');
  } catch (error) {
    setStatus(error.message || 'Unable to apply those moves.', 'error');
  }
}

// Applies the selected item replacement to the currently selected PC item slot.
function handleApplyItem() {
  if (!workingSave) {
    return;
  }

  const quantity = parseRequestedItemQuantity();

  try {
    if (quantity === 0) {
      applyPcItemChange(workingSave, selectedItemSlotIndex, 0, 0, coreData);
      hydrateItemEditorFromSelectedSlot();
      renderAll();
      persistWorkingSave();
      setStatus(`Cleared ${formatItemTargetLabel(selectedItemSlotIndex)}.`, 'success');
      return;
    }

    const item = lookupItemByName(coreData, elements.itemNameInput.value);
    if (!item) {
      setStatus('Choose a valid item name from the loaded item data.', 'error');
      return;
    }

    applyPcItemChange(workingSave, selectedItemSlotIndex, item.ID, quantity, coreData);
    hydrateItemEditorFromSelectedSlot();
    renderAll();
    persistWorkingSave();
    setStatus(`Applied ${getItemName(item.ID)} x${quantity} to ${formatItemTargetLabel(selectedItemSlotIndex)}.`, 'success');
  } catch (error) {
    setStatus(error.message || 'Unable to apply that item.', 'error');
  }
}

// Downloads the edited save after sector checksums are refreshed.
function handleExport() {
  if (!workingSave) {
    return;
  }

  try {
    const bytes = exportEditedSave(workingSave);
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = buildOutputFileName(workingSave.fileName);
    link.click();
    URL.revokeObjectURL(url);
    setStatus(`Exported ${link.download}.`, 'success');
  } catch (error) {
    setStatus(error.message || 'Unable to export the edited save.', 'error');
  }
}

// Boots the standalone editor and wires its UI once the repo data is ready.
async function start() {
  try {
    coreData = await loadCoreData();
    renderAll();
    const restored = await restorePersistedSave();
    hydrateMoveEditorFromSelectedSlot();
    hydrateItemEditorFromSelectedSlot();
    renderAll();
    setStatus(
      restored
        ? `Restored ${workingSave.fileName} from browser storage.`
        : 'Repo data loaded. Choose a save file to start editing.',
      'success'
    );
  } catch (error) {
    setStatus(error.message || 'Unable to load repo data.', 'error');
    throw error;
  }
}

elements.saveFileInput.addEventListener('change', handleSaveUpload);
elements.applySpeciesButton.addEventListener('click', handleApplySpecies);
elements.applyMoveButton.addEventListener('click', handleApplyMoves);
elements.applyItemButton.addEventListener('click', handleApplyItem);
elements.exportSaveButton.addEventListener('click', handleExport);
elements.speciesNameInput.addEventListener('input', () => {
  renderReplacementPreview();
  syncControls();
  renderSpeciesSuggestions(elements.speciesNameInput.value);
});
elements.speciesNameInput.addEventListener('focus', () => {
  renderSpeciesSuggestions(elements.speciesNameInput.value);
});
elements.speciesNameInput.addEventListener('blur', () => {
  scheduleSpeciesSuggestionHide();
});
elements.speciesNameInput.addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' && visibleSpeciesSuggestions.length) {
    event.preventDefault();
    moveActiveSpeciesSuggestion(1);
    return;
  }

  if (event.key === 'ArrowUp' && visibleSpeciesSuggestions.length) {
    event.preventDefault();
    moveActiveSpeciesSuggestion(-1);
    return;
  }

  if (event.key === 'Enter' && activeSpeciesSuggestionIndex >= 0) {
    event.preventDefault();
    applySpeciesSuggestion(visibleSpeciesSuggestions[activeSpeciesSuggestionIndex]);
    return;
  }

  if (event.key === 'Escape') {
    hideSpeciesSuggestions();
  }
});
elements.speciesSuggestionList.addEventListener('mouseenter', clearSpeciesSuggestionHideTimer);
elements.speciesSuggestionList.addEventListener('mouseleave', scheduleSpeciesSuggestionHide);
elements.moveNameInputs.forEach((input, fieldIndex) => {
  input.addEventListener('input', () => {
    renderReplacementMovePreview();
    syncControls();
    renderMoveSuggestions(fieldIndex, input.value);
  });
  input.addEventListener('focus', () => {
    renderMoveSuggestions(fieldIndex, input.value);
  });
  input.addEventListener('blur', () => {
    scheduleMoveSuggestionHide();
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' && visibleMoveSuggestions.length && activeMoveSuggestionFieldIndex === fieldIndex) {
      event.preventDefault();
      moveActiveMoveSuggestion(1);
      return;
    }

    if (event.key === 'ArrowUp' && visibleMoveSuggestions.length && activeMoveSuggestionFieldIndex === fieldIndex) {
      event.preventDefault();
      moveActiveMoveSuggestion(-1);
      return;
    }

    if (event.key === 'Enter' && activeMoveSuggestionIndex >= 0 && activeMoveSuggestionFieldIndex === fieldIndex) {
      event.preventDefault();
      applyMoveSuggestion(fieldIndex, visibleMoveSuggestions[activeMoveSuggestionIndex]);
      return;
    }

    if (event.key === 'Escape') {
      hideMoveSuggestions();
    }
  });
});
elements.moveSuggestionLists.forEach(list => {
  list.addEventListener('mouseenter', clearMoveSuggestionHideTimer);
  list.addEventListener('mouseleave', scheduleMoveSuggestionHide);
});
elements.itemNameInput.addEventListener('input', () => {
  renderReplacementItemPreview();
  syncControls();
  renderItemSuggestions(elements.itemNameInput.value);
});
elements.itemNameInput.addEventListener('focus', () => {
  renderItemSuggestions(elements.itemNameInput.value);
});
elements.itemNameInput.addEventListener('blur', () => {
  scheduleItemSuggestionHide();
});
elements.itemNameInput.addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' && visibleItemSuggestions.length) {
    event.preventDefault();
    moveActiveItemSuggestion(1);
    return;
  }

  if (event.key === 'ArrowUp' && visibleItemSuggestions.length) {
    event.preventDefault();
    moveActiveItemSuggestion(-1);
    return;
  }

  if (event.key === 'Enter' && activeItemSuggestionIndex >= 0) {
    event.preventDefault();
    applyItemSuggestion(visibleItemSuggestions[activeItemSuggestionIndex]);
    return;
  }

  if (event.key === 'Escape') {
    hideItemSuggestions();
  }
});
elements.itemQuantityInput.addEventListener('input', () => {
  renderReplacementItemPreview();
  syncControls();
});
elements.itemSuggestionList.addEventListener('mouseenter', clearItemSuggestionHideTimer);
elements.itemSuggestionList.addEventListener('mouseleave', scheduleItemSuggestionHide);

start();
