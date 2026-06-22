import { loadCoreData, lookupSpeciesByName, normalizeSpeciesLookupKey } from './coreData.js';
import { buildPokemonBlueprint } from './pokemonLogic.js';
import {
  applyBoxSpeciesChange,
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
  partyCountBadge: document.getElementById('partyCountBadge'),
  boxCountBadge: document.getElementById('boxCountBadge'),
  partyGrid: document.getElementById('partyGrid'),
  boxTabs: document.getElementById('boxTabs'),
  boxGrid: document.getElementById('boxGrid'),
  selectedTargetLabel: document.getElementById('selectedTargetLabel'),
  selectedCurrentPokemon: document.getElementById('selectedCurrentPokemon'),
  currentSlotDetail: document.getElementById('currentSlotDetail'),
  replacementPreview: document.getElementById('replacementPreview')
};

let coreData = null;
let workingSave = null;
let selectedBoxNumber = 1;
let selectedTarget = null;
let visibleSpeciesSuggestions = [];
let activeSpeciesSuggestionIndex = -1;
let speciesSuggestionHideTimer = null;
const BOX_CAPACITY = 30;
const MAX_SPECIES_SUGGESTIONS = 5;
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
        selectedTarget
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

// Creates the visual label for one selected target.
function formatTargetLabel(target) {
  if (!target) {
    return 'No slot selected';
  }

  return target.kind === 'party'
    ? `Team Slot ${target.slotIndex + 1}`
    : `Box ${target.boxNumber}, Slot ${target.slotIndex + 1}`;
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

// Renders trainer metadata and save flags from the currently loaded save.
function renderMetadata() {
  if (!workingSave) {
    elements.trainerName.textContent = '-';
    elements.trainerId.textContent = '-';
    elements.saveFlags.textContent = '-';
    elements.speciesPool.textContent = '-';
    return;
  }

  elements.trainerName.textContent = workingSave.metadata.name || '(unknown)';
  elements.trainerId.textContent = String(workingSave.metadata.trainedId || 0);
  elements.saveFlags.textContent = formatSaveFlags(workingSave.metadata);
  elements.speciesPool.textContent = workingSave.metadata.random.speciesPoolKey || 'None';
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
      persistWorkingSave();
      renderAll();
    });
    elements.boxGrid.appendChild(button);
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
    createDetailLine('Moves', slot.present ? formatMoveNames(slot.moveIds) : 'None')
  ];

  if (slot.kind === 'party' && slot.present) {
    lines.push(createDetailLine('Stats', `HP ${slot.currentHp}/${slot.maxHp} | Atk ${slot.attack} | Def ${slot.defense} | Spe ${slot.speed} | SpA ${slot.specialAttack} | SpD ${slot.specialDefense}`));
  }

  elements.currentSlotDetail.replaceChildren(...lines);
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

// Keeps button state and selected-slot labels consistent with the active UI state.
function syncControls() {
  elements.exportSaveButton.disabled = !workingSave;
  elements.applySpeciesButton.disabled = !(workingSave && selectedTarget && elements.speciesNameInput.value.trim());
  elements.selectedTargetLabel.textContent = formatTargetLabel(selectedTarget);
  elements.selectedCurrentPokemon.textContent = getSelectedSlot()?.present ? getSpeciesName(getSelectedSlot().speciesId) : 'Empty';
}

// Re-renders every view that depends on the working save or selected slot.
function renderAll() {
  renderMetadata();
  renderPartyGrid();
  renderBoxTabs();
  renderBoxGrid();
  renderCurrentSlotDetail();
  renderReplacementPreview();
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
    renderAll();
    persistWorkingSave();
    setStatus(`Loaded ${file.name}. Click any team or box slot, type a Pokemon name, then apply or export.`, 'success');
  } catch (error) {
    workingSave = null;
    selectedTarget = null;
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

    renderAll();
    persistWorkingSave();
    setStatus(`Applied ${getSpeciesName(mon.ID)} to ${formatTargetLabel(selectedTarget)}.`, 'success');
  } catch (error) {
    setStatus(error.message || 'Unable to apply that Pokemon.', 'error');
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

start();
