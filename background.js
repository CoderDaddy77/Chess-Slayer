// background.js — Service Worker (MV3)
// Manages the offscreen document lifecycle and relays messages between
// the content script (on chess.com) and the Stockfish offscreen worker.
'use strict';

// ─── Offscreen Document Management ──────────────────────────────────────────
let offscreenCreating = null;

async function ensureOffscreen() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen.html')],
  });

  if (existingContexts.length > 0) return;

  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }

  offscreenCreating = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Run Stockfish chess engine in a Web Worker',
  });

  await offscreenCreating;
  offscreenCreating = null;
  console.log('[BetterMint BG] Offscreen document created');
}

async function destroyOffscreen() {
  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen.html')],
    });
    if (existingContexts.length > 0) {
      await chrome.offscreen.closeDocument();
      console.log('[BetterMint BG] Offscreen document destroyed');
    }
  } catch (e) {
    console.warn('[BetterMint BG] Error destroying offscreen:', e);
  }
}

// ─── Message Routing ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // === From content script → forward to offscreen ===
  if (msg.source === 'content') {
    if (msg.type === 'INIT_ENGINE') {
      ensureOffscreen().then(() => {
        chrome.runtime.sendMessage({ target: 'offscreen', type: 'INIT' });
        sendResponse({ ok: true });
      }).catch((err) => {
        sendResponse({ ok: false, error: err.message });
      });
      return true;
    }

    if (msg.type === 'RESTART_ENGINE') {
      // Full restart: destroy offscreen → recreate → init fresh worker
      destroyOffscreen().then(() => {
        return ensureOffscreen();
      }).then(() => {
        chrome.runtime.sendMessage({ target: 'offscreen', type: 'INIT' });
        sendResponse({ ok: true });
      }).catch((err) => {
        sendResponse({ ok: false, error: err.message });
      });
      return true;
    }

    if (msg.type === 'SWITCH_ENGINE') {
      ensureOffscreen().then(() => {
        chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'SWITCH_ENGINE',
          engine: msg.engine,  // 'lite' or 'full'
        }, (resp) => {
          // After switch, send UCI init
          chrome.runtime.sendMessage({ target: 'offscreen', type: 'INIT' });
          sendResponse({ ok: true });
        });
      }).catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    if (msg.type === 'UCI_COMMAND') {
      ensureOffscreen().then(() => {
        chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'UCI_COMMAND',
          command: msg.command,
        });
      });
      return;
    }
  }

  // === From offscreen → forward to content script (Chess.com + Lichess) ===
  if (msg.source === 'offscreen') {
    chrome.tabs.query({ url: ['*://www.chess.com/*', '*://lichess.org/*'] }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, {
          source: 'background',
          type: msg.type,
          line: msg.line,
          message: msg.message,
        }).catch(() => {});
      }
    });
    return;
  }

  // === From popup ===
  if (msg.type === 'GET_STATUS') {
    sendResponse({ running: true });
    return;
  }
});

// Create offscreen document on install/startup
chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreen();
});
chrome.runtime.onStartup.addListener(() => {
  ensureOffscreen();
});
