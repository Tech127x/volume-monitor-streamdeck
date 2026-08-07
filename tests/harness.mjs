#!/usr/bin/env node
/**
 * Headless harness for the Volume Monitor Stream Deck plugin core.
 *
 * Simulates the Stream Deck websocket (a recording "ws") and the Windows
 * audio backend (an in-memory FakeBridge), then drives willAppear /
 * dialRotate / dialDown / touchTap / keyDown / didReceiveGlobalSettings
 * through the knob manager and asserts the feedback the plugin would send.
 *
 * Run: node tests/harness.mjs
 */
'use strict';

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const coreModule = require(path.join(__dirname, '..', 'com.tech127x.volume-monitor.sdPlugin', 'lib', 'core.js'));
const { VolumeMonitorCore, ACTIONS } = coreModule;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  PASS  ' + name);
  } else {
    failed++;
    console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  }
}

// ---------------------------------------------------------------------------
// Fake audio backend
// ---------------------------------------------------------------------------

class FakeBridge {
  constructor() {
    this.master = { device: 'Speakers', deviceId: 'dev-speakers', muted: false, volume: 40 };
    this.deviceList = [
      { id: 'dev-speakers', name: 'Speakers' },
      { id: 'dev-headphones', name: 'Headphones (Q30)' },
    ];
    this.sessionList = [
      { id: 's1', app: 'Spotify', display: '', pid: 100, volume: 60, muted: false },
      { id: 's2', app: 'chrome', display: 'YouTube - Best of 2026', pid: 200, volume: 40, muted: false },
    ];
    this.toasts = [];
    this.defaultCalls = [];
    this.volCalls = [];
  }

  _findSession(id) {
    return this.sessionList.find((s) => s.id === id) || null;
  }

