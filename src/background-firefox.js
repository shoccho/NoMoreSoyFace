// Firefox MV2 background page — persistent, has full DOM access.
// faceapi, cocoSsd, and tf are loaded as background scripts before this file.
// This combines the Chrome offscreen inference + background orchestration into one context.

// === Action API shim (MV2: browserAction, MV3: action) ===
const action = chrome.action || chrome.browserAction;

const ACTION_STATES = {
  inactive: {
    badge: '',
    badgeColor: '#64748b',
    iconColor: '#64748b',
    title: 'NoMoreSoyFace: inactive'
  },
  notReady: {
    badge: '...',
    badgeColor: '#f59e0b',
    iconColor: '#f59e0b',
    title: 'NoMoreSoyFace: not ready'
  },
  active: {
    badge: 'ON',
    badgeColor: '#22c55e',
    iconColor: '#22c55e',
    title: 'NoMoreSoyFace: active'
  },
  off: {
    badge: 'OFF',
    badgeColor: '#6b7280',
    iconColor: '#6b7280',
    title: 'NoMoreSoyFace: off'
  }
};

const iconCache = new Map();
const tabStatuses = new Map();

let sharedModelStatus = {
  faceReady: false,
  faceLoadComplete: false,
  faceError: '',
  bodyReady: false,
  bodyLoadComplete: false,
  bodyError: ''
};

// === Inference state (runs directly in this background page) ===

const TAG = '[YT-FaceBlur:BG]';
const DEBUG = false;
const log = (...a) => DEBUG && console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);
const err = (...a) => console.error(TAG, ...a);

const modelFileUrl = (file) => chrome.runtime.getURL(`models/${file}`);
const FACE_MODEL_FILES = [
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model-shard1',
  'age_gender_model-weights_manifest.json',
  'age_gender_model-shard1'
];
const DETECTION_MAX_SIDE = 360;
const BODY_GENDER_MAX_PERSONS = 3;

let faceReady = false;
let faceLoadComplete = false;
let faceError = '';
let bodyModel = null;
let bodyLoadComplete = typeof cocoSsd === 'undefined';
let bodyError = '';

const faceLoadPromise = (async () => {
  if (typeof faceapi === 'undefined') {
    faceError = 'faceapi missing';
    err('faceapi missing');
    return;
  }

  try {
    log('loading face models...');
    faceError = '';
    await preflightModelFiles(FACE_MODEL_FILES);
    await Promise.all([
      loadFaceNet(faceapi.nets.tinyFaceDetector, 'tiny_face_detector_model-weights_manifest.json'),
      loadFaceNet(faceapi.nets.ageGenderNet, 'age_gender_model-weights_manifest.json')
    ]);
    faceReady = true;
    log('face models OK', faceapi.tf?.getBackend?.());
  } catch (e) {
    faceError = formatError(e);
    err('face load fail', e);
  } finally {
    faceLoadComplete = true;
    publishModelStatus();
  }
})();

const bodyLoadPromise = (async () => {
  if (typeof cocoSsd === 'undefined') {
    bodyError = 'cocoSsd missing';
    warn('cocoSsd missing; body detection disabled');
    publishModelStatus();
    return;
  }

  try {
    log('loading coco-ssd lite...');
    bodyError = '';
    bodyModel = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
    log('coco-ssd OK', faceapi?.tf?.getBackend?.());
  } catch (e) {
    bodyError = formatError(e);
    err('coco-ssd load fail', e);
  } finally {
    bodyLoadComplete = true;
    publishModelStatus();
  }
})();

function getInferenceStatus() {
  return {
    faceReady,
    faceLoadComplete,
    faceError,
    bodyReady: !!bodyModel,
    bodyLoadComplete,
    bodyError
  };
}

function publishModelStatus() {
  updateSharedModelStatus(getInferenceStatus());
}

