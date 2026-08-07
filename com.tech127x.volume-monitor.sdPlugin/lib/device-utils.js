'use strict';
/**
 * Name normalization, exclusions, and stream identity helpers shared by the
 * core polling logic and the knob manager.
 */

/**
 * Browsers get one knob per tab (each tab is a separate audio session);
 * every other app gets a single knob.
 */
const MULTI_INSTANCE_APPS = [
  'chrome',
  'msedge',
  'edge',
  'firefox',
  'brave',
  'opera',
  'opergx',
  'iexplore',
  'browser',
];

/** Lowercase, punctuation -> spaces, trimmed, collapsed. */
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Round to an integer 0..100; null/NaN stay null. */
function clampVolume(v) {
  const n = Number(v);
  if (v == null || Number.isNaN(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Case-insensitive "contains" match against any exclusion pattern. */
function isExcludedApp(name, exclude) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  for (const pat of Array.isArray(exclude) ? exclude : []) {
    const p = String(pat || '').toLowerCase().trim();
    if (p && n.includes(p)) return true;
  }
  return false;
}

function isMultiInstance(name) {
  return MULTI_INSTANCE_APPS.includes(normalizeName(name));
}

/**
 * Human label for a stream. Browsers show "chrome: <tab title>"; other
 * apps prefer their friendly display name, then the app name.
 */
function streamDisplayName(stream) {
  const app = String((stream && stream.app) || '').trim();
  const display = String((stream && stream.display) || '').trim();
  if (app && display && isMultiInstance(app)) return app + ': ' + display;
  if (display) return display;
  if (app) return app;
  return 'App';
}

/**
 * Stable identity used for ghosting/compaction and new-instance detection.
 * Browsers key per tab so a second tab doesn't replace the first.
 */
function streamDedupeKey(stream) {
  const app = normalizeName(stream && stream.app);
  const display = normalizeName(stream && stream.display);
  if (app && display && isMultiInstance(stream && stream.app)) {
    return 'app:' + app + ':' + display;
  }
  if (app) return 'app:' + app;
  if (display) return 'app:' + display;
  return 'app:' + normalizeName((stream && stream.displayName) || 'app');
}

/** "App" already used -> "App (2)", "App (3)", ... */
function disambiguateLabel(label, stream, usedLabels) {
  void stream; // identity hints may be added here later
  let n = 2;
  let out = label + ' (' + n + ')';
  while (usedLabels.has(out)) {
    n++;
    out = label + ' (' + n + ')';
  }
  return out;
}

/**
 * Friendlier render name for an output device. Known Bluetooth/headset
 * aliases win over the raw Windows name; trailing parentheticals are
 * stripped otherwise.
 */
const DEVICE_ALIASES = [
  ['q10', 'soundcore Q10'],
  ['q20', 'soundcore Q20'],
  ['q30', 'soundcore Q30'],
  ['q35', 'soundcore Q35'],
  ['space one', 'soundcore Space One'],
  ['liberty 4', 'soundcore Liberty 4'],
  ['airpods pro', 'AirPods Pro'],
  ['airpods', 'AirPods'],
  ['wh-1000xm', 'Sony WH-1000XM'],
  ['wh-ch710n', 'Sony WH-CH710N'],
  ['wh-xb910n', 'Sony WH-XB910N'],
];

function normDeviceName(name) {
  const raw = String(name || '');
  const lower = raw.toLowerCase();
  for (const [pat, alias] of DEVICE_ALIASES) {
    if (lower.includes(pat)) return alias;
  }
  return raw.replace(/\s*\([^)]*\)\s*$/, '').trim() || raw;
}

module.exports = {
  MULTI_INSTANCE_APPS,
  clampVolume,
  normDeviceName,
  isExcludedApp,
  streamDedupeKey,
  streamDisplayName,
  disambiguateLabel,
  normalizeName,
};
