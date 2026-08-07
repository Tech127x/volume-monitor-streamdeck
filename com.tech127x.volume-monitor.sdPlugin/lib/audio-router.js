'use strict';
/**
 * AudioRouter — optional client for the Elgato Volume Controller audio
 * router service (ws://127.0.0.1:1844, JSON-RPC 2.0). It is the only way to
 * get real per-app names, exe paths and icons on Windows builds where Core
 * Audio exposes no process info on sessions.
 *
 * - getApplicationInstanceCount / getApplicationInstanceAtIndex / getApplicationInstance
 * - getApplicationInstanceImage (returns { image, imageSize, imageFormat })
 * - setApplicationInstanceVolume / setApplicationInstanceMute
 *
 * The router never acknowledges the set* calls, so those are fired and
 * forgotten; the caller verifies by reading back.
 *
 * If the service is installed (Run key "Volume Controller SD plugin") but
 * not running, connect() kicks its watcher once, best-effort.
 */

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROUTER_URL = 'ws://127.0.0.1:1844';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'Volume Controller SD plugin';
const CONNECT_TIMEOUT_MS = 2000;
const RPC_TIMEOUT_MS = 4000;

class AudioRouter {
  /**
   * @param {object} [opts]
   * @param {object} [opts.log] logger (debug/info/warn/error)
   */
  constructor({ log } = {}) {
    this.log = log;
    this.available = false;
    this.icons = new Map(); // pid -> data URI (sync icon cache for feedback)
    this.ws = null;
    this._id = 0;
    this._pending = new Map(); // id -> { resolve, reject }
    this._connectPromise = null;
    this._kicked = false;
  }

  _log(level, ...args) {
    if (this.log && typeof this.log[level] === 'function') this.log[level](...args);
  }