async function preflightModelFiles(files) {
  for (const file of files) {
    const url = modelFileUrl(file);
    const resp = await fetch(url, { cache: 'force-cache' });
    if (!resp.ok) throw new Error(`model fetch ${file} ${resp.status}`);
  }
}

async function loadFaceNet(net, manifestFile) {
  const manifestResp = await fetch(modelFileUrl(manifestFile), { cache: 'force-cache' });
  if (!manifestResp.ok) throw new Error(`model fetch ${manifestFile} ${manifestResp.status}`);

  const manifest = await manifestResp.json();
  const loadWeights = faceapi.tf.io.weightsLoaderFactory(async (paths) => Promise.all(
    paths.map(async (path) => {
      const file = String(path).split('/').pop();
      if (!file) throw new Error(`bad weight path ${path}`);

      const resp = await fetch(modelFileUrl(file), { cache: 'force-cache' });
      if (!resp.ok) throw new Error(`model fetch ${file} ${resp.status}`);
      return resp.arrayBuffer();
    })
  ));

  const weightMap = await loadWeights(manifest, '');
  net.loadFromWeightMap(weightMap);
}

function formatError(e) {
  return e?.message || String(e || 'unknown error');
}

async function waitForNeededModels(settings) {
  const waits = [];
  if (settings.blurFaces || (settings.blurBodies && isGenderRestricted(settings))) waits.push(faceLoadPromise);
  if (settings.blurBodies) waits.push(bodyLoadPromise);
  await Promise.allSettled(waits);
}

function isGenderRestricted(settings) {
  return settings.genderMode === 'male' || settings.genderMode === 'female';
}

