// BetterMint — Popup Script
// Syncs UI with chrome.storage.local and content script settings

const defaults = {
  enabled:     true,
  depth:       18,
  multiPV:     3,
  showEvalBar: true,
  showArrows:  true,
  showAccuracy:true,
  showHUD:     true,
  arrowColor1: '#00ff88',
  arrowColor2: '#00aaff',
  arrowColor3: '#ffaa00',
};

function $(id) { return document.getElementById(id); }

function applyToUI(s) {
  $('masterToggle').checked  = s.enabled;
  $('depthVal').textContent  = s.depth;
  $('pvVal').textContent     = s.multiPV;
  $('evalBarToggle').checked = s.showEvalBar;
  $('arrowsToggle').checked  = s.showArrows;
  $('accuracyToggle').checked= s.showAccuracy;
  $('hudToggle').checked     = s.showHUD !== false;
  $('color1').value          = s.arrowColor1;
  $('color2').value          = s.arrowColor2;
  $('color3').value          = s.arrowColor3;
}

function save(patch) {
  chrome.storage.local.set(patch);
}

// Load and populate UI
chrome.storage.local.get(null, (stored) => {
  const s = Object.assign({}, defaults, stored);
  applyToUI(s);
  updateEngineStatus(s.enabled);
});

// Listen for live storage changes (e.g. from content script)
chrome.storage.onChanged.addListener((changes) => {
  const patch = {};
  for (const [k, { newValue }] of Object.entries(changes)) {
    patch[k] = newValue;
  }
  applyToUI(Object.assign({}, defaults, patch));
});

// ── Master Toggle ────────────────────────────────────────────
$('masterToggle').addEventListener('change', (e) => {
  const enabled = e.target.checked;
  save({ enabled });
  updateEngineStatus(enabled);
});

function updateEngineStatus(enabled) {
  const dot = $('engineDot');
  const sub = $('engineSub');
  const badge = $('engineBadge');

  if (!enabled) {
    dot.className = 'engine-indicator';
    sub.textContent = 'Engine disabled';
    badge.textContent = 'OFF';
    return;
  }

  // Ping the active tab for status
  dot.className = 'engine-indicator loading';
  sub.textContent = 'Connecting…';
  badge.textContent = '…';

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_ENGINE_STATUS' }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        dot.className = 'engine-indicator error';
        sub.textContent = 'Open Chess.com first';
        badge.textContent = 'N/A';
        return;
      }
      if (resp.ready) {
        dot.className = 'engine-indicator ready';
        sub.textContent = 'Stockfish ready';
        badge.textContent = `D${resp.depth || '?'}`;
      } else if (resp.loading) {
        dot.className = 'engine-indicator loading';
        sub.textContent = 'Loading engine…';
        badge.textContent = '…';
      } else {
        dot.className = 'engine-indicator error';
        sub.textContent = resp.error || 'Check stockfish.js';
        badge.textContent = 'ERR';
      }
    });
  });
}

// ── Depth Stepper ────────────────────────────────────────────
function getDepth() { return parseInt($('depthVal').textContent) || 18; }
function getPV()    { return parseInt($('pvVal').textContent) || 3; }

$('depthMinus').addEventListener('click', () => {
  const v = Math.max(1, getDepth() - 1);
  $('depthVal').textContent = v;
  save({ depth: v });
});

$('depthPlus').addEventListener('click', () => {
  const v = Math.min(30, getDepth() + 1);
  $('depthVal').textContent = v;
  save({ depth: v });
});

$('pvMinus').addEventListener('click', () => {
  const v = Math.max(1, getPV() - 1);
  $('pvVal').textContent = v;
  save({ multiPV: v });
});

$('pvPlus').addEventListener('click', () => {
  const v = Math.min(5, getPV() + 1);
  $('pvVal').textContent = v;
  save({ multiPV: v });
});

// ── Feature Toggles ──────────────────────────────────────────
$('evalBarToggle').addEventListener('change', (e) => save({ showEvalBar: e.target.checked }));
$('arrowsToggle').addEventListener('change',  (e) => {
  save({ showArrows: e.target.checked });
  $('arrowColorSection').style.opacity = e.target.checked ? '1' : '0.4';
  $('arrowColorSection').style.pointerEvents = e.target.checked ? '' : 'none';
});
$('accuracyToggle').addEventListener('change', (e) => save({ showAccuracy: e.target.checked }));
$('hudToggle').addEventListener('change', (e) => save({ showHUD: e.target.checked }));

// ── Color Pickers ────────────────────────────────────────────
$('color1').addEventListener('input', (e) => save({ arrowColor1: e.target.value }));
$('color2').addEventListener('input', (e) => save({ arrowColor2: e.target.value }));
$('color3').addEventListener('input', (e) => save({ arrowColor3: e.target.value }));
