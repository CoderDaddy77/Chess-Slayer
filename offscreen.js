// offscreen.js — Runs inside the offscreen document (extension context)
// Creates the Stockfish Web Worker and relays UCI messages.
'use strict';

let engine = null;

// Default engine: lite. Switched via 'SWITCH_ENGINE' message.
let engineFile = 'stockfish-18-lite-single.js';

function createEngine(file) {
  if (engine) {
    try { engine.terminate(); } catch (e) {}
    engine = null;
  }

  engineFile = file || engineFile;

  try {
    engine = new Worker(engineFile);

    engine.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : String(e.data);
      safeSend({ source: 'offscreen', type: 'UCI_OUTPUT', line: line });
    };

    engine.onerror = (e) => {
      console.error('[ChessSlayer Offscreen] Worker error:', e);
      safeSend({
        source: 'offscreen',
        type: 'ENGINE_ERROR',
        message: e.message || 'Stockfish worker crashed',
      });
    };

    console.log('[ChessSlayer Offscreen] Engine started:', engineFile);
  } catch (err) {
    console.error('[ChessSlayer Offscreen] Failed to create worker:', err);
    safeSend({
      source: 'offscreen',
      type: 'ENGINE_ERROR',
      message: 'Failed to create worker: ' + err.message,
    });
  }
}

function safeSend(msg) {
  try {
    chrome.runtime.sendMessage(msg, () => {
      if (chrome.runtime.lastError) { /* ignore */ }
    });
  } catch (e) { /* context lost */ }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  switch (msg.type) {
    case 'UCI_COMMAND':
      if (engine) {
        try {
          engine.postMessage(msg.command);
        } catch (e) {
          safeSend({
            source: 'offscreen',
            type: 'ENGINE_ERROR',
            message: 'Worker died: ' + e.message,
          });
        }
      }
      break;

    case 'INIT':
      if (!engine) createEngine();
      sendResponse({ ok: true });
      return true;

    case 'SWITCH_ENGINE':
      // Switch between 'lite' and 'full'
      const file = msg.engine === 'full' ? 'stockfish.js' : 'stockfish-18-lite-single.js';
      createEngine(file);
      sendResponse({ ok: true, engine: file });
      return true;

    case 'RESTART':
      console.log('[ChessSlayer Offscreen] Restarting engine...');
      createEngine();
      sendResponse({ ok: true });
      return true;

    case 'QUIT':
      if (engine) {
        try { engine.postMessage('quit'); } catch (e) {}
        try { engine.terminate(); } catch (e) {}
        engine = null;
      }
      break;
  }
});

createEngine();