  async state() {
    return {
      ok: true,
      device: this.master.device,
      deviceId: this.master.deviceId,
      muted: this.master.muted,
      volume: this.master.volume,
    };
  }
  async setVolume(pct) {
    this.master.volume = pct;
    this.volCalls.push(['master', pct]);
    return { ok: true };
  }
  async setMute(muted) {
    this.master.muted = muted;
    return { ok: true };
  }
  async devices() {
    return { ok: true, devices: this.deviceList };
  }
  async sessions() {
    return { ok: true, sessions: this.sessionList };
  }
  async setSessionVolume(id, pct) {
    const s = this._findSession(id);
    if (!s) return { ok: false, error: 'not found' };
    s.volume = pct;
    this.volCalls.push([id, pct]);
    return { ok: true };
  }
  async setSessionMute(id, muted) {
    const s = this._findSession(id);
    if (!s) return { ok: false, error: 'not found' };
    s.muted = muted;
    return { ok: true };
  }
  async sessionState(id) {
    const s = this._findSession(id);
    if (!s) return { ok: false, error: 'not found' };
    return { ok: true, volume: s.volume, muted: s.muted };
  }
  async setDefault(id) {
    const d = this.deviceList.find((x) => x.id === id);
    if (!d) return { ok: false, error: 'unknown device' };
    this.master.deviceId = id;
    this.master.device = d.name;
    this.defaultCalls.push(id);
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Fake websocket: records everything the core sends
// ---------------------------------------------------------------------------

class FakeWs {
  constructor() {
    this.sent = [];
  }
  send(str) {
    this.sent.push(JSON.parse(str));
  }
  all(event) {
    return this.sent.filter((m) => m.event === event);
  }
  last(event) {
    const arr = this.all(event);
    return arr.length ? arr[arr.length - 1] : null;
  }
  lastFeedback(context) {
    const arr = this.sent.filter((m) => m.event === 'setFeedback' && m.context === context);
    return arr.length ? arr[arr.length - 1] : null;
  }
}

// Router that is always unavailable: the bridge-mode section of this
// harness must not depend on whether the real Elgato service is running.
class DownRouter {
  constructor() {
    this.available = false;
    this.icons = new Map();
  }
  async connect() {
    return false;
  }
  async listApps() {
    throw new Error('audio router unavailable');
  }
  async iconFor() {
    return '';
  }
  async appState() {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Test run
// ---------------------------------------------------------------------------

async function main() {
  console.log('Volume Monitor core harness\n');

  const ws = new FakeWs();
  const bridge = new FakeBridge();
  let now = 1_000_000;

  const core = new VolumeMonitorCore({
    pluginUUID: 'com.tech127x.volume-monitor',
    pluginDir: path.join(__dirname, '..', 'com.tech127x.volume-monitor.sdPlugin'),
    send: (str) => ws.send(str),
    bridge,
    router: new DownRouter(),
    settings: {},
    log: { debug() {}, info() {}, warn() {}, error() {} },
    now: () => now,
  });
  // Capture toasts instead of spawning PowerShell.
  core._toast = (title, body) => bridge.toasts.push({ title, body });

  // --- 1. settings arrive -------------------------------------------------
  core.onEvent({
    event: 'didReceiveGlobalSettings',
    payload: {
      settings: { excludeApps: ['svchost', 'audiodg', 'background', 'system sounds'], pollInterval: 100, notifyOnSwitch: true },
    },
  });

  // --- 2. willAppear: master + three app knobs + toggle --------------------
  core.onEvent({ event: 'willAppear', action: ACTIONS.MASTER, context: 'M1', payload: { settings: {} } });
  core.onEvent({ event: 'willAppear', action: ACTIONS.APP_KNOB, context: 'A1', payload: { settings: {} } });
  core.onEvent({ event: 'willAppear', action: ACTIONS.APP_KNOB, context: 'A2', payload: { settings: {} } });
  core.onEvent({ event: 'willAppear', action: ACTIONS.APP_KNOB, context: 'A3', payload: { settings: {} } });
  core.onEvent({ event: 'willAppear', action: ACTIONS.TOGGLE, context: 'T1', payload: { settings: {} } });
  await core.flush();

  // Auto-assigned knob slots (2, 3, 4 in appearance order).
  const slotFor = (ctx) => core.slotForContext.get(ctx);
  check('auto slots assigned 2/3/4', slotFor('A1') === 2 && slotFor('A2') === 3 && slotFor('A3') === 4,
    `got A1=${slotFor('A1')} A2=${slotFor('A2')} A3=${slotFor('A3')}`);

  // --- 3. first poll assigns streams to knobs ------------------------------
  await core.tick(now);
  const fA1 = ws.lastFeedback('A1');
  const fA2 = ws.lastFeedback('A2');
  const fA3 = ws.lastFeedback('A3');
  check('knob 2 shows Spotify', fA1 && fA1.payload.title === 'Spotify', fA1 && fA1.payload.title);
  check('knob 2 volume 24% (safe default)', fA1 && fA1.payload.value === '24%', fA1 && fA1.payload.value);
  check('knob 3 shows chrome tab title', fA2 && fA2.payload.title === 'chrome: YouTube - Best of 2026', fA2 && fA2.payload.title);
  check('knob 4 empty', fA3 && fA3.payload.value === '\u2014', fA3 && fA3.payload.value);
  check('layout is $B1', fA1 && fA1.payload.layout === '$B1', fA1 && fA1.payload.layout);

  const fM1 = ws.lastFeedback('M1');
  check('master shows device', fM1 && fM1.payload.title === 'Speakers', fM1 && fM1.payload.title);
  check('master volume 50% (first-run default)', fM1 && fM1.payload.value === '50%', fM1 && fM1.payload.value);
  check('master indicator 0.5', fM1 && Math.abs(fM1.payload.indicator - 0.5) < 0.01, fM1 && fM1.payload.indicator);

  // --- 4. dialRotate on master (2% per tick) -------------------------------
  core.onEvent({ event: 'dialRotate', action: ACTIONS.MASTER, context: 'M1', payload: { ticks: 2 } });
  await core.flush();
  check('master setvol to 54 (from 50)', bridge.master.volume === 54, 'got ' + bridge.master.volume);
  check('master feedback 54%', ws.lastFeedback('M1').payload.value === '54%', ws.lastFeedback('M1').payload.value);

  // --- 5. dialRotate on an app knob ----------------------------------------
  core.onEvent({ event: 'dialRotate', action: ACTIONS.APP_KNOB, context: 'A1', payload: { ticks: -3 } });
  await core.flush();
  check('spotify volume 18 (from 24%, -6)', bridge.sessionList[0].volume === 18, 'got ' + bridge.sessionList[0].volume);
  check('knob 2 feedback 18%', ws.lastFeedback('A1').payload.value === '18%', ws.lastFeedback('A1').payload.value);
  const globalSaves = ws.all('setGlobalSettings');
  const lastSave = globalSaves[globalSaves.length - 1];
  check('volume memory saved (spotify 18)',
    lastSave && lastSave.payload && lastSave.payload.volumeMemory && lastSave.payload.volumeMemory.spotify === 18,
    JSON.stringify(lastSave && lastSave.payload));

  // --- 6. dialDown: mute master + app --------------------------------------
  core.onEvent({ event: 'dialDown', action: ACTIONS.MASTER, context: 'M1' });
  await core.flush();
  check('master muted', bridge.master.muted === true, 'got ' + bridge.master.muted);
  check('master feedback MUTED', ws.lastFeedback('M1').payload.value === 'MUTED', ws.lastFeedback('M1').payload.value);

  core.onEvent({ event: 'dialDown', action: ACTIONS.APP_KNOB, context: 'A2' });
  await core.flush();
  check('chrome session muted', bridge.sessionList[1].muted === true, 'got ' + bridge.sessionList[1].muted);
  check('knob 3 feedback MUTED', ws.lastFeedback('A2').payload.value === 'MUTED', ws.lastFeedback('A2').payload.value);

  // --- 6b. touchTap on the display toggles mute (same as a dial press) ------
  core.onEvent({ event: 'touchTap', action: ACTIONS.MASTER, context: 'M1', payload: { hold: false, tapPos: [50, 50] } });
  await core.flush();
  check('touchTap unmutes master', bridge.master.muted === false, 'got ' + bridge.master.muted);
  check('master feedback restored after tap', ws.lastFeedback('M1').payload.value === '54%', ws.lastFeedback('M1').payload.value);

  core.onEvent({ event: 'touchTap', action: ACTIONS.APP_KNOB, context: 'A2', payload: { hold: false, tapPos: [50, 50] } });
  await core.flush();
  check('touchTap unmutes chrome session', bridge.sessionList[1].muted === false, 'got ' + bridge.sessionList[1].muted);
  check('knob 3 feedback restored after tap', ws.lastFeedback('A2').payload.value === '24%', ws.lastFeedback('A2').payload.value);

  // --- 7. new app appears at 100% -> safe default of 24% --------------------
  bridge.sessionList.push({ id: 's3', app: 'Discord', display: '', pid: 300, volume: 100, muted: false });
  now += 100;
  await core.tick(now);
  check('new app Discord defaulted to 24%', bridge.sessionList[2].volume === 24, 'got ' + bridge.sessionList[2].volume);
  check('Discord on knob 4', ws.lastFeedback('A3').payload.title === 'Discord', ws.lastFeedback('A3').payload.title);

  // Known app volume is NOT overwritten by the poll.
  check('Spotify still 18 after poll', bridge.sessionList[0].volume === 18, 'got ' + bridge.sessionList[0].volume);

  // --- 8. app closes -> grace -> compaction --------------------------------
  bridge.sessionList = bridge.sessionList.filter((s) => s.id !== 's2'); // chrome gone
  now += 200; // within 500ms grace
  await core.tick(now);
  check('chrome knob 3 ghosted during grace', ws.lastFeedback('A2').payload.title === 'chrome: YouTube - Best of 2026', ws.lastFeedback('A2').payload.title);

  now += 500; // grace expired
  await core.tick(now);
  check('compaction: Discord moved to knob 3', ws.lastFeedback('A2').payload.title === 'Discord', ws.lastFeedback('A2').payload.title);
  check('knob 4 empty after compaction', ws.lastFeedback('A3').payload.value === '\u2014', ws.lastFeedback('A3').payload.value);

  // --- 9. toggle device -----------------------------------------------------
  core.onEvent({ event: 'keyDown', action: ACTIONS.TOGGLE, context: 'T1' });
  await sleep(600); // allow the post-toggle refresh tick
  check('toggle set default to headphones', bridge.defaultCalls[bridge.defaultCalls.length - 1] === 'dev-headphones', JSON.stringify(bridge.defaultCalls));
  const t1 = ws.sent.filter((m) => m.event === 'setTitle' && m.context === 'T1');
  const lastTitle = t1.length ? t1[t1.length - 1].payload.title : null;
  check('toggle title shows mapped device name', lastTitle === 'soundcore Q30', lastTitle);
  check('toggle fired a toast', bridge.toasts.some((t) => t.title === 'Audio Output Switched' && t.body.includes('Headphones')), JSON.stringify(bridge.toasts));

  // --- 10. exclusion patterns apply -----------------------------------------
  core.onEvent({
    event: 'didReceiveGlobalSettings',
    payload: { settings: { excludeApps: ['svchost', 'audiodg', 'background', 'system sounds', 'spotify'] } },
  });
  bridge.sessionList.push({ id: 's4', app: 'svchost', display: 'System Sounds', pid: 4, volume: 100, muted: false });
  now += 100;
  await core.tick(now);
  check('excluded app hidden from knobs', ws.lastFeedback('A3').payload.value === '\u2014', ws.lastFeedback('A3').payload.value);

  // --- 11. explicit knob slot via settings ----------------------------------
  core.onEvent({ event: 'willAppear', action: ACTIONS.APP_KNOB, context: 'A4', payload: { settings: { knob: 4 } } });
  await core.flush();
  check('explicit knob slot honored', slotFor('A4') === 4, 'got ' + slotFor('A4'));

  // --- 12. unnamed sessions (no icon/display, like VST hosts/games) ---------
  bridge.sessionList = bridge.sessionList.filter((s) => s.app !== 'svchost');
  bridge.sessionList.push({ id: 's6', app: '', display: 'App', pid: 0, volume: 37, muted: false });
  bridge.sessionList.push({ id: 's7', app: '', display: 'App', pid: 0, volume: 64, muted: false });
  now += 100;
  await core.tick(now);
  const fS6 = ws.lastFeedback('A3');
  check('unnamed app shown on a knob', fS6 && fS6.payload.title === 'App' && fS6.payload.value === '37%', fS6 && JSON.stringify(fS6.payload));
  check('unnamed app volume NOT auto-set', bridge.sessionList.find((s) => s.id === 's6').volume === 37, 'got ' + bridge.sessionList.find((s) => s.id === 's6').volume);

  // Two unnamed apps -> disambiguated labels (advance past the 500ms grace)
  bridge.sessionList = bridge.sessionList.filter((s) => s.id === 's6' || s.id === 's7');
  now += 600;
  await core.tick(now);
  check('two unnamed apps disambiguated',
    ws.lastFeedback('A1').payload.title === 'App' && ws.lastFeedback('A2').payload.title === 'App (2)',
    ws.lastFeedback('A1').payload.title + ' / ' + ws.lastFeedback('A2').payload.title);

  // --------------------------------------------------------------------------
  // --- 13. Elgato audio router source: real names + icons + per-app volume ---
  // --------------------------------------------------------------------------
  console.log('\n-- audio router mode --');
  class FakeRouter {
    constructor() {
      this.apps = [
        { processID: 6032, executableFile: 'C:\\Users\\sean\\AppData\\Local\\Programs\\VacuumTube\\VacuumTube.exe', displayName: 'VacuumTube', activity: 2, mute: false, volume: 0.28 },
        { processID: 20832, executableFile: 'C:\\Program Files\\Ablaze Floorp\\floorp.exe', displayName: 'Ablaze Floorp', activity: 2, mute: false, volume: 0.04 },
        { processID: 13684, executableFile: 'C:\\Program Files (x86)\\Steam\\steam.exe', displayName: '', activity: 4, mute: false, volume: 0.4 },
      ];
      this.available = true;
      this.icons = new Map();
      this.volCalls = [];
      this.muteCalls = [];
    }
    async connect() {
      return this.available;
    }
    async listApps() {
      if (!this.available) throw new Error('unavailable');
      return this.apps;
    }
    async iconFor(pid) {
      return this.icons.get(pid) || '';
    }
    async setVolume(pid, v) {
      const a = this.apps.find((x) => x.processID === pid);
      if (a) a.volume = v;
      this.volCalls.push([pid, v]);
      return {};
    }
    async setMute(pid, m) {
      const a = this.apps.find((x) => x.processID === pid);
      if (a) a.mute = m;
      this.muteCalls.push([pid, m]);
      return {};
    }
    async appState(pid) {
      const a = this.apps.find((x) => x.processID === pid);
      return a ? { volume: a.volume } : null;
    }
  }

  const ws2 = new FakeWs();
  const router = new FakeRouter();
  router.icons.set(6032, 'data:image/png;base64,FAKEVACUUMTUBE');
  const core2 = new VolumeMonitorCore({
    pluginUUID: 'com.tech127x.volume-monitor',
    pluginDir: path.join(__dirname, '..', 'com.tech127x.volume-monitor.sdPlugin'),
    send: (str) => ws2.send(str),
    bridge,
    router,
    settings: { defaultVolume: 50, pollInterval: 100, notifyOnSwitch: true },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    now: () => now,
  });
  core2._toast = () => {};
  core2.onEvent({ event: 'didReceiveGlobalSettings', payload: { settings: { excludeApps: ['svchost', 'audiodg', 'background', 'system sounds'] } } });
  core2.onEvent({ event: 'willAppear', action: ACTIONS.MASTER, context: 'R-M', payload: { settings: {} } });
  core2.onEvent({ event: 'willAppear', action: ACTIONS.APP_KNOB, context: 'R-A1', payload: { settings: {} } });
  core2.onEvent({ event: 'willAppear', action: ACTIONS.APP_KNOB, context: 'R-A2', payload: { settings: {} } });
  core2.onEvent({ event: 'willAppear', action: ACTIONS.APP_KNOB, context: 'R-A3', payload: { settings: {} } });
  await core2.flush();
  await core2.tick(now);
  await sleep(50); // let icon fetches resolve

  const r1 = ws2.lastFeedback('R-A1');
  const r2 = ws2.lastFeedback('R-A2');
  const r3 = ws2.lastFeedback('R-A3');
  check('router: knob 2 = VacuumTube (real name)', r1 && r1.payload.title === 'VacuumTube', r1 && r1.payload.title);
  check('router: VacuumTube volume set to safe default 50%', r1 && r1.payload.value === '50%', r1 && r1.payload.value);
  check('router: knob 2 shows the app icon', r1 && r1.payload.icon === 'data:image/png;base64,FAKEVACUUMTUBE', r1 && String(r1.payload.icon).slice(0, 40));
  check('router: knob 3 = Floorp display name', r2 && r2.payload.title === 'Ablaze Floorp', r2 && r2.payload.title);
  check('router: knob 4 = Steam (prettified from exe)', r3 && r3.payload.title === 'Steam', r3 && r3.payload.title);

  // Router volume change + memory
  core2.onEvent({ event: 'dialRotate', action: ACTIONS.APP_KNOB, context: 'R-A1', payload: { ticks: 1 } });
  await core2.flush();
  check('router: rotate calls setVolume(6032, 0.52)', router.volCalls.some((c) => c[0] === 6032 && Math.abs(c[1] - 0.52) < 0.001), JSON.stringify(router.volCalls));
  check('router: knob 2 feedback 52%', ws2.lastFeedback('R-A1').payload.value === '52%', ws2.lastFeedback('R-A1').payload.value);
  const rSaves = ws2.all('setGlobalSettings');
  const rSave = rSaves[rSaves.length - 1];
  check('router: volume memory saved (vacuumtube 52)',
    rSave && rSave.payload && rSave.payload.volumeMemory && rSave.payload.volumeMemory.vacuumtube === 52,
    JSON.stringify(rSave && rSave.payload && rSave.payload.volumeMemory));

  // Router mute
  core2.onEvent({ event: 'dialDown', action: ACTIONS.APP_KNOB, context: 'R-A1' });
  await core2.flush();
  check('router: mute calls setMute(6032, true)', router.muteCalls.some((c) => c[0] === 6032 && c[1] === true), JSON.stringify(router.muteCalls));
  check('router: knob 2 feedback MUTED', ws2.lastFeedback('R-A1').payload.value === 'MUTED', ws2.lastFeedback('R-A1').payload.value);

  // Router touchTap on the display toggles mute too
  core2.onEvent({ event: 'touchTap', action: ACTIONS.APP_KNOB, context: 'R-A1', payload: { hold: false, tapPos: [50, 50] } });
  await core2.flush();
  check('router: touchTap calls setMute(6032, false)', router.muteCalls.some((c) => c[0] === 6032 && c[1] === false), JSON.stringify(router.muteCalls));
  check('router: knob 2 feedback unmuted 52%', ws2.lastFeedback('R-A1').payload.value === '52%', ws2.lastFeedback('R-A1').payload.value);

  // Icon must be stable across polls (no wave/app flicker)
  for (let i = 0; i < 3; i++) {
    await core2.tick(now);
    await sleep(20);
  }
  const APP_ICON = 'data:image/png;base64,FAKEVACUUMTUBE';
  const lastIcon = ws2.lastFeedback('R-A1').payload.icon;
  check('router: icon stable across polls (no wave flicker)',
    lastIcon === APP_ICON,
    String(lastIcon).slice(0, 40));
  const fbs = ws2.sent.filter((m) => m.event === 'setFeedback' && m.context === 'R-A1');
  const firstIconIdx = fbs.findIndex((m) => m.payload.icon === APP_ICON);
  const waveAfterIcon = firstIconIdx >= 0
    ? fbs.slice(firstIconIdx + 1).filter((m) => m.payload.icon !== APP_ICON)
    : [];
  check('router: no wave-icon feedback after first icon push',
    firstIconIdx >= 0 && waveAfterIcon.length === 0,
    'wave pushes after icon: ' + waveAfterIcon.length);

  // Fallback: router goes away -> bridge heuristic takes over (past grace)
  router.available = false;
  now += 600;
  bridge.sessionList = [{ id: 's9', app: 'Spotify', display: '', pid: 0, volume: 40, muted: false }];
  await core2.tick(now);
  check('router: falls back to bridge sessions when unavailable', ws2.lastFeedback('R-A1').payload.title === 'Spotify', ws2.lastFeedback('R-A1').payload.title);

  // --------------------------------------------------------------------------
  console.log('\n' + (failed === 0 ? 'ALL TESTS PASSED' : failed + ' TEST(S) FAILED') + `  (${passed} passed, ${failed} failed)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('harness crashed:', err);
  process.exit(1);
});
