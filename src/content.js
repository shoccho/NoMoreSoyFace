(() => {
  const TAG = '[YT-FaceBlur]';
  const DEBUG = false;
  const log = (...a) => DEBUG && console.log(TAG, ...a);

  const MAX_CONCURRENT = 2;
  const RESULT_CACHE_LIMIT = 500;
  const FAILURE_CACHE_LIMIT = 150;
  const FAILURE_BACKOFF_MS = 60000;

  const PROCESSED = new WeakMap();
  const OBSERVED = new WeakMap();
  const RESULT_CACHE = new Map();
  const FAILURE_CACHE = new Map();
  const QUEUED_KEYS = new Set();
  const INFLIGHT_KEYS = new Set();
  const WAITING_BY_KEY = new Map();
  const BLURRED_KEYS = new Set();
  const queue = [];
  const genderModes = ['male', 'both', 'female'];

  let settings = {
    enabled: true,
    blurFaces: true,
    genderMode: 'both',
    faceThreshold: 0.55,
    blurBodies: true,
    bodyThreshold: 0.55,
    blurPx: 24
  };
  const storageKeys = [
    'enabled',
    'blurFaces',
    'genderMode',
    'femaleOnly',
    'faceThreshold',
    'blurBodies',
    'bodyThreshold',
    'blurPx'
  ];

  let modelStatus = {
    faceReady: false,
    faceLoadComplete: false,
    faceError: '',
    bodyReady: false,
    bodyLoadComplete: false,
    bodyError: ''
  };

  let blurredCount = 0;
  let activeJobs = 0;
  let scanScheduled = false;
  let statusTimer = null;

  chrome.storage.sync.get(storageKeys, (s) => {
    settings = normalizeSettings(s);
    publishStatus(0);
    if (wantsDetection()) refreshModelStatus();
    scheduleScan();
  });

  chrome.storage.onChanged.addListener((changes) => {
    for (const k in changes) settings[k] = changes[k].newValue;
    settings = normalizeSettings(settings);

    if (changes.blurPx) {
      document.querySelectorAll('img[data-ytfb-blurred]').forEach((img) => {
        img.style.filter = `blur(${settings.blurPx}px)`;
      });
    }

    const reapplyKeys = [
      'enabled',
      'blurFaces',
      'blurBodies',
      'femaleOnly',
      'genderMode',
      'faceThreshold',
      'bodyThreshold'
    ];

    if (reapplyKeys.some((k) => changes[k])) {
      RESULT_CACHE.clear();
      document.querySelectorAll('img[data-ytfb-blurred]').forEach(clearBlur);
      document.querySelectorAll('img').forEach((img) => PROCESSED.delete(img));
      scheduleScan();
    }

    publishStatus();
    if (wantsDetection()) refreshModelStatus();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'focustube:status') {
      sendResponse(getStatus());
      return true;
    }

    if (msg && msg.type === 'focustube:model-status') {
      updateModelStatus(msg.status);
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  function getStatus() {
    return {
      enabled: settings.enabled,
      genderMode: settings.genderMode,
      faceReady: modelStatus.faceReady,
      faceLoadComplete: modelStatus.faceLoadComplete,
      faceError: modelStatus.faceError || '',
      bodyReady: modelStatus.bodyReady,
      bodyLoadComplete: modelStatus.bodyLoadComplete,
      bodyError: modelStatus.bodyError || '',
      faceWanted: settings.blurFaces,
      bodyWanted: settings.blurBodies,
      bodyGenderWanted: settings.blurBodies && isGenderRestricted(),
      blurredCount,
      cacheSize: RESULT_CACHE.size,
      queued: queue.length + INFLIGHT_KEYS.size
    };
  }

  function publishStatus(delay = 120) {
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusTimer = null;
      try {
        chrome.runtime.sendMessage(
          { type: 'focustube:page-status', status: getStatus() },
          () => void chrome.runtime.lastError
        );
      } catch {}
    }, delay);
  }

  function refreshModelStatus() {
    try {
      chrome.runtime.sendMessage({ type: 'focustube:get-model-status' }, (resp) => {
        if (chrome.runtime.lastError || !resp?.status) return;
        updateModelStatus(resp.status);
      });
    } catch {}
  }

  function wantsDetection() {
    return settings.enabled && (settings.blurFaces || settings.blurBodies);
  }

  function normalizeSettings(raw = {}) {
    const next = { ...settings, ...raw };
    if (!genderModes.includes(next.genderMode)) {
      next.genderMode = typeof raw.femaleOnly === 'boolean'
        ? (raw.femaleOnly ? 'female' : 'both')
        : 'both';
    }
    delete next.femaleOnly;
    return next;
  }

  function isGenderRestricted() {
    return settings.genderMode === 'male' || settings.genderMode === 'female';
  }

  function updateModelStatus(status = {}) {
    modelStatus = { ...modelStatus, ...status };
    publishStatus();
    drainQueue();
  }

  function getImageSrc(img) {
    return img.currentSrc || img.src || '';
  }

  function getCacheKeyFromSrc(src) {
    try {
      const u = new URL(src, location.href);
      if (!/^https?:$/.test(u.protocol)) return null;
      if (!/i\d?\.ytimg\.com$/.test(u.hostname)) return null;

      const staticMatch = u.pathname.match(/\/(?:vi|vi_webp)\/([^/?/]+)\/([^/?#]+)/);
      if (staticMatch) {
        const name = staticMatch[2].toLowerCase();
        if (/^(?:default|mqdefault|hqdefault|sddefault|maxresdefault|hq720)\.(?:jpg|webp)$/.test(name)) {
          return `yt:${staticMatch[1]}:static`;
        }
        return `yt:${staticMatch[1]}:${name}`;
      }

      const animatedMatch = u.pathname.match(/\/an_webp\/([^/?/]+)\//);
      if (animatedMatch) return `yt:${animatedMatch[1]}:animated`;

      const storyboardMatch = u.pathname.match(/\/sb\/([^/?/]+)\//);
      if (storyboardMatch) {
        u.search = '';
        u.hash = '';
        return `yt:${storyboardMatch[1]}:${u.pathname}`;
      }

      u.search = '';
      u.hash = '';
      return u.href;
    } catch {
      return null;
    }
  }

  function getCacheKey(img) {
    return getCacheKeyFromSrc(getImageSrc(img));
  }

  function isCandidate(img) {
    const src = getImageSrc(img);
    if (!src || !/^https?:/.test(src)) return false;
    if (!/i\d?\.ytimg\.com/.test(src)) return false;
    if (img.naturalWidth && img.naturalWidth < 80) return false;
    return true;
  }

  function markBlur(img, reason) {
    img.style.filter = `blur(${settings.blurPx}px)`;
    img.style.transform = 'scale(1.06)';
    img.dataset.ytfbBlurred = reason || '1';
  }

  function clearBlur(img) {
    if (img.dataset.ytfbBlurred) {
      img.style.filter = '';
      img.style.transform = '';
      delete img.dataset.ytfbBlurred;
    }
  }

  function resultCoversSettings(result) {
    if (!result) return false;
    if (settings.blurFaces && modelStatus.faceReady) {
      if (!result.faceAnalyzed) return false;
      if (settings.genderMode === 'male' && (!result.genderAnalyzed || typeof result.maleMax !== 'number')) return false;
      if (settings.genderMode === 'female' && (!result.genderAnalyzed || typeof result.femaleMax !== 'number')) return false;
      if (faceReasonFromResult(result)) return true;
    }
    if (settings.blurBodies && modelStatus.bodyReady) {
      if (!result.bodyAnalyzed) return false;
      if ((result.bodyMinScore ?? 0.5) > settings.bodyThreshold) return false;
      if (isGenderRestricted() && result.bodyGenderModeAnalyzed !== settings.genderMode) return false;
    }
    return true;
  }

  function faceReasonFromResult(result) {
    if (!settings.enabled || !settings.blurFaces || !result.faceAnalyzed) return null;
    if (settings.genderMode === 'female') {
      return result.genderAnalyzed && result.femaleMax >= settings.faceThreshold
        ? `f:${result.femaleMax.toFixed(2)}`
        : null;
    }
    if (settings.genderMode === 'male') {
      return result.genderAnalyzed && result.maleMax >= settings.faceThreshold
        ? `m:${result.maleMax.toFixed(2)}`
        : null;
    }
    return result.faceCount > 0 ? 'face' : null;
  }

  function bodyReasonFromResult(result) {
    if (!settings.enabled || !settings.blurBodies || !result.bodyAnalyzed) return null;
    if (settings.genderMode === 'female') {
      const female = findBodyGenderCandidate(result, 'female');
      return female ? `body:f:${female.genderProbability.toFixed(2)}` : null;
    }
    if (settings.genderMode === 'male') {
      const male = findBodyGenderCandidate(result, 'male');
      return male ? `body:m:${male.genderProbability.toFixed(2)}` : null;
    }

    if (result.bodyMax < settings.bodyThreshold) return null;
    const female = findBodyGenderCandidate(result, 'female');
    if (female) return `body:f:${female.genderProbability.toFixed(2)}`;
    const male = findBodyGenderCandidate(result, 'male');
    if (male) return `body:m:${male.genderProbability.toFixed(2)}`;
    return `body:${result.bodyMax.toFixed(2)}`;
  }

  function findBodyGenderCandidate(result, gender) {
    const candidates = result.bodyGenderCandidates || [];
    let best = null;
    for (const candidate of candidates) {
      if (candidate.score < settings.bodyThreshold) continue;
      if (candidate.gender !== gender) continue;
      if (candidate.genderProbability < settings.faceThreshold) continue;
      if (!best || candidate.genderProbability > best.genderProbability) best = candidate;
    }
    return best;
  }

  function applyResult(img, result, key) {
    if (!img.isConnected || getCacheKey(img) !== key) return;

    const reason = faceReasonFromResult(result) || bodyReasonFromResult(result);

    if (reason) {
      if (!BLURRED_KEYS.has(key)) {
        BLURRED_KEYS.add(key);
        blurredCount++;
      }
      markBlur(img, reason);
    } else {
      clearBlur(img);
    }
    PROCESSED.set(img, key);
  }

  function getCached(key) {
    const result = RESULT_CACHE.get(key);
    if (!result) return null;
    RESULT_CACHE.delete(key);
    RESULT_CACHE.set(key, result);
    return result;
  }

  function setCached(key, result) {
    RESULT_CACHE.delete(key);
    RESULT_CACHE.set(key, result);
    while (RESULT_CACHE.size > RESULT_CACHE_LIMIT) {
      RESULT_CACHE.delete(RESULT_CACHE.keys().next().value);
    }
  }

  function inFailureBackoff(key) {
    const until = FAILURE_CACHE.get(key);
    if (!until) return false;
    if (until <= Date.now()) {
      FAILURE_CACHE.delete(key);
      return false;
    }
    return true;
  }

  function markFailure(key) {
    FAILURE_CACHE.delete(key);
    FAILURE_CACHE.set(key, Date.now() + FAILURE_BACKOFF_MS);
    while (FAILURE_CACHE.size > FAILURE_CACHE_LIMIT) {
      FAILURE_CACHE.delete(FAILURE_CACHE.keys().next().value);
    }
  }

  function detectorsSettled() {
    const faceSettled = !settings.blurFaces || modelStatus.faceReady || modelStatus.faceLoadComplete;
    const bodySettled = !settings.blurBodies || modelStatus.bodyReady || modelStatus.bodyLoadComplete;
    const bodyGenderSettled = !(settings.blurBodies && isGenderRestricted()) || modelStatus.faceReady || modelStatus.faceLoadComplete;
    return faceSettled && bodySettled && bodyGenderSettled;
  }

  function hasUsableDetector() {
    const faceUsable = settings.blurFaces && modelStatus.faceReady;
    const bodyUsable = settings.blurBodies && modelStatus.bodyReady && (!isGenderRestricted() || modelStatus.faceReady);
    return faceUsable || bodyUsable;
  }

  function addWaiter(key, img) {
    let waiters = WAITING_BY_KEY.get(key);
    if (!waiters) {
      waiters = new Set();
      WAITING_BY_KEY.set(key, waiters);
    }
    waiters.add(img);
  }

  function applyToWaiters(key, result) {
    const waiters = WAITING_BY_KEY.get(key);
    WAITING_BY_KEY.delete(key);
    if (!waiters) return;

    for (const img of waiters) {
      if (!img.isConnected || getCacheKey(img) !== key) continue;
      if (resultCoversSettings(result)) applyResult(img, result, key);
      else {
        PROCESSED.delete(img);
        scheduleCandidate(img, true);
      }
    }
  }

  function enqueue(img, highPriority = false) {
    if (!settings.enabled || !isCandidate(img)) return;

    const src = getImageSrc(img);
    const key = getCacheKeyFromSrc(src);
    if (!key || inFailureBackoff(key)) return;

    const processedKey = PROCESSED.get(img);
    if (processedKey === key) return;

    const cached = getCached(key);
    if (cached && resultCoversSettings(cached)) {
      applyResult(img, cached, key);
      return;
    }

    addWaiter(key, img);

    if (!QUEUED_KEYS.has(key) && !INFLIGHT_KEYS.has(key)) {
      const item = { key, src };
      if (highPriority) queue.unshift(item);
      else queue.push(item);
      QUEUED_KEYS.add(key);
    }

    drainQueue();
    if (!detectorsSettled()) refreshModelStatus();
  }

  async function runQueueItem(item) {
    try {
      const resp = await sendRuntimeMessage({
        type: 'focustube:detect-image',
        url: item.src,
        settings: {
          blurFaces: settings.blurFaces,
          genderMode: settings.genderMode,
          faceThreshold: settings.faceThreshold,
          blurBodies: settings.blurBodies,
          bodyThreshold: settings.bodyThreshold
        }
      });

      if (resp?.status) updateModelStatus(resp.status);
      if (!resp?.ok || !resp.result) {
        markFailure(item.key);
        WAITING_BY_KEY.delete(item.key);
        log('fail', item.key, resp?.error || 'detect failed');
        return;
      }

      const result = resp.result;
      const didAnalyze = result.faceAnalyzed || result.bodyAnalyzed;
      if (!didAnalyze) return;
      setCached(item.key, result);
      applyToWaiters(item.key, result);
    } catch (e) {
      markFailure(item.key);
      WAITING_BY_KEY.delete(item.key);
      log('fail', item.key, e.message);
    }
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) reject(new Error(lastError.message));
          else resolve(resp);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function drainQueue() {
    if (!settings.enabled || !detectorsSettled() || !hasUsableDetector()) return;

    while (activeJobs < MAX_CONCURRENT && queue.length) {
      const item = queue.shift();
      QUEUED_KEYS.delete(item.key);

      const cached = getCached(item.key);
      if (cached && resultCoversSettings(cached)) {
        applyToWaiters(item.key, cached);
        continue;
      }

      if (INFLIGHT_KEYS.has(item.key) || inFailureBackoff(item.key)) continue;

      INFLIGHT_KEYS.add(item.key);
      activeJobs++;
      runQueueItem(item).finally(() => {
        activeJobs--;
        INFLIGHT_KEYS.delete(item.key);
        drainQueue();
      });
    }
  }

  function scheduleCandidate(img, highPriority = false) {
    if (!isCandidate(img)) return;

    const key = getCacheKey(img);
    if (!key) return;

    const cached = getCached(key);
    if (cached && resultCoversSettings(cached)) {
      applyResult(img, cached, key);
      return;
    }

    if (io && !highPriority) {
      if (OBSERVED.get(img) !== key) {
        try {
          io.unobserve(img);
          io.observe(img);
          OBSERVED.set(img, key);
        } catch {
          enqueue(img);
        }
      }
      return;
    }

    enqueue(img, highPriority);
  }

  function scheduleWhenLoaded(img, highPriority = false) {
    if (img.complete && img.naturalWidth) scheduleCandidate(img, highPriority);
    else img.addEventListener('load', () => scheduleCandidate(img, highPriority), { once: true });
  }

  function scanAll(root = document) {
    const imgs = Array.from((root.querySelectorAll ? root.querySelectorAll('img') : [])).filter(isCandidate);
    imgs.forEach((img) => scheduleWhenLoaded(img));
    drainQueue();
  }

  function scheduleScan(delay = 100) {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      scanAll();
    }, delay);
  }

  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const img = entry.target;
          if (!entry.isIntersecting) continue;
          OBSERVED.delete(img);
          io.unobserve(img);
          scheduleCandidate(img, true);
        }
      }, { rootMargin: '900px 0px' })
    : null;

  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'IMG') {
          scheduleWhenLoaded(n);
        } else if (n.querySelectorAll) {
          scanAll(n);
        }
      }
      if (m.type === 'attributes' && m.target.tagName === 'IMG') {
        const img = m.target;
        PROCESSED.delete(img);
        OBSERVED.delete(img);
        clearBlur(img);
        scheduleWhenLoaded(img, true);
      }
    }
  });

  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset']
  });

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      scheduleScan();
    }
  }, 1500);

  setInterval(() => {
    refreshModelStatus();
    scheduleScan(500);
  }, 15000);
})();
