/**
 * ChessSlayer ⚔️ — content.js
 * Real-time Stockfish 18 NNUE analysis on Chess.com:
 *  • Extracts FEN from the live board DOM
 *  • Draws best-move arrows on a canvas overlay
 *  • Renders an animated evaluation bar
 *  • Shows move accuracy badges (Brilliant → Blunder)
 *  • Human Mode — delays arrow reveal to look natural
 *  • Lite or Full engine toggle
 *
 * Architecture (MV3 Offscreen):
 *   content.js ──► background.js ──► offscreen.js ──► Worker(stockfish)
 *   content.js ◄── background.js ◄── offscreen.js ◄── Worker UCI output
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Constants & piece maps
// ─────────────────────────────────────────────────────────────────────────────
const PIECE_MAP = {
  wp: 'P', wn: 'N', wb: 'B', wr: 'R', wq: 'Q', wk: 'K',
  bp: 'p', bn: 'n', bb: 'b', br: 'r', bq: 'q', bk: 'k',
};

const FILES = 'abcdefgh';

// ─────────────────────────────────────────────────────────────────────────────
// Site detection
// ─────────────────────────────────────────────────────────────────────────────
const IS_LICHESS = location.hostname.includes('lichess.org');

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
let settings = {
  enabled: true,
  depth: 18,
  multiPV: 3,
  showEvalBar: true,
  showArrows: true,
  showAccuracy: true,
  onlyMyTurn: true,
  humanMode: false,
  engineMode: 'lite',
  showHUD: true,         // Show/hide the floating panel
  arrowColor1: '#00ff88',
  arrowColor2: '#00aaff',
  arrowColor3: '#ffaa00',
  evalBarSide: 'left',
};

let workerReady = false;
let currentFEN = '';
let previousFEN = '';
let previousEval = 0;
let isFlipped = false;

let analysisResults = [];
let pendingFEN = null;
let analysisTimer = null;
let lastAnalyzedFEN = '';

// Accuracy tracking
let evalBeforeMove = null;   // Eval of position BEFORE player's move (player's perspective)
let pendingAccuracy = false; // True when doing a quick eval for accuracy rating
let bestMoveSuggested = '';  // The engine's best move suggestion before player moved
let currentTurn = 'w';

// DOM references
let evalBarEl = null;
let evalFillEl = null;
let evalTextEl = null;
let arrowCanvas = null;
let arrowCtx = null;
let accuracyBadge = null;
let depthIndicator = null;
let controlPanel = null;
let engineStatus = null;

// ─────────────────────────────────────────────────────────────────────────────
// Utility: FEN extraction from Chess.com DOM
// ─────────────────────────────────────────────────────────────────────────────
function getBoardEl() {
  if (IS_LICHESS) return document.querySelector('cg-board');
  return document.querySelector('chess-board') ||
         document.querySelector('.board') ||
         document.querySelector('[class*="board-layout-chessboard"]') ||
         document.querySelector('.chessboard');
}

function extractFEN() {
  if (IS_LICHESS) return extractLichessFEN();

  const board = getBoardEl();
  if (!board) return null;

  isFlipped = board.classList.contains('flipped') ||
              board.getAttribute('flipped') !== null ||
              board.hasAttribute('flipped');

  const position = {};

  const pieces = board.querySelectorAll('.piece');
  if (pieces.length === 0) return null;

  pieces.forEach(piece => {
    const cls = piece.className;
    const pieceMatch = cls.match(/\b([wb][pnbrqk])\b/);
    const sqMatch = cls.match(/\bsquare-(\d)(\d)\b/);
    if (!pieceMatch || !sqMatch) return;

    const file = parseInt(sqMatch[1]) - 1;
    const rank = parseInt(sqMatch[2]) - 1;
    const fenChar = PIECE_MAP[pieceMatch[1]];
    if (fenChar) position[`${file},${rank}`] = fenChar;
  });

  if (Object.keys(position).length === 0) return null;

  let fenPos = '';
  for (let rank = 7; rank >= 0; rank--) {
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const pc = position[`${file},${rank}`];
      if (pc) {
        if (empty > 0) { fenPos += empty; empty = 0; }
        fenPos += pc;
      } else {
        empty++;
      }
    }
    if (empty > 0) fenPos += empty;
    if (rank > 0) fenPos += '/';
  }

  const turn = detectTurn();
  const castling = detectCastling(position);

  return { fen: `${fenPos} ${turn} ${castling} - 0 1`, turn };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lichess DOM helpers
// ─────────────────────────────────────────────────────────────────────────────
const LICHESS_PIECE_MAP = {
  pawn:   { w: 'P', b: 'p' },
  knight: { w: 'N', b: 'n' },
  bishop: { w: 'B', b: 'b' },
  rook:   { w: 'R', b: 'r' },
  queen:  { w: 'Q', b: 'q' },
  king:   { w: 'K', b: 'k' },
};

function detectLichessFlipped() {
  // The cg-wrap element has orientation-white or orientation-black class
  const wrap = document.querySelector('.cg-wrap') ||
               document.querySelector('cg-helper');
  if (wrap) {
    if (wrap.className.includes('orientation-black')) return true;
    if (wrap.className.includes('orientation-white')) return false;
  }
  // Fallback: check if bottom player color element is black
  const bottomColor = document.querySelector('.orientation-black');
  return !!bottomColor;
}

function detectLichessTurn() {
  const playerColor   = isFlipped ? 'b' : 'w';
  const opponentColor = isFlipped ? 'w' : 'b';

  // Method 1: Online live games
  // Lichess adds 'manipulable' class to cg-wrap only when it's your turn to move
  const wrap = document.querySelector('.cg-wrap');
  if (wrap) {
    const isManipulable = wrap.classList.contains('manipulable');
    const hasClock = !!document.querySelector('.rclock, .rclock-bottom, .rclock-top');
    if (hasClock) {
      // In live game: manipulable = my turn, not manipulable = opponent turn
      return isManipulable ? playerColor : opponentColor;
    }
  }

  // Method 2: Clock selectors
  const bottomActive = document.querySelector('.rclock-bottom.rclock-turn');
  const topActive    = document.querySelector('.rclock-top.rclock-turn');
  if (bottomActive) return isFlipped ? 'b' : 'w';
  if (topActive)    return isFlipped ? 'w' : 'b';

  // Method 3: Move count fallback (analysis / vs computer)
  const moves = document.querySelectorAll('l4x move, .moves move, .tview2 move, [data-ply]');
  if (moves.length > 0) return moves.length % 2 === 0 ? 'w' : 'b';

  return 'w';
}


function extractLichessFEN() {
  const board = getBoardEl(); // returns cg-board
  if (!board) return null;

  const boardRect = board.getBoundingClientRect();
  const sqSize = boardRect.width / 8;
  if (sqSize < 1) return null;

  // Set global isFlipped for Lichess
  isFlipped = detectLichessFlipped();

  const position = {};
  // 'piece' is a custom element in Lichess — try multiple selectors
  const pieces = board.querySelectorAll('piece') ||
                 board.querySelectorAll('[class*="piece"]');
  if (!pieces || pieces.length === 0) return null;

  for (const piece of pieces) {
    const classes = [...piece.classList];
    const color = classes.includes('white') ? 'w' : classes.includes('black') ? 'b' : null;
    if (!color) continue;

    const pieceType = ['king','queen','rook','bishop','knight','pawn'].find(t => classes.includes(t));
    if (!pieceType) continue;

    const fenChar = LICHESS_PIECE_MAP[pieceType][color];

    // Parse CSS transform: translate(Xpx, Ypx) or matrix(..., X, Y)
    const transform = piece.style.transform || window.getComputedStyle(piece).transform || '';
    let px = 0, py = 0;
    const tMatch = transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
    const mMatch = transform.match(/matrix\([^,]+,[^,]+,[^,]+,[^,]+,\s*([-\d.]+),\s*([-\d.]+)\)/);

    if (tMatch) {
      px = parseFloat(tMatch[1]);
      py = parseFloat(tMatch[2]);
    } else if (mMatch) {
      px = parseFloat(mMatch[1]);
      py = parseFloat(mMatch[2]);
    } else {
      // Try percentage-based transform fallback
      const pctMatch = transform.match(/translate\(([-\d.]+)%,\s*([-\d.]+)%\)/);
      if (pctMatch) {
        px = (parseFloat(pctMatch[1]) / 100) * boardRect.width;
        py = (parseFloat(pctMatch[2]) / 100) * boardRect.height;
      } else continue;
    }

    let file = Math.round(px / sqSize);
    let rank = 7 - Math.round(py / sqSize);

    if (isFlipped) {
      file = 7 - file;
      rank = 7 - rank;
    }

    if (file < 0 || file > 7 || rank < 0 || rank > 7) continue;
    position[`${file},${rank}`] = fenChar;
  }

  if (Object.keys(position).length === 0) return null;

  let fenPos = '';
  for (let rank = 7; rank >= 0; rank--) {
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const pc = position[`${file},${rank}`];
      if (pc) {
        if (empty > 0) { fenPos += empty; empty = 0; }
        fenPos += pc;
      } else empty++;
    }
    if (empty > 0) fenPos += empty;
    if (rank > 0) fenPos += '/';
  }

  const turn = detectLichessTurn();
  const castling = detectCastling(position);
  return { fen: `${fenPos} ${turn} ${castling} - 0 1`, turn };
}

function detectTurn() {
  const activeClocks = document.querySelectorAll('.clock-component.clock-player-turn, .clock-bottom.clock-player-turn, [class*="clock"][class*="bottom"][class*="turn"]');
  if (activeClocks.length > 0) {
    return isFlipped ? 'b' : 'w';
  }
  const topClocks = document.querySelectorAll('.clock-top.clock-player-turn, [class*="clock"][class*="top"][class*="turn"]');
  if (topClocks.length > 0) {
    return isFlipped ? 'w' : 'b';
  }

  const moves = document.querySelectorAll('.move-node-wrapper, [class*="move-node"], .node, [data-ply]');
  if (moves.length > 0) {
    return moves.length % 2 === 0 ? 'w' : 'b';
  }

  return 'w';
}

function detectCastling(position) {
  let castling = '';
  if (position['4,0'] === 'K') {
    if (position['7,0'] === 'R') castling += 'K';
    if (position['0,0'] === 'R') castling += 'Q';
  }
  if (position['4,7'] === 'k') {
    if (position['7,7'] === 'r') castling += 'k';
    if (position['0,7'] === 'r') castling += 'q';
  }
  return castling || '-';
}

// ─────────────────────────────────────────────────────────────────────────────
// Stockfish via Offscreen Document (MV3)
// Architecture: content.js ↔ background.js ↔ offscreen.js → Worker(stockfish.js)
// ─────────────────────────────────────────────────────────────────────────────
let lastDrawTime = 0;
const DRAW_THROTTLE_MS = 100; // Throttle arrow redraws to max 10/sec
let drawScheduled = false;

function initWorker() {
  try {
    workerReady = false;
    setEngineStatus('loading', '⟳ Starting engine…');

    chrome.runtime.sendMessage(
      { source: 'content', type: 'INIT_ENGINE' },
      (response) => {
        if (chrome.runtime.lastError) {
          setEngineStatus('error', '⚠ ' + chrome.runtime.lastError.message);
          return;
        }
        if (response && response.ok) {
          sendUCI('uci');
          sendUCI('setoption name Hash value 32');  // 32MB hash to prevent OOM
          sendUCI('setoption name MultiPV value ' + settings.multiPV);
          sendUCI('isready');
        } else {
          setEngineStatus('error', '⚠ Engine init failed');
        }
      }
    );
  } catch (e) {
    console.error('[BetterMint] initWorker failed:', e);
    setEngineStatus('error', '⚠ ' + e.message);
  }
}

// Restart the engine (kills offscreen doc + recreates everything fresh)
function restartEngine() {
  workerReady = false;
  lastAnalyzedFEN = '';
  pendingFEN = null;
  analysisResults = [];
  setEngineStatus('loading', '⟳ Restarting engine…');

  chrome.runtime.sendMessage(
    { source: 'content', type: 'RESTART_ENGINE' },
    (response) => {
      if (chrome.runtime.lastError) {
        setEngineStatus('error', '⚠ ' + chrome.runtime.lastError.message);
        return;
      }
      if (response && response.ok) {
        sendUCI('uci');
        sendUCI('setoption name Hash value 32');
        sendUCI('setoption name MultiPV value ' + settings.multiPV);
        sendUCI('isready');
      }
    }
  );
}

function switchEngine(mode) {
  // mode: 'lite' or 'full'
  settings.engineMode = mode;
  saveSettings();

  workerReady = false;
  lastAnalyzedFEN = '';
  pendingFEN = null;
  analysisResults = [];
  evalBeforeMove = null;

  const label = mode === 'full' ? '⚡ Full Power' : '🪶 Lite';
  setEngineStatus('loading', `⟳ Switching to ${label}…`);

  chrome.runtime.sendMessage(
    { source: 'content', type: 'SWITCH_ENGINE', engine: mode },
    (response) => {
      if (chrome.runtime.lastError) {
        setEngineStatus('error', '⚠ ' + chrome.runtime.lastError.message);
        return;
      }
      if (response && response.ok) {
        sendUCI('uci');
        sendUCI('setoption name Hash value ' + (mode === 'full' ? '128' : '32'));
        sendUCI('setoption name MultiPV value ' + settings.multiPV);
        sendUCI('isready');
        setEngineStatus('loading', `⟳ Loading ${label}…`);
      }
    }
  );
}

function sendUCI(command) {
  try {
    chrome.runtime.sendMessage({
      source: 'content',
      type: 'UCI_COMMAND',
      command: command,
    });
  } catch (e) {
    // Extension context lost
  }
}

// Throttled arrow drawing — prevents excessive redraws at high depth
function scheduleDrawArrows() {
  if (drawScheduled) return;
  const now = Date.now();
  const elapsed = now - lastDrawTime;
  if (elapsed >= DRAW_THROTTLE_MS) {
    lastDrawTime = now;
    drawArrows();
  } else {
    drawScheduled = true;
    setTimeout(() => {
      drawScheduled = false;
      lastDrawTime = Date.now();
      drawArrows();
    }, DRAW_THROTTLE_MS - elapsed);
  }
}

// Process a single UCI output line from Stockfish
function handleUCILine(line) {
  if (!line || typeof line !== 'string') return;

  if (line === 'uciok') {
    // UCI initialized — wait for readyok
  } else if (line === 'readyok') {
    workerReady = true;
    setEngineStatus('ready', '● Engine Ready');
    console.log('[BetterMint] Stockfish 18 NNUE ready!');
    if (pendingFEN) {
      analyze(pendingFEN);
      pendingFEN = null;
    }
  } else if (line.startsWith('info')) {
    onInfoLine(line);
  } else if (line.startsWith('bestmove')) {
    onBestMoveLine(line);
  }
}

function onInfoLine(line) {
  const depthM  = line.match(/\bdepth (\d+)/);
  const mpvM    = line.match(/\bmultipv (\d+)/);
  const scoreM  = line.match(/\bscore (cp|mate) (-?\d+)/);
  const pvM     = line.match(/ pv (.+)/);

  if (!depthM || !scoreM) return;

  const scoreType  = scoreM[1];
  const scoreValue = parseInt(scoreM[2]);
  const pvMoves    = pvM ? pvM[1].trim().split(' ') : [];
  if (pvMoves.length === 0) return;

  // Stockfish UCI protocol outputs score relative to the SIDE TO MOVE.
  // We normalize evaluation to PLAYER'S PERSPECTIVE (+ = player advantage, - = opponent advantage)
  const playerColor = getPlayerColor();
  const isPlayerSideToMove = (currentTurn === playerColor);
  const multiplier = isPlayerSideToMove ? 1 : -1;

  let evaluation = 0, isMate = false, mateIn = 0;
  if (scoreType === 'cp') {
    evaluation = (scoreValue / 100) * multiplier;
  } else if (scoreType === 'mate') {
    isMate = true;
    mateIn = scoreValue * multiplier;
    evaluation = (scoreValue > 0 ? 999 : -999) * multiplier;
  }

  const multipv = mpvM ? parseInt(mpvM[1]) : 1;
  const depth   = parseInt(depthM[1]);

  analysisResults[multipv - 1] = {
    multipv, depth, evaluation, isMate, mateIn,
    pv: pvMoves, bestMove: pvMoves[0],
  };

  if (multipv === 1) {
    updateEvalBar(evaluation, isMate, mateIn, depth);
    // Only draw arrows during analysis if Human Mode is OFF
    if (settings.showArrows && !settings.humanMode) scheduleDrawArrows();
    if (depthIndicator) {
      const elo = depthToElo(depth);
      depthIndicator.textContent = `Depth: ${depth}/${settings.depth}  ~${elo} ELO`;
    }
  }
}

// Approximate ELO strength for Stockfish 18 NNUE at a given search depth
function depthToElo(depth) {
  const table = {
    1:  800,  2: 1000,  3: 1200,  4: 1400,  5: 1600,
    6: 1800,  7: 1950,  8: 2100,  9: 2200, 10: 2350,
    11: 2500, 12: 2650, 13: 2750, 14: 2880, 15: 2980,
    16: 3080, 17: 3150, 18: 3250, 19: 3350, 20: 3420,
    21: 3470, 22: 3500, 23: 3530, 24: 3550, 25: 3570,
  };
  if (depth <= 0) return '—';
  if (depth >= 26) return '3600+';
  return table[depth] ? `${table[depth]}` : `${3500 + (depth - 22) * 20}`;
}

// Human Mode: delay variable to cancel pending reveal
let humanModeTimer = null;

function onBestMoveLine(line) {
  // Check if this bestmove is from an accuracy eval
  if (pendingAccuracy) {
    pendingAccuracy = false;
    // Now we have the eval AFTER the player's move (both evals are in player's perspective!)
    if (analysisResults[0] && evalBeforeMove !== null) {
      const newEval = analysisResults[0].evaluation;
      // cpLoss = evalBeforeMove - newEval
      // e.g. Before: +2.0, After: +1.8 => cpLoss = 0.2 (Excellent)
      // e.g. Before: +2.0, After: -3.0 => cpLoss = 5.0 (Blunder)
      // e.g. Before: +1.0, After: +2.5 => cpLoss = -1.5 (Brilliant)
      const cpLoss = evalBeforeMove - newEval;

      // Check if player played the suggested best move
      const playedBestMove = bestMoveSuggested && checkIfPlayedBest();

      let classification;
      if (cpLoss < -0.5) {
        // Eval IMPROVED significantly = Brilliant
        classification = { name: '!! Brilliant', color: '#1baca6', icon: '!!' };
      } else if (cpLoss <= 0.0) {
        classification = { name: '★ Best', color: '#1baca6', icon: '★' };
      } else if (cpLoss <= 0.15) {
        classification = { name: '! Excellent', color: '#96bc4b', icon: '!' };
      } else if (cpLoss <= 0.5) {
        classification = { name: '● Good', color: '#97af8b', icon: '●' };
      } else if (cpLoss <= 1.2) {
        classification = { name: '?! Inaccuracy', color: '#f0c15e', icon: '?!' };
      } else if (cpLoss <= 3.0) {
        classification = { name: '? Mistake', color: '#e07032', icon: '?' };
      } else {
        classification = { name: '?? Blunder', color: '#c93333', icon: '??' };
      }

      if (settings.showAccuracy) showAccuracyBadge(classification);
    }
    // Accuracy eval done — now decide what to do next
    analysisResults = [];

    if (!settings.onlyMyTurn) {
      // "Both" mode: continue with full analysis of opponent's position
      const fen = lastAnalyzedFEN;
      if (fen) {
        sendUCI('setoption name MultiPV value ' + settings.multiPV);
        sendUCI('position fen ' + fen);
        sendUCI('go depth ' + settings.depth);
        setEngineStatus('analyzing', '⟳ Analyzing…');
      }
    }
    return;
  }

  // Normal bestmove: save eval and suggested move for future accuracy comparison
  if (analysisResults[0]) {
    evalBeforeMove = analysisResults[0].evaluation;
    bestMoveSuggested = analysisResults[0].bestMove || '';
  }

  if (!settings.showArrows) return;

  if (settings.humanMode) {
    clearTimeout(humanModeTimer);
    const delay = 2000 + Math.random() * 4000;
    humanModeTimer = setTimeout(() => {
      if (settings.showArrows) drawArrows();
    }, delay);
  } else {
    drawArrows();
  }
}

// Check if the player played a move the engine suggested
function checkIfPlayedBest() {
  // Compare the move played (from highlight squares) with engine's suggestion
  // This is approximate — just checks if destinations match
  return false; // Simplified: rely on eval comparison
}

function analyze(fen) {
  if (!fen) return;
  if (!workerReady) {
    pendingFEN = fen;
    return;
  }
  if (fen === lastAnalyzedFEN) return;

  lastAnalyzedFEN = fen;
  analysisResults = [];

  // Clear old arrows immediately to prevent stale arrows
  if (arrowCtx && arrowCanvas) {
    arrowCtx.clearRect(0, 0, arrowCanvas.width, arrowCanvas.height);
  }

  sendUCI('stop');
  sendUCI('setoption name MultiPV value ' + settings.multiPV);
  sendUCI('position fen ' + fen);
  sendUCI('go depth ' + settings.depth);

  setEngineStatus('analyzing', '⟳ Analyzing…');
}

function showAccuracyBadge(classification) {
  // Remove old badge from board
  const oldBadges = document.querySelectorAll('.bm-move-badge');
  oldBadges.forEach(b => b.remove());


  const board = getBoardEl();
  if (!board) return;

  const boardRect = board.getBoundingClientRect();
  const sqSize = boardRect.width / 8;
  let px, py;

  if (IS_LICHESS) {
    // Lichess last-move squares: <square class="last-move"> with transform positioning
    const lastMoves = board.querySelectorAll('square.last-move');
    if (lastMoves.length === 0) return;

    // Find the TO square: the last-move square that has a piece on it
    let toTransform = null;
    for (const sq of lastMoves) {
      const t = sq.style.transform || '';
      const m = t.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
      if (!m) continue;
      const sqPx = parseFloat(m[1]);
      const sqPy = parseFloat(m[2]);
      // Check if any piece sits at this position
      for (const piece of board.querySelectorAll('piece')) {
        const pt = piece.style.transform || '';
        const pm = pt.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
        if (pm && Math.abs(parseFloat(pm[1]) - sqPx) < 5 && Math.abs(parseFloat(pm[2]) - sqPy) < 5) {
          toTransform = { x: sqPx, y: sqPy };
          break;
        }
      }
      if (toTransform) break;
    }

    // Fallback: last element in last-move list
    if (!toTransform) {
      const last = lastMoves[lastMoves.length - 1];
      const m = (last.style.transform || '').match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
      if (m) toTransform = { x: parseFloat(m[1]), y: parseFloat(m[2]) };
    }
    if (!toTransform) return;

    px = toTransform.x;
    py = toTransform.y;

  } else {
    // Chess.com: highlighted squares with square-XY class
    const highlights = board.querySelectorAll('.highlight');
    if (highlights.length < 2) return;

    let toSquareClass = null;
    for (const hl of highlights) {
      const sqClass = hl.className.match(/square-(\d\d)/);
      if (!sqClass) continue;
      const piece = board.querySelector(`.piece.square-${sqClass[1]}`);
      if (piece) { toSquareClass = sqClass[1]; break; }
    }
    if (!toSquareClass) {
      const fallback = highlights[1].className.match(/square-(\d\d)/);
      if (fallback) toSquareClass = fallback[1];
    }
    if (!toSquareClass) return;

    const file = parseInt(toSquareClass[0]) - 1;
    const rank = parseInt(toSquareClass[1]) - 1;
    if (isFlipped) { px = (7 - file) * sqSize; py = rank * sqSize; }
    else           { px = file * sqSize;         py = (7 - rank) * sqSize; }
  }

  // Create on-board badge at TOP-RIGHT corner of destination square
  const badge = document.createElement('div');
  badge.className = 'bm-move-badge';
  badge.textContent = classification.icon;
  badge.style.background = classification.color;
  badge.style.left = (board.offsetLeft + px + sqSize) + 'px';
  badge.style.top  = (board.offsetTop  + py)          + 'px';

  const parent = board.parentElement;
  if (parent) {
    parent.style.position = 'relative';
    parent.appendChild(badge);
  }

  setTimeout(() => {
    badge.style.transition = 'opacity 0.3s ease';
    badge.style.opacity = '0';
    setTimeout(() => badge.remove(), 300);
  }, 3700);
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation bar — White at bottom (white bg), Black at top (dark fill)
// ─────────────────────────────────────────────────────────────────────────────
function createEvalBar() {
  if (evalBarEl) return;

  evalBarEl = document.createElement('div');
  evalBarEl.id = 'bm-eval-bar';
  evalBarEl.className = 'bm-eval-bar';

  evalFillEl = document.createElement('div');
  evalFillEl.className = 'bm-eval-fill';

  evalTextEl = document.createElement('div');
  evalTextEl.className = 'bm-eval-text';
  evalTextEl.textContent = '0.0';

  evalBarEl.appendChild(evalFillEl);
  evalBarEl.appendChild(evalTextEl);

  injectNextToBoard(evalBarEl);
}

function updateLichessEvalBarPos(el) {
  const bar = el || evalBarEl;
  if (!IS_LICHESS || !bar) return;
  const board = getBoardEl();
  if (!board) return;
  const rect = board.getBoundingClientRect();
  const leftPos = Math.max(4, rect.left - 30);
  bar.style.top = rect.top + 'px';
  bar.style.left = leftPos + 'px';
  bar.style.height = rect.height + 'px';
}

function injectNextToBoard(el) {
  const board = getBoardEl();
  if (!board) return;

  if (IS_LICHESS) {
    // On Lichess, inject as fixed overlay — don't touch the board DOM
    el.style.position = 'fixed';
    el.style.zIndex = '9999';
    el.style.pointerEvents = 'none';
    updateLichessEvalBarPos(el);
    document.body.appendChild(el);
    return;
  }

  const wrapper = board.closest('[class*="board-layout"]') ||
                  board.closest('[class*="game-layout"]') ||
                  board.parentElement;

  if (wrapper) {
    wrapper.style.position = 'relative';
    wrapper.style.display = wrapper.style.display || 'flex';
    wrapper.insertBefore(el, wrapper.firstChild);
  } else {
    board.parentElement.insertBefore(el, board);
  }
}

function updateEvalBar(evaluation, isMate, mateIn, depth) {
  if (!evalFillEl || !evalTextEl) return;

  let displayText = '';
  let blackPct = 50; // How much of bar is black (from top)

  if (isMate) {
    displayText = mateIn > 0 ? `M${mateIn}` : `M${Math.abs(mateIn)}`;
    blackPct = mateIn > 0 ? 2 : 98;  // White winning = tiny black, Black winning = big black
  } else {
    const clamp = Math.max(-10, Math.min(10, evaluation));
    // White advantage = less black fill, Black advantage = more black fill
    blackPct = 50 - (clamp / 10) * 48;
    displayText = evaluation >= 0
      ? `+${evaluation.toFixed(1)}`
      : evaluation.toFixed(1);
  }

  evalFillEl.style.height = `${blackPct}%`;
  evalTextEl.textContent = displayText;

  // Text color based on position (dark on light bg, light on dark bg)
  evalTextEl.style.color = blackPct > 50 ? '#ddd' : '#333';

  setEngineStatus('ready', `● Depth ${depth}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Arrow canvas overlay
// ─────────────────────────────────────────────────────────────────────────────
function createArrowCanvas() {
  if (arrowCanvas) return;

  const board = getBoardEl();
  if (!board) return;

  arrowCanvas = document.createElement('canvas');
  arrowCanvas.id = 'bm-arrow-canvas';
  arrowCanvas.className = 'bm-arrow-canvas';
  arrowCanvas.style.pointerEvents = 'none';

  const rect = board.getBoundingClientRect();
  arrowCanvas.width  = rect.width  || 600;
  arrowCanvas.height = rect.height || 600;

  new ResizeObserver(() => resizeCanvas()).observe(board);

  if (IS_LICHESS) {
    // Lichess: fixed overlay on body — never touch Lichess DOM
    arrowCanvas.style.position = 'fixed';
    arrowCanvas.style.zIndex   = '999';
    arrowCanvas.style.top      = rect.top  + 'px';
    arrowCanvas.style.left     = rect.left + 'px';
    arrowCanvas.style.width    = rect.width  + 'px';
    arrowCanvas.style.height   = rect.height + 'px';
    document.body.appendChild(arrowCanvas);
  } else {
    // Chess.com: absolute inside board parent
    const parent = board.parentElement;
    if (parent) {
      parent.style.position = 'relative';
      arrowCanvas.style.position = 'absolute';
      arrowCanvas.style.zIndex   = '10';
      arrowCanvas.style.top  = board.offsetTop  + 'px';
      arrowCanvas.style.left = board.offsetLeft + 'px';
      parent.appendChild(arrowCanvas);
    } else {
      board.style.position = 'relative';
      board.appendChild(arrowCanvas);
    }
  }

  arrowCtx = arrowCanvas.getContext('2d');
}

function resizeCanvas() {
  const board = getBoardEl();
  if (!board || !arrowCanvas) return;
  const rect = board.getBoundingClientRect();
  arrowCanvas.width  = rect.width;
  arrowCanvas.height = rect.height;
  if (IS_LICHESS) {
    // Sync fixed position to board's current viewport rect
    arrowCanvas.style.top    = rect.top    + 'px';
    arrowCanvas.style.left   = rect.left   + 'px';
    arrowCanvas.style.width  = rect.width  + 'px';
    arrowCanvas.style.height = rect.height + 'px';
    updateLichessEvalBarPos();
  } else {
    arrowCanvas.style.top  = board.offsetTop  + 'px';
    arrowCanvas.style.left = board.offsetLeft + 'px';
  }
  drawArrows();
}

function squareToPixel(squareStr) {
  const file = FILES.indexOf(squareStr[0]);
  const rank = parseInt(squareStr[1]) - 1;

  const size = arrowCanvas.width;
  const sq = size / 8;

  let x, y;
  if (isFlipped) {
    x = (7 - file) * sq + sq / 2;
    y = rank * sq + sq / 2;
  } else {
    x = file * sq + sq / 2;
    y = (7 - rank) * sq + sq / 2;
  }

  return { x, y };
}

function uciToSquares(uciMove) {
  if (!uciMove || uciMove.length < 4) return null;
  return {
    from: uciMove.substring(0, 2),
    to: uciMove.substring(2, 4),
  };
}

function drawArrow(ctx, from, to, color, lineWidth, opacity) {
  const fromPx = squareToPixel(from);
  const toPx = squareToPixel(to);

  const dx = toPx.x - fromPx.x;
  const dy = toPx.y - fromPx.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return;

  const angle = Math.atan2(dy, dx);
  const headLen = lineWidth * 2.8;
  const headWidth = lineWidth * 2.2;

  // Arrow tip position — slightly before the target center for cleaner look
  const tipX = toPx.x;
  const tipY = toPx.y;

  // Arrow body end (where the arrowhead starts)
  const bodyEndX = tipX - Math.cos(angle) * headLen;
  const bodyEndY = tipY - Math.sin(angle) * headLen;

  ctx.save();
  ctx.globalAlpha = opacity;

  // Subtle glow for visibility
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;

  // Draw body (thick rounded line)
  ctx.beginPath();
  ctx.moveTo(fromPx.x, fromPx.y);
  ctx.lineTo(bodyEndX, bodyEndY);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Draw arrowhead (filled triangle)
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(
    tipX - headLen * Math.cos(angle - Math.PI / 5.5),
    tipY - headLen * Math.sin(angle - Math.PI / 5.5)
  );
  // Slight indent at back of head for sleek look
  ctx.lineTo(
    tipX - headLen * 0.55 * Math.cos(angle),
    tipY - headLen * 0.55 * Math.sin(angle)
  );
  ctx.lineTo(
    tipX - headLen * Math.cos(angle + Math.PI / 5.5),
    tipY - headLen * Math.sin(angle + Math.PI / 5.5)
  );
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  ctx.restore();
}

function drawArrows() {
  if (!arrowCtx || !arrowCanvas || !settings.showArrows) return;

  arrowCtx.clearRect(0, 0, arrowCanvas.width, arrowCanvas.height);

  if (analysisResults.length === 0) return;

  const colors = [settings.arrowColor1, settings.arrowColor2, settings.arrowColor3];
  const opacities = [0.88, 0.60, 0.40];
  const sq = arrowCanvas.width / 8;
  const lineWidths = [sq * 0.22, sq * 0.16, sq * 0.12];

  // Draw in reverse order so best move (idx 0) is on top
  const toDraw = [];
  analysisResults.forEach((result, idx) => {
    if (!result || !result.bestMove) return;
    const squares = uciToSquares(result.bestMove);
    if (!squares) return;
    toDraw.push({ squares, idx });
  });

  // Reverse: draw worst first, best last (on top)
  toDraw.reverse().forEach(({ squares, idx }) => {
    drawArrow(
      arrowCtx,
      squares.from,
      squares.to,
      colors[idx] || '#ffffff',
      lineWidths[idx] || sq * 0.1,
      opacities[idx] || 0.3
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Control panel (floating HUD) — with minimize support
// ─────────────────────────────────────────────────────────────────────────────
let panelMinimized = false;

function createControlPanel() {
  if (controlPanel) return;

  controlPanel = document.createElement('div');
  controlPanel.id = 'bm-panel';
  controlPanel.className = 'bm-panel';
  controlPanel.innerHTML = `
    <div class="bm-panel-header">
      <span class="bm-logo">⚔️ ChessSlayer</span>
      <div class="bm-header-btns">
        <button class="bm-minimize-btn" id="bm-minimize" title="Minimize">▾</button>
        <button class="bm-toggle-btn" id="bm-toggle">ON</button>
      </div>
    </div>
    <div class="bm-panel-body" id="bm-panel-body">
      <div class="bm-panel-body-settings" id="bm-settings-section">
        <div class="bm-row">
          <label class="bm-label">Depth</label>
          <div class="bm-depth-control">
            <button class="bm-btn-sm" id="bm-depth-minus">−</button>
            <span id="bm-depth-val">${settings.depth}</span>
            <button class="bm-btn-sm" id="bm-depth-plus">+</button>
          </div>
        </div>
        <div class="bm-row">
          <label class="bm-label">Lines</label>
          <div class="bm-depth-control">
            <button class="bm-btn-sm" id="bm-pv-minus">−</button>
            <span id="bm-pv-val">${settings.multiPV}</span>
            <button class="bm-btn-sm" id="bm-pv-plus">+</button>
          </div>
        </div>
        <div class="bm-row">
          <label class="bm-label">Eval Bar</label>
          <button class="bm-chip ${settings.showEvalBar ? 'active' : ''}" id="bm-toggle-eval">
            ${settings.showEvalBar ? '✓ On' : '✗ Off'}
          </button>
        </div>
        <div class="bm-row">
          <label class="bm-label">Arrows</label>
          <button class="bm-chip ${settings.showArrows ? 'active' : ''}" id="bm-toggle-arrows">
            ${settings.showArrows ? '✓ On' : '✗ Off'}
          </button>
        </div>
        <div class="bm-row">
          <label class="bm-label">Accuracy</label>
          <button class="bm-chip ${settings.showAccuracy ? 'active' : ''}" id="bm-toggle-accuracy">
            ${settings.showAccuracy ? '✓ On' : '✗ Off'}
          </button>
        </div>
        <div class="bm-row">
          <label class="bm-label">My Turn</label>
          <button class="bm-chip ${settings.onlyMyTurn ? 'active' : ''}" id="bm-toggle-myturn">
            ${settings.onlyMyTurn ? '✓ Only' : '✗ Both'}
          </button>
        </div>
        <div class="bm-row">
          <label class="bm-label" title="Delays arrow 2-6s, looks human">Human Mode 🛡</label>
          <button class="bm-chip ${settings.humanMode ? 'active' : ''}" id="bm-toggle-humanmode">
            ${settings.humanMode ? '✓ On' : '✗ Off'}
          </button>
        </div>
        <div class="bm-row">
          <label class="bm-label">Engine</label>
          <div class="bm-engine-select">
            <button class="bm-chip ${settings.engineMode === 'lite' ? 'active' : ''}" id="bm-engine-lite" title="Fast, works on any PC/mobile">🪶 Lite</button>
            <button class="bm-chip ${settings.engineMode === 'full' ? 'active' : ''}" id="bm-engine-full" title="Maximum power, needs RAM">⚡ Full</button>
          </div>
        </div>
      </div>
      <div class="bm-panel-body-status">
        <div class="bm-engine-status" id="bm-engine-status">
          <span class="bm-status-dot loading"></span>
          <span id="bm-status-text">Loading Engine…</span>
          <button class="bm-restart-btn" id="bm-restart" title="Restart Engine">⟲</button>
        </div>
        <div class="bm-depth-info" id="bm-depth-indicator">Depth: —</div>
      </div>
    </div>
  `;

  document.body.appendChild(controlPanel);

  makeDraggable(controlPanel, controlPanel.querySelector('.bm-panel-header'));

  // Minimize button
  document.getElementById('bm-minimize').addEventListener('click', (e) => {
    e.stopPropagation();
    panelMinimized = !panelMinimized;
    controlPanel.classList.toggle('minimized', panelMinimized);
    document.getElementById('bm-minimize').textContent = panelMinimized ? '▸' : '▾';
  });

  document.getElementById('bm-toggle').addEventListener('click', toggleExtension);
  document.getElementById('bm-depth-minus').addEventListener('click', () => adjustDepth(-1));
  document.getElementById('bm-depth-plus').addEventListener('click', () => adjustDepth(1));
  document.getElementById('bm-pv-minus').addEventListener('click', () => adjustPV(-1));
  document.getElementById('bm-pv-plus').addEventListener('click', () => adjustPV(1));
  document.getElementById('bm-toggle-eval').addEventListener('click', () => toggleFeature('showEvalBar', 'bm-toggle-eval'));
  document.getElementById('bm-toggle-arrows').addEventListener('click', () => toggleFeature('showArrows', 'bm-toggle-arrows'));
  document.getElementById('bm-toggle-accuracy').addEventListener('click', () => toggleFeature('showAccuracy', 'bm-toggle-accuracy'));
  document.getElementById('bm-toggle-myturn').addEventListener('click', () => {
    settings.onlyMyTurn = !settings.onlyMyTurn;
    const btn = document.getElementById('bm-toggle-myturn');
    if (btn) {
      btn.textContent = settings.onlyMyTurn ? '✓ Only' : '✗ Both';
      btn.className = `bm-chip ${settings.onlyMyTurn ? 'active' : ''}`;
    }
    saveSettings();
    triggerAnalysis();
  });
  document.getElementById('bm-toggle-humanmode').addEventListener('click', () => {
    settings.humanMode = !settings.humanMode;
    const btn = document.getElementById('bm-toggle-humanmode');
    if (btn) {
      btn.textContent = settings.humanMode ? '✓ On' : '✗ Off';
      btn.className = `bm-chip ${settings.humanMode ? 'active' : ''}`;
    }
    clearTimeout(humanModeTimer);
    saveSettings();
  });
  document.getElementById('bm-engine-lite').addEventListener('click', () => {
    document.getElementById('bm-engine-lite').className = 'bm-chip active';
    document.getElementById('bm-engine-full').className = 'bm-chip';
    switchEngine('lite');
  });
  document.getElementById('bm-engine-full').addEventListener('click', () => {
    document.getElementById('bm-engine-full').className = 'bm-chip active';
    document.getElementById('bm-engine-lite').className = 'bm-chip';
    switchEngine('full');
  });
  document.getElementById('bm-restart').addEventListener('click', () => restartEngine());

  engineStatus = document.getElementById('bm-engine-status');
  depthIndicator = document.getElementById('bm-depth-indicator');
}

function createAccuracyBadge() {
  if (accuracyBadge) return;
  accuracyBadge = document.createElement('div');
  accuracyBadge.id = 'bm-accuracy-badge';
  accuracyBadge.className = 'bm-accuracy-badge';
  accuracyBadge.style.opacity = '0';
  document.body.appendChild(accuracyBadge);
}

function setEngineStatus(state, text) {
  if (!engineStatus) return;
  const dot = engineStatus.querySelector('.bm-status-dot');
  const txt = document.getElementById('bm-status-text');
  if (dot) {
    dot.className = 'bm-status-dot ' + state;
  }
  if (txt) txt.textContent = text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Draggable panel
// ─────────────────────────────────────────────────────────────────────────────
function makeDraggable(el, handle) {
  let startX, startY, initLeft, initTop;
  handle.style.cursor = 'grab';
  handle.style.touchAction = 'none';

  const onStart = (e) => {
    if (e.target.tagName === 'BUTTON') return;
    const touch = e.touches ? e.touches[0] : e;
    startX = touch.clientX;
    startY = touch.clientY;
    const rect = el.getBoundingClientRect();
    initLeft = rect.left;
    initTop = rect.top;

    el.style.right = 'auto';
    el.style.bottom = 'auto';

    const onMove = (evt) => {
      const moveTouch = evt.touches ? evt.touches[0] : evt;
      const dx = moveTouch.clientX - startX;
      const dy = moveTouch.clientY - startY;
      el.style.left = `${initLeft + dx}px`;
      el.style.top  = `${initTop  + dy}px`;
    };

    const onEnd = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', onEnd);
  };

  handle.addEventListener('mousedown', onStart);
  handle.addEventListener('touchstart', onStart, { passive: false });
}

// ─────────────────────────────────────────────────────────────────────────────
// Control panel interactions
// ─────────────────────────────────────────────────────────────────────────────
function toggleExtension() {
  settings.enabled = !settings.enabled;
  const btn = document.getElementById('bm-toggle');
  if (btn) {
    btn.textContent = settings.enabled ? 'ON' : 'OFF';
    btn.className = `bm-toggle-btn ${settings.enabled ? 'on' : 'off'}`;
  }
  const panelBody = document.getElementById('bm-panel-body');
  if (panelBody) panelBody.style.opacity = settings.enabled ? '1' : '0.4';

  if (settings.enabled) {
    triggerAnalysis();
  } else {
    if (arrowCtx) arrowCtx.clearRect(0, 0, arrowCanvas.width, arrowCanvas.height);
    if (evalFillEl) evalFillEl.style.height = '50%';
    sendUCI('stop');
  }

  saveSettings();
}

function adjustDepth(delta) {
  settings.depth = Math.max(1, Math.min(30, settings.depth + delta));
  const el = document.getElementById('bm-depth-val');
  if (el) el.textContent = settings.depth;
  triggerAnalysis();
  saveSettings();
}

function adjustPV(delta) {
  settings.multiPV = Math.max(1, Math.min(5, settings.multiPV + delta));
  const el = document.getElementById('bm-pv-val');
  if (el) el.textContent = settings.multiPV;
  triggerAnalysis();
  saveSettings();
}

function toggleFeature(key, btnId) {
  settings[key] = !settings[key];
  const btn = document.getElementById(btnId);
  if (btn) {
    btn.textContent = settings[key] ? '✓ On' : '✗ Off';
    btn.className   = `bm-chip ${settings[key] ? 'active' : ''}`;
  }

  if (key === 'showEvalBar' && evalBarEl) {
    evalBarEl.style.display = settings.showEvalBar ? 'block' : 'none';
  }
  if (key === 'showArrows') {
    if (arrowCanvas) {
      arrowCanvas.style.display = settings.showArrows ? 'block' : 'none';
    }
    if (arrowCtx && !settings.showArrows) {
      arrowCtx.clearRect(0, 0, arrowCanvas.width, arrowCanvas.height);
    } else if (settings.showArrows) {
      drawArrows();
    }
  }
  if (key === 'showAccuracy' && accuracyBadge) {
    if (!settings.showAccuracy) {
      accuracyBadge.style.opacity = '0';
    }
  }

  saveSettings();
}

function saveSettings() {
  chrome.storage.local.set(settings);
}

// ─────────────────────────────────────────────────────────────────────────────
// Board observer
// ─────────────────────────────────────────────────────────────────────────────
// Detect which color the player is (bottom of board)
function getPlayerColor() {
  // If board is flipped, player is black; otherwise white
  return isFlipped ? 'b' : 'w';
}

function triggerAnalysis() {
  if (!settings.enabled) return;
  clearTimeout(analysisTimer);
  analysisTimer = setTimeout(() => {
    const result = extractFEN();
    if (!result) return;

    const { fen, turn } = result;
    if (fen === lastAnalyzedFEN) return;

    currentTurn = turn;
    const playerColor = getPlayerColor();
    const playerJustMoved = (turn !== playerColor);

    // If player just moved and we have an eval from before the move,
    // run a QUICK analysis to get the eval of the new position for accuracy
    if (playerJustMoved && settings.showAccuracy && evalBeforeMove !== null) {
      // Clear arrows on opponent's turn
      if (arrowCtx && arrowCanvas) {
        arrowCtx.clearRect(0, 0, arrowCanvas.width, arrowCanvas.height);
      }

      // Run quick eval for accuracy rating (depth 10 = fast + good enough)
      pendingAccuracy = true;
      lastAnalyzedFEN = fen;  // prevent re-trigger
      analysisResults = [];
      sendUCI('stop');
      sendUCI('setoption name MultiPV value 1');
      sendUCI('position fen ' + fen);
      sendUCI('go depth 10');
      setEngineStatus('analyzing', '⟳ Rating move…');
      return;
    }

    // Skip analysis on opponent's turn (after accuracy is done)
    if (settings.onlyMyTurn && playerJustMoved) {
      // Already handled above if showAccuracy is on
      if (arrowCtx && arrowCanvas) {
        arrowCtx.clearRect(0, 0, arrowCanvas.width, arrowCanvas.height);
      }
      setEngineStatus('ready', '○ Opponent\'s turn');
      sendUCI('stop');
      return;
    }

    previousFEN = currentFEN;
    currentFEN = fen;
    analysisResults = [];
    analyze(fen);
  }, 150);
}

function startBoardObserver() {
  const board = getBoardEl();
  if (!board) return false;

  // MutationObserver for immediate detection
  const observer = new MutationObserver(() => triggerAnalysis());

  if (IS_LICHESS) {
    // Lichess: observe cg-board pieces (style changes = piece moves)
    observer.observe(board, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    // Also observe parent for orientation changes (board flip)
    const wrap = board.closest('.cg-wrap') || board.parentElement;
    if (wrap) observer.observe(wrap, { attributes: true, attributeFilter: ['class'] });
  } else {
    // Chess.com: observe class & style changes
    observer.observe(board, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
  }

  // BACKUP: Polling every 800ms — catches moves that MutationObserver misses
  let lastPolledFEN = '';
  setInterval(() => {
    if (!settings.enabled) return;
    const result = extractFEN();
    if (!result) return;
    if (result.fen !== lastPolledFEN) {
      lastPolledFEN = result.fen;
      triggerAnalysis();
    }
  }, 800);

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────
function init() {
  chrome.storage.local.get(null, (saved) => {
    if (saved && Object.keys(saved).length > 0) {
      Object.assign(settings, saved);
    }

    createControlPanel();
    createAccuracyBadge();
    createEvalBar();
    createArrowCanvas();

    // Apply saved toggle states
    if (evalBarEl && !settings.showEvalBar) evalBarEl.style.display = 'none';
    if (arrowCanvas && !settings.showArrows) arrowCanvas.style.display = 'none';

    if (settings.enabled) initWorker();
    else setEngineStatus('off', '○ Engine Off');

    const started = startBoardObserver();
    if (!started) {
      const retry = setInterval(() => {
        if (startBoardObserver()) {
          clearInterval(retry);
          createArrowCanvas();
          triggerAnalysis();
        }
      }, 500);
    } else {
      triggerAnalysis();
    }
  });
}

// Window scroll & resize listeners for position syncing
window.addEventListener('scroll', () => { if (IS_LICHESS) resizeCanvas(); }, { passive: true });
window.addEventListener('resize', () => resizeCanvas(), { passive: true });

// Wait for Chess.com / Lichess to render
if (document.readyState === 'complete') {
  setTimeout(init, 800);
} else {
  window.addEventListener('load', () => setTimeout(init, 800));
}

// Re-init on SPA navigation
let lastUrl = location.href;
const navObserver = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    document.getElementById('bm-arrow-canvas') && document.getElementById('bm-arrow-canvas').remove();
    arrowCanvas = null; arrowCtx = null;
    setTimeout(() => {
      createArrowCanvas();
      startBoardObserver();
      triggerAnalysis();
    }, 1200);
  }
});
navObserver.observe(document.body, { childList: true, subtree: true });

// ─────────────────────────────────────────────────────────────────────────────
// Message listeners
// ─────────────────────────────────────────────────────────────────────────────

// Receive UCI output from background.js (relayed from offscreen → background → here)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.source === 'background') {
    if (msg.type === 'UCI_OUTPUT') {
      handleUCILine(msg.line);
    } else if (msg.type === 'ENGINE_ERROR') {
      workerReady = false;
      setEngineStatus('error', '⚠ Crashed — restarting in 3s…');
      console.warn('[BetterMint] Engine error:', msg.message);
      // Auto-restart after 3 seconds
      setTimeout(() => {
        console.log('[BetterMint] Auto-restarting engine...');
        restartEngine();
      }, 3000);
    }
    return;
  }

  // Respond to popup status requests
  if (msg.type === 'GET_ENGINE_STATUS') {
    sendResponse({
      ready: workerReady,
      loading: !workerReady,
      depth: settings.depth,
    });
    return true;
  }
});

// Listen for settings changes from popup
chrome.storage.onChanged.addListener((changes) => {
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key in settings) {
      settings[key] = newValue;
    }
  }
  // Handle HUD visibility toggle from popup
  if ('showHUD' in changes) {
    if (controlPanel) {
      controlPanel.style.display = settings.showHUD ? 'block' : 'none';
    }
  }
  if (settings.enabled) triggerAnalysis();
});
