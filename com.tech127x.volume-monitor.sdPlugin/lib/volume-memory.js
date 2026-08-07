'use strict';
/**
 * Per-app volume memory stored inside the plugin's global settings. Apps
 * are keyed by normalized app name (e.g. "Spotify", "VacuumTube"), so a
 * closed app comes back at the level the user last set.
 */

const { normalizeName } = require('./device-utils');

class VolumeMemory {
  /**
   * @param {object} settings global settings object (volumeMemory member)
   * @param {() => void} [onPersist] called after every write
   */
  constructor(settings, onPersist) {
    this.settings = settings;
    this.onPersist = onPersist;
  }

  /** Remembered volume for a stream (0-100), or null when never seen. */
  get(stream) {
    const key = this._key(stream);
    if (!key) return null;
    const v = this.settings.volumeMemory[key];
    return v == null ? null : Number(v);
  }

  set(stream, volume) {
    const key = this._key(stream);
    if (!key) return;
    const n = Math.round(Number(volume));
    if (Number.isNaN(n)) return;
    this.settings.volumeMemory[key] = Math.max(0, Math.min(100, n));
    if (this.onPersist) this.onPersist();
  }

  /** Unnamed/system sessions are never memorized (they are never adjusted). */
  _key(stream) {
    if (!stream || !stream.app) return null;
    return normalizeName(stream.app) || null;
  }
}

module.exports = { VolumeMemory };
