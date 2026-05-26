const OFFSCREEN_URL = 'offscreen.html';

const ACTION_STATES = {
  inactive: {
    badge: '',
    badgeColor: '#64748b',
    iconColor: '#64748b',
    title: 'FocusTube: inactive'
  },
  notReady: {
    badge: '...',
    badgeColor: '#f59e0b',
    iconColor: '#f59e0b',
    title: 'FocusTube: not ready'
  },
  active: {
    badge: 'ON',
    badgeColor: '#22c55e',
    iconColor: '#22c55e',
    title: 'FocusTube: active'
  },
  off: {
    badge: 'OFF',
    badgeColor: '#6b7280',
    iconColor: '#6b7280',
    title: 'FocusTube: off'
  }
};

const iconCache = new Map();
const tabStatuses = new Map();

let creatingOffscreen = null;
let sharedModelStatus = {
  faceReady: false,
  faceLoadComplete: false,
  faceError: '',
  bodyReady: false,
  bodyLoadComplete: false,
  bodyError: ''
};

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
  if (!msg || msg.target === 'offscreen') return false;

  if (msg.target === 'background' && msg.type === 'focustube:model-status') {
    updateSharedModelStatus(msg.status);
    sendResponse({ ok: true });
    return false;
  }

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
    ensureOffscreenDocument()
      .then(() => sendToOffscreen({ type: 'focustube:get-model-status' }))
      .then((resp) => {
        if (resp?.status) updateSharedModelStatus(resp.status);
        sendResponse({ ok: true, status: sharedModelStatus });
      })
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e), status: sharedModelStatus }));
    return true;
  }

  if (msg.type === 'focustube:detect-image') {
    ensureOffscreenDocument()
      .then(() => sendToOffscreen({
        type: 'focustube:detect-image',
        url: msg.url,
        settings: msg.settings || {}
      }))
      .then((resp) => {
        if (resp?.status) updateSharedModelStatus(resp.status);
        sendResponse(resp);
      })
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e), status: sharedModelStatus }));
    return true;
  }

  return false;
});

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_URL);

  if ('getContexts' in chrome.runtime) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (contexts.length) return;
  } else {
    const clients = await self.clients.matchAll();
    if (clients.some((client) => client.url === offscreenUrl)) return;
  }

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Run shared on-device thumbnail detection without loading models in every tab.'
    }).finally(() => {
      creatingOffscreen = null;
    });
  }

  await creatingOffscreen;
}

function sendToOffscreen(message) {
  return chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
}

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
    chrome.action.setBadgeText({ ...details, text: state.badge });
    chrome.action.setBadgeBackgroundColor({ ...details, color: state.badgeColor });
    chrome.action.setTitle({ ...details, title: state.title });

    const imageData = getIconSet(stateName, state.iconColor);
    if (imageData) chrome.action.setIcon({ ...details, imageData });
  } catch {
    // Best-effort UI state only.
  }
}

function getIconSet(stateName, color) {
  if (typeof OffscreenCanvas === 'undefined') return null;
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
  const canvas = new OffscreenCanvas(size, size);
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
