# Volume Monitor (Stream Deck native plugin)

A native **Stream Deck+ plugin** that brings the features of the
[`volume-monitor`](https://github.com/Tech127x/volume-monitor) project to the
Elgato Stream Deck software. It is fully **standalone** — it needs nothing
but the Stream Deck app: no Bitfocus Companion, no Python, no external
programs, no npm packages.

Real-time audio control at your fingertips:

- **Master volume dial** — device name + volume, rotate to adjust, press
  the dial **or tap the screen above it** to mute.
- **Per-app volume knobs** — every playing app gets its own knob,
  automatically. Apps remember their volume; brand-new apps start at a safe
  **50%**; close an app and the remaining knobs compact left.
- **Device toggle button** — cycles your audio output devices and shows the
  current one as the title, with a Windows toast on switch.

Everything runs through **plain CommonJS Node.js** (no npm dependencies)
talking the raw Stream Deck websocket protocol, plus one bundled PowerShell
script that speaks to the Windows Core Audio API through C# COM interop.

---

## Requirements

- Windows 10 or 11 (64-bit)
- Elgato Stream Deck software **7.1 or newer** (SDK 2)
- PowerShell **5.1** (built into Windows — no install needed)
- Stream Deck+ hardware (dials for the volume knobs, keypad for the toggle)

The plugin requests Node.js **24** in its manifest (`Nodejs.Version`); the
Stream Deck software downloads that runtime automatically on first run.

---

## Install

```powershell
cd volume-monitor-streamdeck
powershell -ExecutionPolicy Bypass -File install.ps1
```

The installer copies `com.tech127x.volume-monitor.sdPlugin` into
`%APPDATA%\Elgato\StreamDeck\Plugins\`. Restart Stream Deck (tray icon →
Quit, then reopen), then search for **Volume Monitor** in the action list:

| Action | Where | What it does |
| ------ | ----- | ------------ |
| **Master Volume** | a dial | Shows the current device + volume. Rotate = volume, press or tap = mute. |
| **App Volume Knob** | a dial (up to 3) | Auto-assigns a playing app. Rotate = that app's volume, press or tap = mute that app. |
| **Toggle Audio Device** | a keypad button | Cycles to the next output device; the title shows the current device. |

The three app knobs map to knob slots 2–4 (set a fixed slot in the action's
property inspector, or leave "Auto" and they are assigned in order).

---

## Features

### Master knob
- Shows `Device name` + `NN%` with a volume indicator bar (red slash icon
  while muted, value reads `MUTED`).
- Rotate adjusts the system volume by 2% per tick.
- Press the dial or **tap the touchscreen display** above it to
  mute/unmute.
- When the default output device changes (e.g. Bluetooth headphones
  connect), the knob updates and — if enabled — a toast appears.

### App knobs (2–4)
- **One knob per app**, with the app's **icon, name, and volume** when the
  Elgato audio router is available (see below). Otherwise the plugin falls
  back to session-based detection.
- Rotate adjusts that app's volume; **press the dial or tap the display
  above it** to mute/unmute the app.
- Sessions from real applications get one knob each, in the order they
  appear. Browsers (Chrome/Edge/Firefox/Brave…) get **one knob per tab**,
  labeled `chrome: YouTube – Best of 2026` (fallback mode).
- **Shift-left compaction**: close an app and the rest slide left to fill
  the gap (after a 500 ms grace period so knobs don't flicker).
- **Volume memory**: every app's level is remembered (stored in the
  plugin's global settings, keyed by app name). Close Spotify at 44% and
  it comes back at 44%.
- **Safe defaults**: an app never seen before starts at **50%** — never a
  surprise 100% blast.
- **Restore on new stream**: if an app's remembered volume is below 95%
  and it opens a *new* audio session at 100%, the plugin restores the
  remembered level (with a verify loop — new sessions are flaky).
- System sessions (`svchost`, `audiodg`, the Background session, System
  Sounds) are excluded from app knobs by default.

### Toggle device
- One press switches to the next active render device. Needs at least two
  devices. Title always shows the current device.
- Uses the per-user `IPolicyConfig.SetDefaultEndpoint` API — **no admin
  rights needed** (same mechanism as SoundSwitch).

---

## Configuration (property inspector)

Open the action's settings panel:

- **Excluded apps** — one pattern per line; any session whose app or
  display name contains a pattern is hidden from app knobs.
- **Default volume** — level applied to never-before-seen apps (0–100).
- **Poll interval** — audio refresh rate in ms (50–5000; default 100).
- **Notify on switch** — Windows toast when the output device changes.
- **Knob slot** (app knob actions only) — fixed slot 2/3/4 or Auto.
- **Status** panel — live device/volume readout, Refresh, and a
  "Test notification" button.

Settings are stored in the plugin's **global settings**
(`excluded apps`, `default volume`, `poll interval`, `notify on switch`)
and per-action settings (knob slot). Per-app volume memory is also kept in
global settings (`volumeMemory`).

---

## Architecture

```
com.tech127x.volume-monitor.sdPlugin/
├── manifest.json                # SDK 2, Nodejs 24, SD 7.1+, Windows 10+
├── plugin.js                    # entry: raw websocket, argv -port/-pluginUUID/-registerEvent
├── audio-bridge.ps1             # Windows Core Audio bridge (C# via Add-Type, C# 5)
├── lib/
│   ├── core.js                  # event dispatch, polling, feedback, restore logic
│   ├── audio-router.js          # optional Elgato audio router client (names + icons)
│   ├── bridge.js                # spawns/manages audio-bridge.ps1 (line JSON protocol)
│   ├── knob-manager.js          # slot assignment, compaction, 500ms grace
│   ├── volume-memory.js         # per-app volume memory in globalSettings
│   ├── device-utils.js          # normalization, exclusions, disambiguation
│   └── log.js                   # append-only log under %TEMP%
├── imgs/                        # handwritten SVGs + generated PNGs
└── property-inspector/          # settings.html/.js/.css
tools/
├── make-icons.mjs               # zero-dep SVG→PNG rasterizer + PNG encoder
└── test-bridge.ps1              # 10s bridge sanity check against real audio
tests/
└── harness.mjs                  # headless harness (fake ws + fake audio)
install.ps1                      # copies the .sdPlugin folder into Stream Deck
```

### The audio bridge

`audio-bridge.ps1` compiles a small C# Core Audio client with `Add-Type`
and exposes a **line-delimited JSON protocol** on stdin/stdout:

```
-> {"cmd":"state"}                       <- {"ok":true,"device":"Speakers","deviceId":"{0.0.0.00000000}.{guid}","muted":false,"volume":64}
-> {"cmd":"setvol","volume":50}          set master volume
-> {"cmd":"mute","muted":true}           set master mute
-> {"cmd":"devices"}                     list active render endpoints
-> {"cmd":"sessions"}                    list audio sessions (id, app, display, volume, muted)
-> {"cmd":"sessvol","id":"floorp|{guid}","volume":40}
-> {"cmd":"sessstate","id":"floorp|{guid}"}  read one session's volume/mute
-> {"cmd":"sessmute","id":"floorp|{guid}","muted":true}
-> {"cmd":"setdefault","id":"{0.0...}"}  switch default endpoint (IPolicyConfig)
-> {"cmd":"ping"} / {"cmd":"quit"}
```

The C# side declares the COM interfaces by hand (`IMMDeviceEnumerator`,
`IMMDevice`, `IAudioEndpointVolume`, `IAudioSessionManager2`,
`IAudioSessionEnumerator`, `IAudioSessionControl`, `ISimpleAudioVolume`,
`IPolicyConfig`) and is written in **C# 5** so the PowerShell 5.1
`Add-Type` compiler accepts it.

Session identification note: `IAudioSessionControl2` (process ids, instance
identifiers) is not exposed by the cross-process session controls on this
Windows build, so the bridge derives the app name from the session icon
path (the exe path for real applications) and keys each session by
`app|grouping-guid`. Sessions with no app and no display name are system
sessions only when they sit at exactly 100% volume and are silent; unnamed
sessions that are audible or below 100% are shown as generic **App** knobs
(some VST hosts and games never set a session name). Unnamed sessions are
never auto-adjusted (no safe default / restore), so system sessions are
never modified.

Toasts use the one-shot mode of the same script:

```
powershell -NoProfile -ExecutionPolicy Bypass -File audio-bridge.ps1 -Command toast -Title "Audio Output Switched" -Body "Changed to: Headphones"
```

### The audio router (names + icons)

Some Windows builds expose no process information on audio sessions (the
`IAudioSessionControl2` interface is not implemented by the session
controls the enumerator returns), so per-app **names and icons** cannot be
derived from Core Audio alone. The plugin therefore uses the **Elgato
Volume Controller audio router** service (`ws://127.0.0.1:1844`). That
service ships with the Elgato Volume Controller plugin/app and registers a
logon autostart (`Volume Controller SD plugin` Run key), so it is normally
running whenever the Stream Deck software is. If it is installed but not
running, the plugin launches its watcher once as a best-effort kick.

When present the router provides real per-app data — process id,
executable path, display name and a PNG icon — and the app knobs show
exactly that: **icon + app name + volume**. Rotate/press drive that app's
volume/mute through the same service.

When the service genuinely is not installed the plugin automatically falls
back to the heuristic bridge enumeration (exe-path/display-name detection;
unnamed apps appear as generic **App** knobs without icons). No other
functionality depends on it — the master knob and device toggling always
work through the bridge.

### Icons

`imgs/*.svg` are hand-written (a deliberate SVG subset: rect, circle,
ellipse, polygon, path with M/L/H/V/C/S/Q/T/A/Z, fill/stroke).
`tools/make-icons.mjs` is a **zero-dependency** rasterizer + PNG encoder
(Node built-ins only: `fs` + `zlib`) that regenerates the PNGs:

```
node tools/make-icons.mjs           # regenerate imgs/*.png
node tools/make-icons.mjs --check   # decode + pixel-verify every PNG
```

---

## Development & validation

```powershell
# 1. Regenerate + verify icons
node tools/make-icons.mjs --check

# 2. Bridge sanity check against real Windows audio (~0.5s)
powershell -ExecutionPolicy Bypass -File tools\test-bridge.ps1

# 3. Headless harness: simulates willAppear/dialRotate/keyDown on the
#    knob manager with a fake websocket + fake audio backend
node tests\harness.mjs

# 4. Integration test: runs the REAL plugin.js + REAL audio bridge against
#    a minimal Stream Deck websocket server (changes real volume +-2% and
#    restores it)
node --experimental-websocket tests\integration.mjs
```

Logs go to `%TEMP%\volume-monitor-streamdeck.log`.

### Troubleshooting

| Symptom | Fix |
| ------- | --- |
| Plugin not loading | Restart Stream Deck after installing; check `%TEMP%\volume-monitor-streamdeck.log`. |
| No audio state | Make sure at least one render device is enabled (Bluetooth devices must be connected). |
| App knobs empty | Check the excluded-apps list; system sessions are hidden on purpose. |
| Toggle does nothing | You need ≥2 active output devices. |
| No toasts | "Notify on switch" must be enabled; toasts are best-effort (WinRT → NotifyIcon fallback). |

---

## License / credits

Port of [Tech127x/volume-monitor](https://github.com/Tech127x/volume-monitor)
behavior (MIT) to a standalone Stream Deck plugin. Same author.
