// Firefox exposes promise-based APIs on `browser`; Chrome MV3 returns promises
// from `chrome`. Use whichever is available for the await-based tabs calls.
const ext = typeof browser !== 'undefined' ? browser : chrome;

const defaults = {
  enabled: true,
  blurFaces: true,
  genderMode: 'both',
  faceThreshold: 0.55,
  blurBodies: true,
  bodyThreshold: 0.55,
  blurPx: 24
};

const checks = ['enabled', 'blurFaces', 'blurBodies'];
const ranges = ['faceThreshold', 'bodyThreshold', 'blurPx'];
const genderModes = ['male', 'both', 'female'];
const storageKeys = [...checks, ...ranges, 'genderMode', 'femaleOnly'];

function genderLabel(mode) {
  const safeMode = genderModes.includes(mode) ? mode : defaults.genderMode;
  return safeMode.charAt(0).toUpperCase() + safeMode.slice(1);
}

function normalizeSettings(s) {
  const next = { ...defaults, ...s };
  if (!genderModes.includes(next.genderMode)) {
    next.genderMode = typeof s.femaleOnly === 'boolean'
      ? (s.femaleOnly ? 'female' : 'both')
      : defaults.genderMode;
  }
  delete next.femaleOnly;
  return next;
}

function applySettings(raw) {
  const s = normalizeSettings(raw);
  checks.forEach((k) => { document.getElementById(k).checked = !!s[k]; });
  ranges.forEach((k) => {
    const el = document.getElementById(k);
    el.value = s[k];
    const v = document.getElementById(k + 'Val');
    if (v) v.textContent = s[k];
  });
  setGenderMode(s.genderMode);
  updateDependents(s);
}

function setGenderMode(mode) {
  const safeMode = genderModes.includes(mode) ? mode : defaults.genderMode;
  const input = document.querySelector(`input[name="genderMode"][value="${safeMode}"]`);
  if (input) input.checked = true;
  document.getElementById('genderModeVal').textContent = genderLabel(safeMode);
}

function updateDependents(s) {
  const master = s.enabled;
  document.body.style.opacity = master ? '1' : '0.55';

  const genderMode = genderModes.includes(s.genderMode) ? s.genderMode : defaults.genderMode;
  const genderRestricted = genderMode !== 'both';
  const fRow = document.getElementById('faceThresholdRow');
  fRow.classList.toggle('disabled', !((s.blurFaces || s.blurBodies) && genderRestricted));
  const bRow = document.getElementById('bodyThresholdRow');
  bRow.classList.toggle('disabled', !s.blurBodies);
}

applySettings(defaults);
chrome.storage.sync.get(storageKeys, applySettings);

let saveTimer = null;
let pendingState = null;

function readState() {
  const v = {};
  checks.forEach((k) => { v[k] = document.getElementById(k).checked; });
  ranges.forEach((k) => {
    const el = document.getElementById(k);
    v[k] = el.step.includes('.') ? parseFloat(el.value) : parseInt(el.value, 10);
    const dv = document.getElementById(k + 'Val');
    if (dv) dv.textContent = v[k];
  });
  const selectedGender = document.querySelector('input[name="genderMode"]:checked');
  v.genderMode = selectedGender?.value || defaults.genderMode;
  setGenderMode(v.genderMode);
  return v;
}

function commitPendingState() {
  if (!pendingState) return;
  const next = pendingState;
  pendingState = null;
  persistSettings(next);
}

function saveDebounced() {
  const v = readState();
  updateDependents(v);
  pendingState = v;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(commitPendingState, 180);
}

function saveImmediate() {
  const v = readState();
  updateDependents(v);
  pendingState = null;
  clearTimeout(saveTimer);
  persistSettings(v);
}

function persistSettings(raw) {
  const next = normalizeSettings(raw);
  chrome.storage.sync.set(next, () => {
    if (chrome.runtime.lastError) {
      setStatus('err', 'Save failed');
      document.getElementById('stat').textContent = chrome.runtime.lastError.message;
      return;
    }

    chrome.storage.sync.remove('femaleOnly', () => {
      chrome.storage.sync.get(storageKeys, (stored) => {
        applySettings(stored);
        setTimeout(refreshStatus, 120);
      });
    });
  });
}

[...checks, ...ranges].forEach((id) => {
  document.getElementById(id).addEventListener('input', saveDebounced);
  document.getElementById(id).addEventListener('change', saveImmediate);
});

document.querySelectorAll('input[name="genderMode"]').forEach((input) => {
  input.addEventListener('change', saveImmediate);
});

document.getElementById('reset').addEventListener('click', () => {
  pendingState = null;
  clearTimeout(saveTimer);
  chrome.storage.sync.remove('femaleOnly', () => {
    chrome.storage.sync.set(defaults, () => applySettings(defaults));
  });
});

function setStatus(state, text) {
  const pill = document.getElementById('status');
  pill.classList.remove('ready', 'loading', 'err');
  pill.classList.add(state);
  document.getElementById('statusText').textContent = text;
}

async function refreshStatus() {
  try {
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/(www\.)?youtube\.com\//.test(tab.url || '')) {
      setStatus('err', 'Open YouTube');
      document.getElementById('stat').textContent = 'inactive on this page';
      return;
    }
    const resp = await ext.tabs.sendMessage(tab.id, { type: 'focustube:status' });
    if (!resp) throw new Error('no response');
    const faceRequired = resp.faceWanted || resp.bodyGenderWanted;
    const bodyRequired = resp.bodyWanted;
    const faceBlocked = faceRequired && resp.faceLoadComplete && !resp.faceReady;
    const bodyBlocked = bodyRequired && resp.bodyLoadComplete && !resp.bodyReady;

    if (!resp.enabled) setStatus('loading', 'Off');
    else if ((!faceRequired || resp.faceReady) && (!bodyRequired || resp.bodyReady)) setStatus('ready', 'Ready');
    else if (faceBlocked || bodyBlocked) setStatus('err', 'Model error');
    else setStatus('loading', 'Loading');

    const modeText = genderLabel(resp.genderMode);
    const issueText = faceBlocked
      ? 'face model failed'
      : bodyBlocked
        ? 'body model failed'
        : `${resp.queued || 0} queued`;
    document.getElementById('stat').textContent = `${resp.blurredCount} blurred · ${modeText} · ${issueText}`;
  } catch (e) {
    setStatus('err', 'Reload tab');
    document.getElementById('stat').textContent = 'content script not running';
  }
}

refreshStatus();
setInterval(refreshStatus, 2000);