  /**
   * Connect to the router. Resolves true when open; on failure kicks the
   * watcher (once per process) so later polls can retry. Fails fast — the
   * ws error fires immediately when nothing listens on the port.
   */
  connect() {
    if (this.available) return Promise.resolve(true);
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        this.available = ok;
        this._connectPromise = null;
        if (!ok) this._kickWatcher();
        resolve(ok);
      };
      try {
        const ws = new WebSocket(ROUTER_URL);
        this.ws = ws;
        ws.onopen = () => finish(true);
        ws.onerror = () => finish(false);
        ws.onclose = () => {
          this.available = false;
          if (this.ws === ws) this.ws = null;
          this._failPending(new Error('router disconnected'));
        };
        ws.onmessage = (ev) => this._onMessage(ev);
        setTimeout(() => {
          if (!done && ws.readyState !== WebSocket.OPEN) {
            try {
              ws.close();
            } catch {}
            finish(false);
          }
        }, CONNECT_TIMEOUT_MS);
      } catch (err) {
        finish(false);
      }
    });
    return this._connectPromise;
  }

  _onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg.id == null || !this._pending.has(msg.id)) return;
    const p = this._pending.get(msg.id);
    this._pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }

  _failPending(err) {
    for (const p of this._pending.values()) p.reject(err);
    this._pending.clear();
  }

  _rpc(method, params, timeoutMs = RPC_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.available) {
        reject(new Error('router not connected'));
        return;
      }
      const id = ++this._id;
      this._pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, jsonrpc: '2.0', method, params }));
      } catch (err) {
        this._pending.delete(id);
        reject(err);
        return;
      }
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error('timeout: ' + method));
        }
      }, timeoutMs);
    });
  }

  /**
   * The router never acks set* calls — send and resolve immediately; the
   * caller verifies with a read-back (appState).
   */
  _set(method, params) {
    try {
      if (this.ws && this.available) {
        const id = ++this._id;
        this.ws.send(JSON.stringify({ id, jsonrpc: '2.0', method, params }));
      }
    } catch (err) {
      this._log('debug', 'router set failed:', err.message);
    }
    return Promise.resolve({ ok: true });
  }

  /** All audio app instances: [{ processID, executableFile, displayName, activity, mute, volume }]. */
  async listApps() {
    if (!this.available) await this.connect();
    if (!this.available) throw new Error('audio router unavailable');
    const { count } = await this._rpc('getApplicationInstanceCount', {});
    const apps = [];
    for (let i = 0; i < count; i++) {
      const app = await this._rpc('getApplicationInstanceAtIndex', { index: i });
      if (app && app.processID != null) apps.push(app);
    }
    return apps;
  }

  /** Read one app instance back (verification for fire-and-forget sets). */
  async appState(pid) {
    try {
      return await this._rpc('getApplicationInstance', { processID: pid });
    } catch (err) {
      this._log('debug', 'router appState failed for pid', pid, err.message);
      return null;
    }
  }

  setVolume(pid, volume) {
    return this._set('setApplicationInstanceVolume', { processID: pid, volume });
  }

  setMute(pid, mute) {
    return this._set('setApplicationInstanceMute', { processID: pid, mute });
  }

  /**
   * PNG data URI for an app (cached in this.icons by pid so feedback can
   * read it synchronously and never flickers between icon and wave).
   */
  async iconFor(pid) {
    if (this.icons.has(pid)) return this.icons.get(pid);
    let uri = '';
    try {
      const img = await this._rpc('getApplicationInstanceImage', { processID: pid });
      if (img && img.image) {
        const fmt = String(img.imageFormat || 'png').toLowerCase();
        uri = 'data:image/' + fmt + ';base64,' + img.image;
      }
    } catch (err) {
      this._log('debug', 'router icon fetch failed for pid', pid, err.message);
    }
    this.icons.set(pid, uri);
    return uri;
  }

  /**
   * Best-effort restart of the installed-but-stopped Volume Controller
   * service: read its logon Run key and launch whatever it points at.
   * Robust to quoted and unquoted paths and bare command names; never
   * lets an async spawn error escape.
   */
  _kickWatcher() {
    if (this._kicked) return;
    this._kicked = true;
    execFile('reg', ['query', RUN_KEY, '/v', RUN_VALUE], { windowsHide: true }, (err, stdout) => {
      if (err) {
        this._log('debug', 'no Volume Controller Run key (router not installed)');
        return;
      }
      const line = String(stdout)
        .split(/\r?\n/)
        .find((l) => /REG_(SZ|EXPAND_SZ)/.test(l));
      if (!line) return;
      const cmdline = line.replace(/^.*REG_(SZ|EXPAND_SZ)\s+/, '').trim();
      const tokens = cmdline.match(/"([^"]+)"|\S+/g) || [];
      const parts = tokens.map((t) => t.replace(/^"(.*)"$/, '$1'));
      let exe = parts.shift() || '';
      let args = parts;
      // reg echoes the value verbatim; an unquoted "C:\Program Files\..."
      // arrives split on spaces — merge tokens until the exe path exists.
      const isAbs = (p) => /^[a-zA-Z]:[\\/]|^\\\\/.test(p);
      while (isAbs(exe) && !fs.existsSync(exe) && args.length) {
        exe = exe + ' ' + args.shift();
      }
      exe = this._findOnPath(exe);
      if (!exe) {
        this._log('debug', 'watcher command not resolvable:', cmdline);
        return;
      }
      this._log('info', 'kicking Volume Controller watcher:', exe, args.join(' '));
      try {
        const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
        child.on('error', (spawnErr) => this._log('debug', 'watcher kick error:', spawnErr.message));
        child.unref();
      } catch (kickErr) {
        this._log('debug', 'watcher kick failed:', kickErr.message);
      }
    });
  }

  /** Bare command names resolve against PATH; absolute paths pass through. */
  _findOnPath(name) {
    if (!name) return '';
    if (fs.existsSync(name)) return name;
    if (!/^[a-zA-Z]:[\\/]|^\\\\/.test(name)) {
      for (const dir of String(process.env.PATH || '').split(';')) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) return p;
      }
      for (const dir of String(process.env.SystemRoot || 'C:\\Windows').split(';')) {
        const p = path.join(dir, 'System32', name);
        if (fs.existsSync(p)) return p;
      }
    }
    return name;
  }
}

module.exports = { AudioRouter };
