'use strict';
/**
 * AudioBridge — spawns audio-bridge.ps1 (PowerShell 5.1 + C# Core Audio
 * via Add-Type) and speaks its line-delimited JSON protocol on stdin/stdout.
 *
 * Protocol (see audio-bridge.ps1 header):
 *   -> {"cmd":"state"}  <- {"ok":true,"device":..,"deviceId":..,"muted":..,"volume":..}
 *   -> {"cmd":"setvol","volume":50}          -> {"cmd":"mute","muted":true}
 *   -> {"cmd":"devices"}                     -> {"ok":true,"devices":[{id,name}]}
 *   -> {"cmd":"sessions"}                    -> {"ok":true,"sessions":[{id,app,display,pid,volume,muted}]}
 *   -> {"cmd":"sessvol","id":..,"volume":40} -> {"cmd":"sessmute","id":..,"muted":true}
 *   -> {"cmd":"sessstate","id":..}           -> {"ok":true,"volume":..,"muted":..}
 *   -> {"cmd":"setdefault","id":..}          -> {"cmd":"ping"} / {"cmd":"quit"}
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const READY_TIMEOUT_MS = 20000;
const REQUEST_TIMEOUT_MS = 8000;

class AudioBridge {
  /**
   * @param {object} opts
   * @param {string} [opts.scriptPath] absolute path to audio-bridge.ps1
   * @param {object} [opts.log] logger (debug/info/warn/error)
   */
  constructor({ scriptPath, log } = {}) {
    this.scriptPath = scriptPath || path.join(__dirname, '..', 'audio-bridge.ps1');
    this.log = log;
    this.proc = null;
    this.buffer = '';
    this.pending = []; // FIFO of { resolve } waiting for response lines
    this._readyPromise = null;
    this._resolveReady = null;
    this._readyDone = false;
    this._startPromise = null;
  }

  _log(level, ...args) {
    if (this.log && typeof this.log[level] === 'function') this.log[level](...args);
  }

  /**
   * Spawn the bridge and wait for its {"event":"ready"} handshake.
   * Safe to call repeatedly (idempotent; restarts after a crash).
   */
  start() {
    if (this._startPromise) return this._startPromise;
    this._startPromise = new Promise((resolve) => {
      this._readyPromise = new Promise((r) => {
        this._resolveReady = r;
      });
      this._readyPromise.then(() => {
        this._readyDone = true;
        this._log('debug', 'bridge ready');
        resolve(true);
      });
      this._spawn();
      // The Add-Type C# compile can take a few seconds on cold start.
      setTimeout(() => {
        if (this.proc && !this._readyDone) {
          this._log('warn', 'bridge ready timeout, continuing anyway');
          this._resolveReady();
        }
      }, READY_TIMEOUT_MS);
    });
    return this._startPromise;
  }

  _spawn() {
    this.buffer = '';
    this._readyDone = false;
    try {
      const ps = spawn(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      this.proc = ps;
      ps.stdout.on('data', (d) => this._onData(d));
      ps.stderr.on('data', (d) => {
        const s = String(d).trim();
        if (s) this._log('debug', 'bridge stderr:', s);
      });
      ps.on('error', (err) => {
        this._log('error', 'bridge spawn failed:', err.message);
        this._failPending('bridge spawn failed');
        this.proc = null;
        this._startPromise = null;
        if (this._resolveReady) this._resolveReady();
      });
      ps.on('exit', (code) => {
        this._log('warn', 'audio bridge exited, code', code);
        this._failPending('bridge exited');
        this.proc = null;
        this._startPromise = null;
      });
    } catch (err) {
      this._log('error', 'bridge start failed:', err.message);
      this._failPending('bridge start failed');
      this.proc = null;
      this._startPromise = null;
      if (this._resolveReady) this._resolveReady();
    }
  }

  _onData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this._onLine(line);
    }
  }

  _onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this._log('error', 'bridge sent non-JSON line:', line.slice(0, 200));
      return;
    }
    if (msg && msg.event === 'ready') {
      if (this._resolveReady) this._resolveReady();
      return;
    }
    const w = this.pending.shift();
    if (w) w.resolve(msg || { ok: false, error: 'empty bridge response' });
    else this._log('debug', 'unexpected bridge line:', line.slice(0, 200));
  }

  _failPending(reason) {
    while (this.pending.length) {
      const w = this.pending.shift();
      w.resolve({ ok: false, error: reason });
    }
  }

  /**
   * Send one protocol command and resolve with its parsed response.
   * Requests are strictly serialized (the bridge answers one line at a time).
   */
  request(cmd, body) {
    const self = this;
    return new Promise((resolve) => {
      const waiter = { resolve };
      const run = () => {
        self.pending.push(waiter);
        self._write(Object.assign({ cmd }, body || {}));
        setTimeout(() => {
          const i = self.pending.indexOf(waiter);
          if (i >= 0) {
            self.pending.splice(i, 1);
            resolve({ ok: false, error: 'bridge request timeout: ' + cmd });
          }
        }, REQUEST_TIMEOUT_MS);
      };
      if (self.proc) {
        run();
      } else {
        // First use (or after a crash): wait for the ready handshake first.
        self.start().then(() => {
          if (self.proc) run();
          else resolve({ ok: false, error: 'bridge not running' });
        });
      }
    });
  }

  _write(obj) {
    if (!this.proc || !this.proc.stdin.writable) {
      this._log('warn', 'bridge stdin not writable');
      return;
    }
    try {
      this.proc.stdin.write(JSON.stringify(obj) + '\n');
    } catch (err) {
      this._log('error', 'bridge write failed:', err.message);
    }
  }

  stop() {
    if (this.proc && this.proc.stdin.writable) {
      try {
        this.proc.stdin.write('{"cmd":"quit"}\n');
      } catch {}
      const proc = this.proc;
      setTimeout(() => {
        if (proc && !proc.killed) proc.kill();
      }, 1000);
    }
  }

  // -- typed helpers used by core.js --------------------------------------

  async state() {
    const r = await this.request('state');
    return {
      ok: !!r.ok,
      device: r.device,
      deviceId: r.deviceId,
      muted: !!r.muted,
      volume: r.volume,
      error: r.error,
    };
  }

  async setVolume(pct) {
    const r = await this.request('setvol', { volume: Math.round(pct) });
    return { ok: !!r.ok, error: r.error };
  }

  async setMute(muted) {
    const r = await this.request('mute', { muted: !!muted });
    return { ok: !!r.ok, error: r.error };
  }

  async devices() {
    const r = await this.request('devices');
    return { ok: !!r.ok, devices: r.devices || [], error: r.error };
  }

  async sessions() {
    const r = await this.request('sessions');
    return { ok: !!r.ok, sessions: r.sessions || [], error: r.error };
  }

  async setSessionVolume(id, pct) {
    const r = await this.request('sessvol', { id, volume: Math.round(pct) });
    return { ok: !!r.ok, error: r.error };
  }

  async setSessionMute(id, muted) {
    const r = await this.request('sessmute', { id, muted: !!muted });
    return { ok: !!r.ok, error: r.error };
  }

  async sessionState(id) {
    const r = await this.request('sessstate', { id });
    return { ok: !!r.ok, volume: r.volume, muted: !!r.muted, error: r.error };
  }

  async setDefault(id) {
    const r = await this.request('setdefault', { id });
    return { ok: !!r.ok, error: r.error };
  }
}

module.exports = { AudioBridge };