async function detectImage(src, settings) {
  await waitForNeededModels(settings);

  const { im, url } = await loadForDetection(src);
  try {
    return await analyzeImage(im, settings);
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

async function loadForDetection(src) {
  const resp = await fetch(src, { credentials: 'omit', cache: 'force-cache' });
  if (!resp.ok) throw new Error('fetch ' + resp.status);
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);

  try {
    const im = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    return { im: downscaleForDetection(im), url };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

function makeCanvas(w, h) {
  // face-api's toNetInput only accepts HTMLCanvasElement (not OffscreenCanvas),
  // and the MV2 background page has a real document, so use a DOM canvas.
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

function downscaleForDetection(im) {
  const width = im.naturalWidth || im.width;
  const height = im.naturalHeight || im.height;
  const maxSide = Math.max(width, height);
  if (!width || !height || maxSide <= DETECTION_MAX_SIDE) return im;

  const scale = DETECTION_MAX_SIDE / maxSide;
  const canvas = makeCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
  canvas.getContext('2d').drawImage(im, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const detectorOpts = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.35 });

async function detectFaces(im, settings) {
  const result = {
    faceAnalyzed: false,
    genderAnalyzed: false,
    faceCount: 0,
    femaleMax: 0,
    maleMax: 0
  };

  if (!faceReady || !settings.blurFaces) return result;

  if (isGenderRestricted(settings)) {
    const det = await faceapi.detectAllFaces(im, detectorOpts()).withAgeAndGender();
    result.faceAnalyzed = true;
    result.genderAnalyzed = true;
    result.faceCount = det.length;
    for (const d of det) {
      if (d.gender === 'female') result.femaleMax = Math.max(result.femaleMax, d.genderProbability || 0);
      if (d.gender === 'male') result.maleMax = Math.max(result.maleMax, d.genderProbability || 0);
    }
    return result;
  }

  const det = await faceapi.detectAllFaces(im, detectorOpts());
  result.faceAnalyzed = true;
  result.faceCount = det.length;
  return result;
}

async function detectBodies(im, settings) {
  const result = {
    bodyAnalyzed: false,
    bodyMax: 0,
    bodyMinScore: 0.3,
    bodyGenderModeAnalyzed: isGenderRestricted(settings) ? settings.genderMode : 'both',
    bodyGenderCandidates: []
  };

  if (!bodyModel || !settings.blurBodies) return result;

  const minScore = Math.min(settings.bodyThreshold || 0.3, 0.3);
  const preds = await bodyModel.detect(im, 5, minScore);
  result.bodyAnalyzed = true;
  result.bodyMinScore = minScore;

  const persons = [];
  for (const p of preds) {
    if (p.class !== 'person') continue;
    result.bodyMax = Math.max(result.bodyMax, p.score || 0);
    if ((p.score || 0) >= minScore) persons.push(p);
  }

  if (isGenderRestricted(settings) && faceReady && persons.length) {
    const topPersons = persons
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, BODY_GENDER_MAX_PERSONS);

    for (const person of topPersons) {
      const gender = await detectBodyGender(im, person.bbox);
      result.bodyGenderCandidates.push({
        score: person.score || 0,
        gender: gender.gender,
        genderProbability: gender.genderProbability
      });
    }
  }

  return result;
}

async function detectBodyGender(im, bbox) {
  const crop = cropImage(im, bbox, 0.12);
  if (!crop) return { gender: null, genderProbability: 0 };

  const det = await faceapi.detectAllFaces(crop, detectorOpts()).withAgeAndGender();
  let best = { gender: null, genderProbability: 0 };
  for (const d of det) {
    if ((d.genderProbability || 0) > best.genderProbability) {
      best = { gender: d.gender, genderProbability: d.genderProbability || 0 };
    }
  }
  return best;
}

function cropImage(im, bbox, paddingRatio = 0) {
  const width = im.naturalWidth || im.width;
  const height = im.naturalHeight || im.height;
  if (!width || !height || !bbox) return null;

  const pad = Math.max(bbox[2], bbox[3]) * paddingRatio;
  const sx = Math.max(0, Math.floor(bbox[0] - pad));
  const sy = Math.max(0, Math.floor(bbox[1] - pad));
  const sw = Math.min(width - sx, Math.ceil(bbox[2] + pad * 2));
  const sh = Math.min(height - sy, Math.ceil(bbox[3] + pad * 2));
  if (sw <= 1 || sh <= 1) return null;

  const canvas = makeCanvas(sw, sh);
  canvas.getContext('2d').drawImage(im, sx, sy, sw, sh, 0, 0, sw, sh);
  return downscaleForDetection(canvas);
}

async function analyzeImage(im, settings) {
  const face = await detectFaces(im, settings);
  const faceHit = settings.blurFaces && (
    settings.genderMode === 'female'
      ? face.genderAnalyzed && face.femaleMax >= settings.faceThreshold
      : settings.genderMode === 'male'
        ? face.genderAnalyzed && face.maleMax >= settings.faceThreshold
        : face.faceAnalyzed && face.faceCount > 0
  );

  if (faceHit) {
    return { ...face, bodyAnalyzed: false, bodyMax: 0, bodyMinScore: 0.3, bodyGenderCandidates: [] };
  }

  const body = await detectBodies(im, settings);
  return { ...face, ...body };
}

// === Background orchestration ===

chrome.runtime.onInstalled.addListener(() => {
  setActionState(null, 'inactive');
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  requestTabStatus(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStatuses.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    tabStatuses.delete(tabId);
    setActionState(tabId, 'inactive');
  }
  if (changeInfo.status === 'complete') requestTabStatus(tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === 'focustube:page-status') {
    const tabId = sender.tab?.id;
    if (typeof tabId === 'number') {
      tabStatuses.set(tabId, msg.status || {});
      setActionState(tabId, stateFromStatus(msg.status || {}));
    }
    sendResponse({ ok: true, status: sharedModelStatus });
    return false;
  }

  if (msg.type === 'focustube:get-model-status') {
    sendResponse({ ok: true, status: sharedModelStatus });
    return false;
  }

  if (msg.type === 'focustube:detect-image') {
    detectImage(msg.url, msg.settings || {})
      .then((result) => sendResponse({ ok: true, result, status: sharedModelStatus }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e), status: sharedModelStatus }));
    return true;
  }

  return false;
});

function updateSharedModelStatus(status = {}) {
  sharedModelStatus = { ...sharedModelStatus, ...status };
  broadcastModelStatus();
  for (const [tabId, statusForTab] of tabStatuses) {
    setActionState(tabId, stateFromStatus(statusForTab));
  }
}

function broadcastModelStatus() {
  chrome.tabs.query({ url: 'https://www.youtube.com/*' }, (tabs) => {
    for (const tab of tabs) {
      if (typeof tab.id !== 'number') continue;
      chrome.tabs.sendMessage(tab.id, { type: 'focustube:model-status', status: sharedModelStatus }, () => {
        void chrome.runtime.lastError;
      });
    }
  });
}

function stateFromStatus(status = {}) {
  if (!status.enabled || (!status.faceWanted && !status.bodyWanted)) return 'off';

  const faceRequired = status.faceWanted || status.bodyGenderWanted;
  const faceUsable = !faceRequired || sharedModelStatus.faceReady;
  const bodyUsable = !status.bodyWanted || sharedModelStatus.bodyReady;
  if (faceUsable && bodyUsable) return 'active';

  return 'notReady';
}

function requestTabStatus(tabId) {
  try {
    chrome.tabs.sendMessage(tabId, { type: 'focustube:status' }, (status) => {
      if (chrome.runtime.lastError || !status) {
        tabStatuses.delete(tabId);
        setActionState(tabId, 'inactive');
        return;
      }
      tabStatuses.set(tabId, status);
      setActionState(tabId, stateFromStatus(status));
    });
  } catch {
    tabStatuses.delete(tabId);
    setActionState(tabId, 'inactive');
  }
}

function setActionState(tabId, stateName) {
  const state = ACTION_STATES[stateName] || ACTION_STATES.inactive;
  const details = typeof tabId === 'number' ? { tabId } : {};

  try {
    action.setBadgeText({ ...details, text: state.badge });
    action.setBadgeBackgroundColor({ ...details, color: state.badgeColor });
    action.setTitle({ ...details, title: state.title });

    const imageData = getIconSet(stateName, state.iconColor);
    if (imageData) action.setIcon({ ...details, imageData });
  } catch {
    // Best-effort UI state only.
  }
}

function getIconSet(stateName, color) {
  if (iconCache.has(stateName)) return iconCache.get(stateName);

  const imageData = {
    16: drawIcon(16, color, stateName),
    32: drawIcon(32, color, stateName),
    48: drawIcon(48, color, stateName),
    128: drawIcon(128, color, stateName)
  };
  iconCache.set(stateName, imageData);
  return imageData;
}

function drawIcon(size, color, stateName) {
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const center = size / 2;
  const radius = size * 0.42;

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#111827';
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, size * 0.09);
  ctx.beginPath();
  if (stateName === 'notReady') {
    ctx.arc(center, center, radius - ctx.lineWidth / 2, -Math.PI / 2, Math.PI * 1.35);
  } else {
    ctx.arc(center, center, radius - ctx.lineWidth / 2, 0, Math.PI * 2);
  }
  ctx.stroke();

  if (stateName === 'off' || stateName === 'inactive') {
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = Math.max(2, size * 0.08);
    ctx.beginPath();
    ctx.moveTo(size * 0.31, size * 0.69);
    ctx.lineTo(size * 0.69, size * 0.31);
    ctx.stroke();
  } else {
    ctx.fillStyle = '#f8fafc';
    ctx.beginPath();
    ctx.moveTo(size * 0.42, size * 0.33);
    ctx.lineTo(size * 0.42, size * 0.67);
    ctx.lineTo(size * 0.68, size * 0.5);
    ctx.closePath();
    ctx.fill();
  }

  return ctx.getImageData(0, 0, size, size);
}
