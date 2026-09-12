import {
  loadCoreData,
  lookupItemByName,
  lookupSpeciesByName,
  normalizeItemLookupKey,
  normalizeMoveLookupKey,
  normalizeSpeciesLookupKey
} from './coreData.js';
import {
  buildEditableMovePool,
  buildPokemonBlueprint,
  resolveAbilityPool
} from './pokemonLogic.js';
import {
  applyBoxMoveChange,
  applyBoxHeldItemChange,
  applyPcItemChange,
  applyBoxSpeciesChange,
  applyPartyMoveChange,
  applyPartyHeldItemChange,
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
  shinyInput: document.getElementById('shinyInput'),
  pokemonItemNameInput: document.getElementById('pokemonItemNameInput'),
  pokemonItemSuggestionList: document.getElementById('pokemonItemSuggestionList'),
  applyPokemonItemButton: document.getElementById('applyPokemonItemButton'),
  currentSlotDetail: document.getElementById('currentSlotDetail'),
  replacementPreview: document.getElementById('replacementPreview'),
  pokemonItemPreview: document.getElementById('pokemonItemPreview'),
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
const itemSuggestionEditors = {
  pc: {
    visibleSuggestions: [],
    activeSuggestionIndex: -1,
    hideTimer: null
  },
  pokemon: {
    visibleSuggestions: [],
    activeSuggestionIndex: -1,
    hideTimer: null
  }
};
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
const GRAPHICS_ROOT = '../graphics';

function getItemSuggestionContext(editorKey) {
  if (editorKey === 'pokemon') {
    return {
      state: itemSuggestionEditors.pokemon,
      input: elements.pokemonItemNameInput,
      suggestionList: elements.pokemonItemSuggestionList,
      renderPreview: renderPokemonItemPreview
    };
  }

  return {
    state: itemSuggestionEditors.pc,
    input: elements.itemNameInput,
    suggestionList: elements.itemSuggestionList,
    renderPreview: renderReplacementItemPreview
  };
}

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

// Returns the existing repository sprite path for one species or item.
function getSpeciesSpritePath(speciesId, shiny = false) {
  const folder = shiny ? 'species/front shiny' : 'species/front';
  return encodeURI(`${GRAPHICS_ROOT}/${folder}/${speciesId}.png`);
}

function getItemSpritePath(itemId) {
  return encodeURI(`${GRAPHICS_ROOT}/items/${itemId}.png`);
}

// Creates a resilient sprite element that hides itself if an asset is unavailable.
function createSpriteImage(source, alt, className, fallbackSource = null) {
  const image = document.createElement('img');
  let fallbackAttempted = false;
  image.className = className;
  image.alt = alt;
  image.loading = 'lazy';
  image.decoding = 'async';
  image.src = source;
  image.addEventListener('error', () => {
    if (fallbackSource && !fallbackAttempted) {
      fallbackAttempted = true;
      image.src = fallbackSource;
      return;
    }
    image.hidden = true;
  });
  return image;
}

function createPokemonSprite(slot, className = 'slot-sprite') {
  if (!slot?.present || !slot.speciesId) {
    return null;
  }

  const regularPath = getSpeciesSpritePath(slot.speciesId);
  const shinyPath = getSpeciesSpritePath(slot.speciesId, true);
  return createSpriteImage(
    slot.shiny ? shinyPath : regularPath,
    `${getSpeciesName(slot.speciesId)}${slot.shiny ? ' shiny' : ''} sprite`,
    className,
    slot.shiny ? regularPath : null
  );
}

function createItemSprite(itemId, className = 'item-sprite') {
  if (!itemId) {
    return null;
  }

  return createSpriteImage(
    getItemSpritePath(itemId),
    `${getItemName(itemId)} item sprite`,
    className
  );
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
function clearItemSuggestionHideTimer(editorKey = 'pc') {
  const { state } = getItemSuggestionContext(editorKey);
  if (state.hideTimer) {
    clearTimeout(state.hideTimer);
    state.hideTimer = null;
  }
}

// Hides the item popup after clicks and blur transitions settle.
function hideItemSuggestions(editorKey = 'pc') {
  const { state, suggestionList } = getItemSuggestionContext(editorKey);
  clearItemSuggestionHideTimer(editorKey);
  state.visibleSuggestions = [];
  state.activeSuggestionIndex = -1;
  suggestionList.hidden = true;
  suggestionList.replaceChildren();
}

// Applies one item suggestion into the input while keeping the preview and button state in sync.
function applyItemSuggestion(suggestion, editorKey = 'pc') {
  if (!suggestion) {
    return;
  }

  const { input, renderPreview } = getItemSuggestionContext(editorKey);
  input.value = suggestion.value;
  hideItemSuggestions(editorKey);
  renderPreview();
  syncControls();
  input.focus();
  const cursor = input.value.length;
  input.setSelectionRange(cursor, cursor);
}

// Moves the active keyboard selection through the visible item suggestion popup.
function moveActiveItemSuggestion(delta, editorKey = 'pc') {
  const { state, input } = getItemSuggestionContext(editorKey);
  if (!state.visibleSuggestions.length) {
    return;
  }

  if (state.activeSuggestionIndex < 0) {
    state.activeSuggestionIndex = delta > 0 ? 0 : state.visibleSuggestions.length - 1;
  } else {
    state.activeSuggestionIndex = (state.activeSuggestionIndex + delta + state.visibleSuggestions.length) % state.visibleSuggestions.length;
  }

  renderItemSuggestions(editorKey, input.value, true);
}

// Syncs the active item row highlight without rebuilding the popup on every pointer move.
function updateActiveItemSuggestionRow(editorKey = 'pc') {
  const { state, suggestionList } = getItemSuggestionContext(editorKey);
  Array.from(suggestionList.children).forEach((row, index) => {
    row.classList.toggle('active', index === state.activeSuggestionIndex);
  });
}

// Rebuilds the popup rows for the current item query and keeps the active row highlighted.
function renderItemSuggestions(editorKey, query, preserveActiveIndex = false) {
  const { state, input, suggestionList } = getItemSuggestionContext(editorKey);
  const matches = buildItemSuggestionMatches(query);
  state.visibleSuggestions = matches;

  if (!matches.length || document.activeElement !== input) {
    hideItemSuggestions(editorKey);
    return;
  }

  if (!preserveActiveIndex || state.activeSuggestionIndex >= matches.length) {
    state.activeSuggestionIndex = -1;
  }

  const rows = matches.map((suggestion, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'species-suggestion';
    if (index === state.activeSuggestionIndex) {
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
      applyItemSuggestion(suggestion, editorKey);
    });
    button.addEventListener('mouseenter', () => {
      state.activeSuggestionIndex = index;
      updateActiveItemSuggestionRow(editorKey);
    });

    return button;
  });

  clearItemSuggestionHideTimer(editorKey);
  suggestionList.hidden = false;
  suggestionList.replaceChildren(...rows);
  updateActiveItemSuggestionRow(editorKey);
}

// Starts the delayed close used when the item field loses focus or hover.
function scheduleItemSuggestionHide(editorKey = 'pc') {
  const { state } = getItemSuggestionContext(editorKey);
  clearItemSuggestionHideTimer(editorKey);
  state.hideTimer = window.setTimeout(() => {
    hideItemSuggestions(editorKey);
  }, 120);
}

// Returns whether the selected slot currently holds a real Pokemon whose moves can be edited.
function isMoveEditableSlot(slot = getSelectedSlot()) {
  return Boolean(workingSave && slot?.present);
}

// Builds the legal move pool for the selected slot using its current species and save rules.
function buildSelectedSlotMovePool() {
  const slot = getSelectedSlot();
  if (!isMoveEditableSlot(slot)) {
    return [];
  }

  const mon = coreData?.species?.[slot.speciesId];
  if (!mon) {
    return [];
  }

  return buildEditableMovePool(mon, workingSave.metadata, coreData).map(move => ({
    ...move,
    normalizedLabel: normalizeMoveLookupKey(move.name)
  }));
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
    meta.textContent = suggestion.source;
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

// Resolves the held item currently typed for the selected Pokemon editor.
function resolveSelectedPokemonHeldItem() {
  const inputValue = elements.pokemonItemNameInput.value.trim();
  if (!inputValue) {
    return { itemId: 0, item: null };
  }

  const item = lookupItemByName(coreData, inputValue);
  if (!item) {
    throw new Error('Choose a valid held item name from the loaded item data.');
  }

  return {
    itemId: item.ID,
    item
  };
}

// Loads the currently selected Pokemon's held item into the editor input.
function hydratePokemonItemEditorFromSelectedSlot() {
  const slot = getSelectedSlot();
  if (!slot) {
    elements.pokemonItemNameInput.value = '';
    hideItemSuggestions('pokemon');
    return;
  }

  elements.pokemonItemNameInput.value = slot.present && slot.heldItemId ? getItemName(slot.heldItemId) : '';
  hideItemSuggestions('pokemon');
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
  hideItemSuggestions('pc');
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

// Builds the compact visual used by party and box slots on both desktop and mobile.
function buildPokemonSlotContent(slot, emptyMessage) {
  const visual = document.createElement('div');
  visual.className = 'slot-card-visual';
  const sprite = createPokemonSprite(slot);
  if (sprite) {
    visual.appendChild(sprite);
  } else {
    const placeholder = document.createElement('span');
    placeholder.className = 'slot-sprite-placeholder';
    placeholder.textContent = '--';
    visual.appendChild(placeholder);
  }

  const content = document.createElement('div');
  content.className = 'slot-card-content';
  const label = document.createElement('span');
  label.className = 'slot-label';
  label.textContent = `Slot ${slot.slotNumber}`;

  const name = document.createElement('span');
  name.className = 'slot-name';
  name.textContent = slot.present
    ? `${getSpeciesName(slot.speciesId)}${slot.shiny ? ' [Shiny]' : ''}`
    : 'Empty';

  const subtext = document.createElement('span');
  subtext.className = 'slot-subtext';
  subtext.textContent = slot.present
    ? `Lv ${slot.level} | ${slot.heldItemId ? `Held: ${getItemName(slot.heldItemId)}` : 'No held item'}`
    : emptyMessage;

  content.replaceChildren(label, name, subtext);
  return [visual, content];
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

    button.replaceChildren(...buildPokemonSlotContent(slot, 'Click to target this empty team slot.'));
    button.addEventListener('click', () => {
      selectedTarget = { kind: 'party', slotIndex: slot.slotIndex };
      hydrateMoveEditorFromSelectedSlot();
      hydratePokemonItemEditorFromSelectedSlot();
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

    button.replaceChildren(...buildPokemonSlotContent(slot, 'Click to target this empty box slot.'));
    button.addEventListener('click', () => {
      selectedTarget = {
        kind: 'box',
        boxNumber: currentBox.boxNumber,
        slotIndex: slot.slotIndex
      };
      hydrateMoveEditorFromSelectedSlot();
      hydratePokemonItemEditorFromSelectedSlot();
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

    const visual = document.createElement('div');
    visual.className = 'slot-card-visual item-card-visual';
    const sprite = createItemSprite(slot.itemId);
    if (sprite) {
      visual.appendChild(sprite);
    } else {
      const placeholder = document.createElement('span');
      placeholder.className = 'slot-sprite-placeholder';
      placeholder.textContent = '--';
      visual.appendChild(placeholder);
    }

    const content = document.createElement('div');
    content.className = 'slot-card-content';
    const label = document.createElement('span');
    label.className = 'slot-label';
    label.textContent = `Slot ${slot.slotNumber}`;
    const name = document.createElement('span');
    name.className = 'slot-name';
    name.textContent = slot.present ? getItemName(slot.itemId) : 'Empty';
    const subtext = document.createElement('span');
    subtext.className = 'slot-subtext';
    subtext.textContent = slot.present ? `x${slot.quantity}` : 'Click to target this empty item slot.';
    content.replaceChildren(label, name, subtext);
    button.replaceChildren(visual, content);
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
    createDetailLine('Held Item', slot.present && slot.heldItemId ? getItemName(slot.heldItemId) : 'None'),
    createDetailLine('Abilities', formatSlotAbilityNames(slot)),
    createDetailLine('Moves', slot.present ? formatMoveNames(slot.moveIds) : 'None')
  ];

  if (slot.kind === 'party' && slot.present) {
    lines.push(createDetailLine('Stats', `HP ${slot.currentHp}/${slot.maxHp} | Atk ${slot.attack} | Def ${slot.defense} | Spe ${slot.speed} | SpA ${slot.specialAttack} | SpD ${slot.specialDefense}`));
  }

  const identity = document.createElement('div');
  identity.className = 'detail-identity';
  const sprite = createPokemonSprite(slot, 'detail-sprite');
  if (sprite) {
    identity.appendChild(sprite);
  }
  const identityCopy = document.createElement('div');
  identityCopy.className = 'detail-identity-copy';
  identityCopy.textContent = slot.present
    ? `${getSpeciesName(slot.speciesId)}${slot.shiny ? ' [Shiny]' : ''}`
    : 'Empty slot';
  identity.appendChild(identityCopy);

  elements.currentSlotDetail.replaceChildren(identity, ...lines);
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

  const identity = document.createElement('div');
  identity.className = 'detail-identity';
  const sprite = createItemSprite(slot.present ? slot.itemId : 0, 'detail-sprite item-detail-sprite');
  if (sprite) {
    identity.appendChild(sprite);
  }
  const identityCopy = document.createElement('div');
  identityCopy.className = 'detail-identity-copy';
  identityCopy.textContent = slot.present ? getItemName(slot.itemId) : 'Empty item slot';
  identity.appendChild(identityCopy);

  elements.currentItemDetail.replaceChildren(identity, ...lines);
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
  const heldItemInputValue = elements.pokemonItemNameInput.value.trim();
  const heldItem = heldItemInputValue ? lookupItemByName(coreData, heldItemInputValue) : null;
  const heldItemLabel = heldItemInputValue
    ? (heldItem ? `${getItemName(heldItem.ID)} (#${heldItem.ID})` : 'Invalid item name')
    : 'None';
  const shinyLabel = elements.shinyInput.checked ? 'Yes' : 'No';

  const moveNames = blueprint.moveIds.length
    ? blueprint.moveIds.map(moveId => coreData.moves[moveId]?.name || `Move ${moveId}`).join(', ')
    : 'None';

  const lines = [
    createDetailLine('Species', `${getSpeciesName(mon.ID)} (#${mon.dexID})`),
    createDetailLine('Level', String(blueprint.level)),
    createDetailLine('Experience', String(blueprint.exp)),
    createDetailLine('Shiny', shinyLabel),
    createDetailLine('Held Item', heldItemLabel),
    createDetailLine('Abilities', abilityNames),
    createDetailLine('Moves', moveNames),
    createDetailLine('Stats', `HP ${blueprint.stats.maxHp} | Atk ${blueprint.stats.attack} | Def ${blueprint.stats.defense} | Spe ${blueprint.stats.speed} | SpA ${blueprint.stats.specialAttack} | SpD ${blueprint.stats.specialDefense}`),
    createDetailLine('Owner', `${workingSave.metadata.name || '-'} / ${workingSave.metadata.trainedId}`)
  ];

  const identity = document.createElement('div');
  identity.className = 'detail-identity';
  identity.appendChild(createSpriteImage(
    getSpeciesSpritePath(mon.ID, elements.shinyInput.checked),
    `${getSpeciesName(mon.ID)} preview sprite`,
    'detail-sprite',
    getSpeciesSpritePath(mon.ID)
  ));
  const identityCopy = document.createElement('div');
  identityCopy.className = 'detail-identity-copy';
  identityCopy.textContent = `${getSpeciesName(mon.ID)}${elements.shinyInput.checked ? ' [Shiny]' : ''}`;
  identity.appendChild(identityCopy);

  elements.replacementPreview.replaceChildren(identity, ...lines);
}

// Builds the held-item preview for the selected Pokemon editor.
function renderPokemonItemPreview() {
  elements.pokemonItemPreview.replaceChildren();

  if (!workingSave || !selectedTarget) {
    elements.pokemonItemPreview.textContent = 'Select a team or box slot first.';
    elements.pokemonItemPreview.className = 'detail-body muted';
    return;
  }

  const inputValue = elements.pokemonItemNameInput.value.trim();
  if (!inputValue) {
    elements.pokemonItemPreview.textContent = 'Leave blank to clear the held item or create a Pokemon with no held item.';
    elements.pokemonItemPreview.className = 'detail-body muted';
    return;
  }

  const item = lookupItemByName(coreData, inputValue);
  if (!item) {
    elements.pokemonItemPreview.textContent = 'Held item not found in the current item data.';
    elements.pokemonItemPreview.className = 'detail-body muted';
    return;
  }

  elements.pokemonItemPreview.className = 'detail-body';
  const lines = [
    createDetailLine('Item', `${getItemName(item.ID)} (#${item.ID})`),
    createDetailLine('Description', item.description || 'None')
  ];

  const identity = document.createElement('div');
  identity.className = 'detail-identity';
  identity.appendChild(createItemSprite(item.ID, 'detail-sprite item-detail-sprite'));
  const identityCopy = document.createElement('div');
  identityCopy.className = 'detail-identity-copy';
  identityCopy.textContent = getItemName(item.ID);
  identity.appendChild(identityCopy);

  elements.pokemonItemPreview.replaceChildren(identity, ...lines);
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
    createDetailLine('Available Move Pool', `${selection.movePool.length} moves`)
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

  const identity = document.createElement('div');
  identity.className = 'detail-identity';
  identity.appendChild(createItemSprite(item.ID, 'detail-sprite item-detail-sprite'));
  const identityCopy = document.createElement('div');
  identityCopy.className = 'detail-identity-copy';
  identityCopy.textContent = getItemName(item.ID);
  identity.appendChild(identityCopy);

  elements.replacementItemPreview.replaceChildren(identity, ...lines);
}

// Keeps button state and selected-slot labels consistent with the active UI state.
function syncControls() {
  const selectedSlot = getSelectedSlot();
  const selectedItemSlot = getSelectedItemSlot();
  const moveSelection = buildEditedMoveSelectionState();
  const pokemonHeldItemInput = elements.pokemonItemNameInput.value.trim();
  const pokemonHeldItemMatch = pokemonHeldItemInput ? lookupItemByName(coreData, pokemonHeldItemInput) : null;
  elements.exportSaveButton.disabled = !workingSave;
  elements.applySpeciesButton.disabled = !Boolean(
    workingSave
    && selectedTarget
    && elements.speciesNameInput.value.trim()
    && (!pokemonHeldItemInput || pokemonHeldItemMatch)
  );
  elements.applyPokemonItemButton.disabled = !Boolean(
    workingSave
    && selectedTarget
    && selectedSlot?.present
    && (!pokemonHeldItemInput || pokemonHeldItemMatch)
  );
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
  renderPokemonItemPreview();
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
    hydratePokemonItemEditorFromSelectedSlot();
    hydrateItemEditorFromSelectedSlot();
    renderAll();
    persistWorkingSave();
    setStatus(`Loaded ${file.name}. Edit Pokemon slots, existing moves, or PC item slots, then apply or export.`, 'success');
  } catch (error) {
    workingSave = null;
    selectedTarget = null;
    selectedItemSlotIndex = 0;
    hydrateMoveEditorFromSelectedSlot();
    hydratePokemonItemEditorFromSelectedSlot();
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
    const { itemId: heldItemId, item: heldItem } = resolveSelectedPokemonHeldItem();

    if (selectedTarget.kind === 'party') {
      applyPartySpeciesChange(workingSave, selectedTarget.slotIndex, mon.ID, coreData, heldItemId, elements.shinyInput.checked);
    } else {
      applyBoxSpeciesChange(workingSave, selectedTarget.boxNumber, selectedTarget.slotIndex, mon.ID, coreData, heldItemId, elements.shinyInput.checked);
      selectedBoxNumber = selectedTarget.boxNumber;
    }

    hydrateMoveEditorFromSelectedSlot();
    hydratePokemonItemEditorFromSelectedSlot();
    renderAll();
    persistWorkingSave();
    setStatus(
      `Applied ${getSpeciesName(mon.ID)}${heldItem ? ` holding ${getItemName(heldItem.ID)}` : ''} to ${formatTargetLabel(selectedTarget)}.`,
      'success'
    );
  } catch (error) {
    setStatus(error.message || 'Unable to apply that Pokemon.', 'error');
  }
}

// Applies the selected held item to the currently selected existing Pokemon slot.
function handleApplyPokemonItem() {
  if (!workingSave || !selectedTarget) {
    return;
  }

  const slot = getSelectedSlot();
  if (!slot?.present) {
    setStatus('Select an existing Pokemon before editing its held item.', 'error');
    return;
  }

  try {
    const { itemId, item } = resolveSelectedPokemonHeldItem();

    if (selectedTarget.kind === 'party') {
      applyPartyHeldItemChange(workingSave, selectedTarget.slotIndex, itemId, coreData);
    } else {
      applyBoxHeldItemChange(workingSave, selectedTarget.boxNumber, selectedTarget.slotIndex, itemId, coreData);
      selectedBoxNumber = selectedTarget.boxNumber;
    }

    hydratePokemonItemEditorFromSelectedSlot();
    renderAll();
    persistWorkingSave();
    setStatus(
      item
        ? `Applied ${getItemName(item.ID)} to ${formatTargetLabel(selectedTarget)}.`
        : `Cleared the held item on ${formatTargetLabel(selectedTarget)}.`,
      'success'
    );
  } catch (error) {
    setStatus(error.message || 'Unable to apply that held item.', 'error');
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
    hydratePokemonItemEditorFromSelectedSlot();
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
elements.applyPokemonItemButton.addEventListener('click', handleApplyPokemonItem);
elements.applyMoveButton.addEventListener('click', handleApplyMoves);
elements.applyItemButton.addEventListener('click', handleApplyItem);
elements.exportSaveButton.addEventListener('click', handleExport);
elements.speciesNameInput.addEventListener('input', () => {
  renderReplacementPreview();
  syncControls();
  renderSpeciesSuggestions(elements.speciesNameInput.value);
});
elements.shinyInput.addEventListener('change', () => {
  renderReplacementPreview();
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
  renderItemSuggestions('pc', elements.itemNameInput.value);
});
elements.itemNameInput.addEventListener('focus', () => {
  renderItemSuggestions('pc', elements.itemNameInput.value);
});
elements.itemNameInput.addEventListener('blur', () => {
  scheduleItemSuggestionHide('pc');
});
elements.itemNameInput.addEventListener('keydown', event => {
  const state = itemSuggestionEditors.pc;
  if (event.key === 'ArrowDown' && state.visibleSuggestions.length) {
    event.preventDefault();
    moveActiveItemSuggestion(1, 'pc');
    return;
  }

  if (event.key === 'ArrowUp' && state.visibleSuggestions.length) {
    event.preventDefault();
    moveActiveItemSuggestion(-1, 'pc');
    return;
  }

  if (event.key === 'Enter' && state.activeSuggestionIndex >= 0) {
    event.preventDefault();
    applyItemSuggestion(state.visibleSuggestions[state.activeSuggestionIndex], 'pc');
    return;
  }

  if (event.key === 'Escape') {
    hideItemSuggestions('pc');
  }
});
elements.pokemonItemNameInput.addEventListener('input', () => {
  renderReplacementPreview();
  renderPokemonItemPreview();
  syncControls();
  renderItemSuggestions('pokemon', elements.pokemonItemNameInput.value);
});
elements.pokemonItemNameInput.addEventListener('focus', () => {
  renderItemSuggestions('pokemon', elements.pokemonItemNameInput.value);
});
elements.pokemonItemNameInput.addEventListener('blur', () => {
  scheduleItemSuggestionHide('pokemon');
});
elements.pokemonItemNameInput.addEventListener('keydown', event => {
  const state = itemSuggestionEditors.pokemon;
  if (event.key === 'ArrowDown' && state.visibleSuggestions.length) {
    event.preventDefault();
    moveActiveItemSuggestion(1, 'pokemon');
    return;
  }

  if (event.key === 'ArrowUp' && state.visibleSuggestions.length) {
    event.preventDefault();
    moveActiveItemSuggestion(-1, 'pokemon');
    return;
  }

  if (event.key === 'Enter' && state.activeSuggestionIndex >= 0) {
    event.preventDefault();
    applyItemSuggestion(state.visibleSuggestions[state.activeSuggestionIndex], 'pokemon');
    return;
  }

  if (event.key === 'Escape') {
    hideItemSuggestions('pokemon');
  }
});
elements.itemQuantityInput.addEventListener('input', () => {
  renderReplacementItemPreview();
  syncControls();
});
elements.itemSuggestionList.addEventListener('mouseenter', () => clearItemSuggestionHideTimer('pc'));
elements.itemSuggestionList.addEventListener('mouseleave', () => scheduleItemSuggestionHide('pc'));
elements.pokemonItemSuggestionList.addEventListener('mouseenter', () => clearItemSuggestionHideTimer('pokemon'));
elements.pokemonItemSuggestionList.addEventListener('mouseleave', () => scheduleItemSuggestionHide('pokemon'));

start();
