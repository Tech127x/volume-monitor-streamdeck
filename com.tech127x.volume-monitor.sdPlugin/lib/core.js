'use strict';
/**
 * VolumeMonitorCore — platform-independent plugin logic for the Volume
 * Monitor Stream Deck plugin. Speaks the Stream Deck websocket protocol
 * through an injected `send` function and talks to Windows audio through an
 * injected bridge (AudioBridge or a fake in tests).
 *
 * Actions:
 *   master   (dial)  device name + %, rotate = volume, press/tap = mute
 *   appknob  (dial)  auto-assigned apps on knobs 2-4 (compaction, grace,
 *                    per-app volume memory, 50% safe default, restore;
 *                    press/tap = mute)
 *   toggle   (key)   cycles the default audio device, shows it as title
 *
 * "Tap" = touching the Stream Deck+ touchscreen display above a dial
 * (touchTap event), which toggles mute exactly like pressing the dial.
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { KnobManager } = require('./knob-manager');
const { VolumeMemory } = require('./volume-memory');
const { AudioRouter } = require('./audio-router');
const {
  clampVolume,
  normDeviceName,
  isExcludedApp,
  streamDedupeKey,
  streamDisplayName,
  disambiguateLabel,
  normalizeName,
} = require('./device-utils');

const ACTIONS = {
  MASTER: 'com.tech127x.volume-monitor.master',
  APP_KNOB: 'com.tech127x.volume-monitor.appknob',
  TOGGLE: 'com.tech127x.volume-monitor.toggle',
};

const APP_SLOT_FIRST = 2;
const APP_SLOT_LAST = 4;
const STREAM_VOLUME_RESTORE_HIGH = 95; // above this -> treat as "needs restore"
const DEFAULT_NEW_APP_VOLUME = 24; // Linux's 50% is too loud on Windows
const DEFAULT_MASTER_VOLUME = 50; // first-run default for the master volume
const VOLUME_STEP_PER_TICK = 2;
const RESTORE_ATTEMPTS = 6;

const DEFAULT_SETTINGS = {
  excludeApps: ['svchost', 'audiodg', 'background', 'system sounds'],
  defaultVolume: 24, // new-app default (editable; each app resumes its own level)
  pollInterval: 100, // ms
  notifyOnSwitch: true,
  volumeMemory: {},
  knobSlots: {}, // plugin-owned: context -> slot (persisted auto-assign)
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "C:\...\VacuumTube.exe" -> "VacuumTube" */
function prettifyExe(exe) {
  const base = String(exe || '').split(/[\\/]/).pop() || '';
  const stem = base.replace(/\.exe$/i, '');
  return stem
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

class VolumeMonitorCore {
  /**
   * @param {object} opts
   * @param {string} opts.pluginUUID
   * @param {string} opts.pluginDir absolute plugin folder
   * @param {(obj: object) => void} opts.send websocket sender
   * @param {object} opts.bridge AudioBridge-like instance
   * @param {object} [opts.settings] initial global settings
   * @param {object} [opts.log]
   * @param {() => number} [opts.now] clock (testability)
   */
  constructor({ pluginUUID, pluginDir, send, bridge, settings, log, now, router }) {
    this.pluginUUID = pluginUUID;
    this.pluginDir = pluginDir;
    this.send = send;
    this.bridge = bridge;
    this.log = log;
    this.now = now || (() => Date.now());
    this.router = router || new AudioRouter({ log });

    this.settings = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    this.settings.volumeMemory = this.settings.volumeMemory || {};
    this.settings.knobSlots = this.settings.knobSlots || {};

    this.memory = new VolumeMemory(this.settings, () => this._persistSettings());
    this.knobs = new KnobManager({ firstSlot: APP_SLOT_FIRST, lastSlot: APP_SLOT_LAST });

    // Context registries
    this.instances = new Map(); // context -> { action }
    this.masterContexts = new Set();
    this.appKnobContexts = new Set();
    this.toggleContexts = new Set();
    this.slotForContext = new Map(); // appknob context -> slot (2..4)

    // State
    this.lastMaster = null; // { device, deviceId, muted, volume }
    this._masterInitialized = false; // first-run default/resume applied once
    this.lastFeedback = new Map(); // context -> payload signature
    this.seenKeys = new Set();
    this.lastStreamIdByKey = new Map();
    this.lastSessionsSig = '';
    this._polling = false;
    this._timer = null;
    this._tickLock = false;

    // Icons (data URIs so feedback is self-contained)
    this.icons = this._loadIcons();
  }

  _loadIcons() {
    const read = (name) => {
      try {
        const p = path.join(this.pluginDir, 'imgs', name);
        return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
      } catch {
        return '';
      }
    };
    return {
      speaker: read('speaker.png'),
      speakerMuted: read('speaker-muted.png'),
      wave: read('wave.png'),
      waveMuted: read('wave-muted.png'),
    };
  }

  // ------------------------------------------------------------------
  // Startup / lifecycle
  // ------------------------------------------------------------------

  start() {
    this._persistSettings(); // ensure globalSettings exists on first run
    const interval = Math.max(50, Number(this.settings.pollInterval) || 100);
    this._timer = setInterval(() => {
      this.tick().catch((err) => this._log('error', 'poll tick failed:', err));
    }, interval);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // ------------------------------------------------------------------
  // Event dispatch (Stream Deck -> plugin)
  // ------------------------------------------------------------------

  onEvent(msg) {
    switch (msg.event) {
      case 'willAppear':
        this._onWillAppear(msg);
        break;
      case 'willDisappear':
        this._onWillDisappear(msg);
        break;
      case 'dialRotate':
        this._onDialRotate(msg);
        break;
      case 'dialDown':
        this._onDialDown(msg);
        break;
      case 'touchTap':
        this._onTouchTap(msg);
        break;
      case 'keyDown':
        this._onKeyDown(msg);
        break;
      case 'didReceiveGlobalSettings':
        this._onGlobalSettings(msg.payload && msg.payload.settings);
        break;
      case 'didReceiveSettings':
        this._onActionSettings(msg);
        break;
      case 'sendToPlugin':
        this._onSendToPlugin(msg);
        break;
      case 'propertyInspectorDidAppear':
        this._pushStateToInspector(msg.context);
        break;
      default:
        break;
    }
  }

  _onWillAppear(msg) {
    const context = msg.context;
    const action = msg.action;
    this.instances.set(context, { action });

    if (action === ACTIONS.MASTER) {
      this.masterContexts.add(context);
      this._pushMasterFeedback(context, this.lastMaster);
    } else if (action === ACTIONS.APP_KNOB) {
      this.appKnobContexts.add(context);
      const settings = (msg.payload && msg.payload.settings) || {};
      let slot = Number(settings.knob) || 0;
      if (slot < APP_SLOT_FIRST || slot > APP_SLOT_LAST) {
        slot = this.settings.knobSlots[context];
        if (!slot) {
          slot = this._freeSlot();
          this.settings.knobSlots[context] = slot;
          this._persistSettings();
        }
      }
      this.slotForContext.set(context, slot);
      const stream = this.knobs.streamForSlot(slot);
      this._pushAppFeedback(context, slot, stream);
      // Kick a poll so the new knob fills immediately.
      this.tick().catch((err) => this._log('error', 'willAppear tick failed:', err));
    } else if (action === ACTIONS.TOGGLE) {
      this.toggleContexts.add(context);
      this._pushToggleTitle(context, this.lastMaster);
      this.tick().catch((err) => this._log('error', 'willAppear tick failed:', err));
    }
  }

  _onWillDisappear(msg) {
    const context = msg.context;
    this.instances.delete(context);
    this.masterContexts.delete(context);
    this.appKnobContexts.delete(context);
    this.toggleContexts.delete(context);
    this.slotForContext.delete(context);
    this.lastFeedback.delete(context);
    delete this.settings.knobSlots[context];
  }

  _freeSlot() {
    const used = new Set(this.slotForContext.values());
    for (let i = APP_SLOT_FIRST; i <= APP_SLOT_LAST; i++) {
      if (!used.has(i)) return i;
    }
    return APP_SLOT_LAST;
  }

  _onDialRotate(msg) {
    const ticks = Math.round((msg.payload && msg.payload.ticks) || 0);
    if (!ticks) return;
    if (msg.action === ACTIONS.MASTER) {
      this._rotateMaster(msg.context, ticks);
    } else if (msg.action === ACTIONS.APP_KNOB) {
      this._rotateAppKnob(msg.context, ticks);
    }
  }

  _onDialDown(msg) {
    if (msg.action === ACTIONS.MASTER) {
      this._toggleMasterMute();
    } else if (msg.action === ACTIONS.APP_KNOB) {
      this._toggleAppMute(msg.context);
    }
  }

  /**
   * Tapping the touchscreen display above a dial toggles mute, mirroring a
   * dial press (Stream Deck + "touchTap" event; payload.tapPos/hold are
   * ignored — any tap on the display of a volume action mutes/unmutes).
   */
  _onTouchTap(msg) {
    if (msg.action === ACTIONS.MASTER) {
      this._toggleMasterMute();
    } else if (msg.action === ACTIONS.APP_KNOB) {
      this._toggleAppMute(msg.context);
    }
  }

  _onKeyDown(msg) {
    if (msg.action === ACTIONS.TOGGLE) {
      this._cycleDevice();
    }
  }

  _onGlobalSettings(settings) {
    if (!settings || typeof settings !== 'object') return;
    this.settings = Object.assign({}, this.settings, settings);
    if (!this.settings.volumeMemory) this.settings.volumeMemory = {};
    if (!this.settings.knobSlots) this.settings.knobSlots = {};
    this.memory = new VolumeMemory(this.settings, () => this._persistSettings());
    this._log('info', 'global settings applied:', {
      excludeApps: this.settings.excludeApps,
      defaultVolume: this.settings.defaultVolume,
      pollInterval: this.settings.pollInterval,
      notifyOnSwitch: this.settings.notifyOnSwitch,
    });
  }

  _onActionSettings(msg) {
    const settings = (msg.payload && msg.payload.settings) || {};
    if (msg.action === ACTIONS.APP_KNOB && settings.knob) {
      const slot = Number(settings.knob);
      if (slot >= APP_SLOT_FIRST && slot <= APP_SLOT_LAST) {
        this.slotForContext.set(msg.context, slot);
        this.settings.knobSlots[msg.context] = slot;
        this._persistSettings();
        const stream = this.knobs.streamForSlot(slot);
        this._pushAppFeedback(msg.context, slot, stream);
      }
    }
  }

  async _onSendToPlugin(msg) {
    const payload = (msg && msg.payload) || {};
    const context = msg.context;
    if (payload.type === 'refresh') {
      await this.tick();
      this._pushStateToInspector(context);
    } else if (payload.type === 'getState') {
      this._pushStateToInspector(context);
    } else if (payload.type === 'testToast') {
      this._toast('Volume Monitor', 'Notifications are working.');
    }
  }

  // ------------------------------------------------------------------
  // Rotation / press / toggle handlers
  // ------------------------------------------------------------------

  async _rotateMaster(context, ticks) {
    let current = this.lastMaster && this.lastMaster.volume;
    if (current == null) {
      const st = await this.bridge.state();
      if (!st.ok || st.volume == null) return;
      current = st.volume;
    }
    const next = clampVolume(current + ticks * VOLUME_STEP_PER_TICK);
    if (next == null) return;
    const res = await this.bridge.setVolume(next);
    if (!res.ok) {
      this._log('warn', 'setvol failed:', res.error);
      return;
    }
    if (!this.lastMaster) this.lastMaster = { device: null, deviceId: null, muted: false, volume: next };
    else this.lastMaster = Object.assign({}, this.lastMaster, { volume: next, muted: false });
    // Remember the level so the next session resumes it.
    this.settings.volumeMemory.master = next;
    this._persistSettings();
    // Suppress poll overwrites for a short window so an in-flight poll with
    // a pre-rotate read cannot clobber the just-applied volume.
    this._masterSetAt = Date.now();
    for (const ctx of this.masterContexts) this._pushMasterFeedback(ctx, this.lastMaster);
  }

  async _rotateAppKnob(context, ticks) {
    const slot = this.slotForContext.get(context);
    if (slot == null) return;
    const stream = this.knobs.streamForSlot(slot);
    if (!stream || !stream.id) return;
    const current = stream.volume != null ? stream.volume : DEFAULT_NEW_APP_VOLUME;
    const next = clampVolume(current + ticks * VOLUME_STEP_PER_TICK);
    if (next == null) return;
    const res = stream.router
      ? await this.router.setVolume(stream.pid, next / 100)
      : await this.bridge.setSessionVolume(stream.id, next);
    if (!res || (res.ok === false)) {
      this._log('warn', 'set app volume failed:', res && res.error);
      return;
    }
    stream.volume = next;
    stream.muted = false;
    this.memory.set(stream, next);
    for (const [ctx, s] of this.slotForContext) {
      if (s === slot) this._pushAppFeedback(ctx, slot, stream);
    }
  }

  /**
   * One-time master volume default/resume. First run (no remembered value):
   * apply DEFAULT_MASTER_VOLUME. Afterwards: restore whatever the user last
   * set via the dial. Returns the applied volume, or null when unchanged.
   */
  async _ensureMasterDefault(current) {
    const remembered = this.settings.volumeMemory.master;
    const target = clampVolume(remembered != null ? remembered : DEFAULT_MASTER_VOLUME);
    if (target == null) return null;
    if (current == null || Math.abs(current - target) <= 1) {
      if (remembered == null) {
        this.settings.volumeMemory.master = target;
        this._persistSettings();
      }
      return null;
    }
    const res = await this.bridge.setVolume(target);
    if (!res.ok) {
      this._log('warn', 'master default set failed:', res.error);
      return null;
    }
    this.settings.volumeMemory.master = target;
    this._persistSettings();
    this._log(
      'info',
      remembered == null ? 'master volume initialized to' : 'master volume resumed to',
      target + '%'
    );
    return target;
  }

  async _toggleMasterMute() {
    const muted = this.lastMaster ? !this.lastMaster.muted : true;
    const res = await this.bridge.setMute(muted);
    if (!res.ok) {
      this._log('warn', 'mute failed:', res.error);
      return;
    }
    if (!this.lastMaster) this.lastMaster = { device: null, deviceId: null, muted, volume: null };
    else this.lastMaster = Object.assign({}, this.lastMaster, { muted });
    for (const ctx of this.masterContexts) this._pushMasterFeedback(ctx, this.lastMaster);
  }

  async _toggleAppMute(context) {
    const slot = this.slotForContext.get(context);
    if (slot == null) return;
    const stream = this.knobs.streamForSlot(slot);
    if (!stream || !stream.id) return;
    const muted = !stream.muted;
    const res = stream.router
      ? await this.router.setMute(stream.pid, muted)
      : await this.bridge.setSessionMute(stream.id, muted);
    if (!res || (res.ok === false)) {
      this._log('warn', 'set app mute failed:', res && res.error);
      return;
    }
    stream.muted = muted;
    for (const [ctx, s] of this.slotForContext) {
      if (s === slot) this._pushAppFeedback(ctx, slot, stream);
    }
  }

  async _cycleDevice() {
    const st = await this.bridge.state();
    if (!st.ok || !st.deviceId) {
      this._log('warn', 'toggle: no default device:', st.error);
      return;
    }
    const devs = await this.bridge.devices();
    if (!devs.ok || !Array.isArray(devs.devices) || devs.devices.length < 2) {
      this._log('warn', 'toggle: need at least 2 devices');
      return;
    }
    let idx = devs.devices.findIndex((d) => d.id === st.deviceId);
    if (idx < 0) idx = -1;
    const next = devs.devices[(idx + 1) % devs.devices.length];
    const res = await this.bridge.setDefault(next.id);
    if (!res.ok) {
      this._log('warn', 'setdefault failed:', res.error);
      return;
    }
    const name = next.name || next.id;
    this._log('info', 'switched default device to', name);
    if (this.settings.notifyOnSwitch) {
      this._toast('Audio Output Switched', 'Changed to: ' + name);
    }
    // The default endpoint change is asynchronous; refresh shortly after.
    setTimeout(() => {
      this.tick().catch((err) => this._log('error', 'post-toggle tick failed:', err));
    }, 400);
  }

  // ------------------------------------------------------------------
  // Polling
  // ------------------------------------------------------------------

  async tick(nowMs) {
    if (this._tickLock) return;
    this._tickLock = true;
    const now = nowMs != null ? nowMs : this.now();
    try {
      const wantMaster = this.masterContexts.size > 0 || this.toggleContexts.size > 0;
      const wantApps = this.appKnobContexts.size > 0;

      if (wantMaster) await this._pollMaster();
      if (wantApps) await this._pollAppKnobs(now);
    } finally {
      this._tickLock = false;
    }
  }

  /** Wait for any in-flight tick to finish (used by tests). */
  async flush() {
    while (this._tickLock) await sleep(5);
  }

  async _pollMaster() {
    // Right after a rotation the cached value is authoritative; skip one
    // poll cycle so a stale pre-rotate read can't clobber it.
    if (this._masterSetAt && Date.now() - this._masterSetAt < 150) return;
    const st = await this.bridge.state();
    if (!st.ok) {
      if (!this.lastMaster) {
        const none = { device: 'No Audio Device', deviceId: null, muted: false, volume: null };
        for (const ctx of this.masterContexts) this._pushMasterFeedback(ctx, none);
        for (const ctx of this.toggleContexts) this._pushToggleTitle(ctx, none);
      }
      return;
    }
    const state = {
      device: st.device || 'Unknown',
      deviceId: st.deviceId,
      muted: !!st.muted,
      volume: clampVolume(st.volume),
    };
    const deviceChanged =
      !this.lastMaster || this.lastMaster.deviceId !== state.deviceId;
    const first = !this.lastMaster;
    this.lastMaster = state;

    // First run: apply the 50% master default; afterwards resume the level
    // the user last set (once per session — no caps, nothing forced later).
    if (!this._masterInitialized) {
      this._masterInitialized = true;
      const applied = await this._ensureMasterDefault(state.volume);
      if (applied != null) state.volume = applied;
    }

    if (deviceChanged && !first && this.settings.notifyOnSwitch && state.deviceId) {
      this._toast('Audio Output Switched', 'Changed to: ' + normDeviceName(state.device));
    }
    for (const ctx of this.masterContexts) this._pushMasterFeedback(ctx, state);
    for (const ctx of this.toggleContexts) this._pushToggleTitle(ctx, state);
  }

  async _pollAppKnobs(now) {
    let streams = null;

    // Preferred: the Elgato audio router (real names, exe paths, icons).
    if (this.router) {
      try {
        streams = await this._routerStreams();
      } catch (err) {
        this._log('debug', 'audio router unavailable, using bridge sessions:', err.message);
        streams = null;
      }
    }

    // Fallback: heuristic session enumeration through the bridge.
    if (!streams) {
      const res = await this.bridge.sessions();
      if (!res.ok || !Array.isArray(res.sessions)) {
        this._log('warn', 'sessions failed:', res.error);
        return;
      }
      streams = this._normalizeSessions(res.sessions);
    }

    this.knobs.track(streams, now);

    // Safe defaults + volume restore for newly seen streams.
    for (const s of streams) {
      try {
        await this._ensureVolume(s);
      } catch (err) {
        this._log('debug', 'ensureVolume failed for', s.id, err.message);
      }
    }

    const slots = this.knobs.assign(streams, now);

    // Disambiguate duplicate labels across the visible slots (e.g. two
    // unnamed apps both labeled "App").
    const usedLabels = new Set();
    this._slotLabels = {};
    for (let i = APP_SLOT_FIRST; i <= APP_SLOT_LAST; i++) {
      const s = slots[i];
      if (!s) continue;
      let label = s.displayName;
      if (usedLabels.has(label)) label = disambiguateLabel(label, s, usedLabels);
      usedLabels.add(label);
      this._slotLabels[i] = label;
    }

    // Push feedback for every visible appknob instance.
    for (const [ctx, slot] of this.slotForContext) {
      const stream = slots[slot] || null;
      this._pushAppFeedback(ctx, slot, stream);
    }

    // Fetch app icons for slotted router streams (async, cached by pid).
    for (let i = APP_SLOT_FIRST; i <= APP_SLOT_LAST; i++) {
      const s = slots[i];
      if (s && s.router && !s.iconData) {
        const slot = i;
        this.router
          .iconFor(s.pid)
          .then((uri) => {
            s.iconData = uri || '';
            if (s.iconData) {
              for (const [ctx, s2] of this.slotForContext) {
                if (s2 === slot) this._pushAppFeedback(ctx, slot, s);
              }
            }
          })
          .catch(() => {});
      }
    }
  }

  /**
   * App instances from the Elgato audio router, normalized to the same
   * stream shape the knob manager expects (one entry per app/process).
   */
  async _routerStreams() {
    if (!this.router.available) {
      await this.router.connect();
    }
    if (!this.router.available) throw new Error('audio router unavailable');
    const apps = await this.router.listApps();
    const exclude = Array.isArray(this.settings.excludeApps)
      ? this.settings.excludeApps
      : DEFAULT_SETTINGS.excludeApps;
    const out = [];
    for (const a of apps) {
      const name = (a.displayName || prettifyExe(a.executableFile) || '').trim();
      if (!name || isExcludedApp(name, exclude)) continue;
      const stream = {
        id: 'pid:' + a.processID,
        pid: a.processID,
        app: name,
        display: a.displayName || '',
        exe: a.executableFile || '',
        volume: clampVolume(Math.round((a.volume || 0) * 100)),
        muted: !!a.mute,
        router: true,
      };
      stream.displayName = name;
      stream.dedupeKey = 'app:' + normalizeName(name);
      // Icon from the sync cache (avoid wave->app flicker while the async
      // fetch resolves — streams are rebuilt on every poll).
      if (this.router.icons.has(a.processID)) {
        stream.iconData = this.router.icons.get(a.processID);
      }
      out.push(stream);
    }
    return out;
  }

  _normalizeSessions(rawSessions) {
    const exclude = Array.isArray(this.settings.excludeApps)
      ? this.settings.excludeApps
      : DEFAULT_SETTINGS.excludeApps;
    const out = [];
    for (const raw of rawSessions) {
      const app = String(raw.app || '').trim();
      const display = String(raw.display || '').trim();
      // Skip system sessions (svchost/audiodg/Background/System Sounds...).
      if (
        (app && isExcludedApp(app, exclude)) ||
        (display && isExcludedApp(display, exclude))
      ) {
        continue;
      }
      const stream = {
        id: String(raw.id || ''),
        app,
        display,
        pid: Number(raw.pid) || 0,
        volume: clampVolume(raw.volume),
        muted: !!raw.muted,
      };
      if (!stream.id) continue;
      stream.displayName = streamDisplayName(stream);
      stream.dedupeKey = streamDedupeKey(stream);
      out.push(stream);
    }
    return out;
  }

  /**
   * Safe default (50%) for never-before-seen apps + restore of the
   * remembered volume when an app opens a new audio session.
   */
  async _ensureVolume(stream) {
    // Never auto-adjust sessions we couldn't name: an unnamed session could
    // be a system session, and forcing the 50% default would clobber it.
    if (!stream.app) return;
    const key = stream.dedupeKey;
    const prevId = this.lastStreamIdByKey.get(key);
    const idChanged = prevId != null && prevId !== stream.id;
    const isNewInstance = !this.seenKeys.has(key);
    this.seenKeys.add(key);
    this.lastStreamIdByKey.set(key, stream.id);

    const cached = this.memory.get(stream);
    if (cached == null) {
      // Brand-new app: apply the safe default before it can blast audio.
      const target = clampVolume(this.settings.defaultVolume) || DEFAULT_NEW_APP_VOLUME;
      await this._ensureSessionVolume(stream, target);
      stream.volume = target;
      this.memory.set(stream, target);
      this._log('info', 'new app', stream.app, 'set to', target + '%');
      return;
    }

    const needsRestore =
      (idChanged || isNewInstance) &&
      cached < STREAM_VOLUME_RESTORE_HIGH &&
      (stream.volume == null || stream.volume >= STREAM_VOLUME_RESTORE_HIGH);
    if (needsRestore) {
      const applied = await this._ensureSessionVolume(stream, cached);
      stream.volume = applied;
      this._log('info', 'restored', stream.app, 'to', applied + '%');
    }
  }

  /** Set a session/app volume and verify it stuck (new sessions are flaky). */
  async _ensureSessionVolume(stream, target) {
    if (stream.router) {
      try {
        await this.router.setVolume(stream.pid, target / 100);
        for (let i = 0; i < RESTORE_ATTEMPTS; i++) {
          await sleep(40 + i * 15);
          const st = await this.router.appState(stream.pid);
          if (st && st.volume != null && Math.abs(st.volume * 100 - target) <= 2) {
            return Math.round(st.volume * 100);
          }
        }
      } catch (err) {
        this._log('debug', 'router ensureVolume failed:', err.message);
      }
      return target;
    }
    const id = stream.id;
    let applied = target;
    for (let i = 0; i < RESTORE_ATTEMPTS; i++) {
      const res = await this.bridge.setSessionVolume(id, target);
      if (!res.ok) return target;
      await sleep(40 + i * 15);
      const st = await this.bridge.sessionState(id);
      if (st.ok && st.volume != null && Math.abs(st.volume - target) <= 2) {
        applied = st.volume;
        break;
      }
    }
    return applied;
  }

  // ------------------------------------------------------------------
  // Feedback
  // ------------------------------------------------------------------

  _pushMasterFeedback(context, state) {
    const s = state || { device: 'No Audio Device', deviceId: null, muted: false, volume: null };
    const muted = !!s.muted;
    const payload = {
      layout: '$B1',
      icon: muted ? this.icons.speakerMuted : this.icons.speaker,
      title: normDeviceName(s.device),
      value: muted ? 'MUTED' : s.volume != null ? s.volume + '%' : '\u2014',
      indicator: muted || s.volume == null ? 0 : Math.max(0, Math.min(1, s.volume / 100)),
    };
    this._sendFeedback(context, payload);
  }

  _pushAppFeedback(context, slot, stream) {
    if (!stream) {
      this._sendFeedback(context, {
        layout: '$B1',
        icon: this.icons.wave,
        title: '',
        value: '\u2014',
        indicator: 0,
      });
      return;
    }
    const muted = !!stream.muted;
    const vol = clampVolume(stream.volume);
    const label = (this._slotLabels && this._slotLabels[slot]) || stream.displayName;
    const icon = stream.iconData || (muted ? this.icons.waveMuted : this.icons.wave);
    const payload = {
      layout: '$B1',
      icon,
      title: label,
      value: muted ? 'MUTED' : vol != null ? vol + '%' : '\u2014',
      indicator: muted || vol == null ? 0 : Math.max(0, Math.min(1, vol / 100)),
    };
    this._sendFeedback(context, payload);
  }

  _pushToggleTitle(context, state) {
    const s = state || this.lastMaster;
    const title = s && s.device ? normDeviceName(s.device) : '\u2014';
    this._send({ event: 'setTitle', context, payload: { title, target: 0 } });
  }

  _sendFeedback(context, payload) {
    const sig = JSON.stringify(payload);
    if (this.lastFeedback.get(context) === sig) return;
    this.lastFeedback.set(context, sig);
    this._send({ event: 'setFeedback', context, payload });
  }

  // ------------------------------------------------------------------
  // Property inspector support
  // ------------------------------------------------------------------

  _pushStateToInspector(context) {
    const payload = {
      type: 'state',
      device: this.lastMaster ? this.lastMaster.device : null,
      deviceId: this.lastMaster ? this.lastMaster.deviceId : null,
      volume: this.lastMaster ? this.lastMaster.volume : null,
      muted: this.lastMaster ? !!this.lastMaster.muted : false,
      knobCount: this.appKnobContexts.size,
    };
    this._send({ event: 'sendToPropertyInspector', context, payload });
  }

  // ------------------------------------------------------------------
  // Persistence / notifications
  // ------------------------------------------------------------------

  _persistSettings() {
    this._send({ event: 'setGlobalSettings', context: this.pluginUUID, payload: this.settings });
  }

  _toast(title, body) {
    if (!this.pluginDir) return;
    const ps = path.join(this.pluginDir, 'audio-bridge.ps1');
    try {
      const child = spawn(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          ps,
          '-Command',
          'toast',
          '-Title',
          title,
          '-Body',
          body,
        ],
        { detached: true, stdio: 'ignore', windowsHide: true }
      );
      child.unref();
    } catch (err) {
      this._log('warn', 'toast failed:', err.message);
    }
  }

  _log(level, ...args) {
    if (this.log && typeof this.log[level] === 'function') this.log[level](...args);
  }

  _send(obj) {
    try {
      this.send(JSON.stringify(obj));
    } catch (err) {
      this._log('error', 'websocket send failed:', err.message);
    }
  }
}

module.exports = { VolumeMonitorCore, ACTIONS };
