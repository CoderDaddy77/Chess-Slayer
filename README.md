# ⚔️ Chess Slayer

> Real-time **Stockfish 18 NNUE** analysis extension for **Chess.com** — play like a grandmaster with best move arrows, evaluation bar, move accuracy badges, and more.

![Chess Slayer Banner](icons/icon128.png)

---

## ✨ Features

| Feature | Description |
|--------|-------------|
| 🏹 **Best Move Arrows** | Color-coded arrows for top candidate moves (up to 5 lines) |
| 📊 **Evaluation Bar** | Live position advantage bar (White/Black perspective) |
| 🎯 **Move Accuracy** | Rates every move: !! Brilliant → ★ Best → ! Excellent → ● Good → ?! Inaccuracy → ? Mistake → ?? Blunder |
| 🪶 **Lite / ⚡ Full Engine** | Switch between fast Lite engine (any PC) or maximum power Full engine |
| 🛡️ **Human Mode** | Delays arrow reveal 2-6s so it looks natural, not bot-like |
| 🎮 **My Turn / Both** | Analyze only your moves or both sides |
| 📱 **HUD Toggle** | Show/hide the floating panel from popup |
| 🔢 **Depth + ELO Estimate** | See current search depth and approximate ELO strength |

---

## 🚀 Installation

> **No Chrome Web Store needed** — load it directly as an unpacked extension.

### Step 1 — Download
```bash
git clone https://github.com/CoderDaddy77/Chess-Slayer.git
```
Or download the ZIP from the green **Code** button above.

### Step 2 — Load in Browser
1. Open **Edge**: `edge://extensions/` — or **Chrome**: `chrome://extensions/`
2. Enable **Developer Mode** (top right toggle)
3. Click **"Load unpacked"**
4. Select the `Chess-Slayer` folder
5. Open [chess.com](https://www.chess.com) and start playing!

---

## 🎮 How to Use

- The **⚔️ ChessSlayer** panel appears on the board — drag it anywhere
- Use **▾** to minimize the panel to just the status bar
- Toggle **🪶 Lite / ⚡ Full** to switch engine power
- Accuracy badge (★ !! ? ??) appears on the piece after each move
- Turn **Human Mode 🛡** ON to hide arrows briefly (avoids detection)

---

## ⚙️ Settings Panel

| Setting | What it does |
|---------|-------------|
| **Depth** | Search depth (1-30). Higher = stronger but slower |
| **Lines** | Number of candidate move arrows (1-5) |
| **Eval Bar** | Show/hide the evaluation bar |
| **Arrows** | Show/hide move arrows |
| **Accuracy** | Show/hide move accuracy badge on pieces |
| **My Turn** | Analyze only your turn vs. both players |
| **Human Mode** | Delay arrow display by 2-6 seconds |
| **Engine** | 🪶 Lite (fast) or ⚡ Full (max power) |

---

## 🧠 Engine Strength

| Depth | Approx ELO |
|-------|-----------|
| 10 | ~2350 |
| 14 | ~2880 |
| 17 | ~3150 |
| 20 | ~3420 |
| 25+ | 3600+ 🔥 |

Powered by **Stockfish 18 NNUE** — the world's strongest open-source chess engine.

---

## 📁 Project Structure

```
Chess-Slayer/
├── manifest.json              # Extension manifest (MV3)
├── content.js                 # Main board injection script
├── styles.css                 # HUD & badge styles
├── background.js              # Service worker (message routing)
├── offscreen.js               # Stockfish worker host
├── offscreen.html             # Offscreen document
├── popup.html / popup.js      # Extension popup UI
├── popup.css                  # Popup styles
├── stockfish.js               # Full Stockfish 18 NNUE engine
├── stockfish.wasm             # Full engine WASM binary
├── stockfish-18-lite-single.js   # Lite engine
├── stockfish-18-lite-single.wasm # Lite engine WASM
└── icons/                     # Extension icons
```

---

## ⚠️ Disclaimer

This extension is built for **educational and practice purposes** — to learn chess tactics by playing against bots and studying positions. Using engine assistance in **online games against real players** violates Chess.com's Terms of Service. Use responsibly.

---

## 📄 License

MIT License — free to use, modify, and distribute.

---

Made with ♟️ by [CoderDaddy77](https://github.com/CoderDaddy77)
