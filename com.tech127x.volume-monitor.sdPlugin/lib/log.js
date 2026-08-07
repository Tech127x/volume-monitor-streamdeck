'use strict';
/**
 * Append-only file logger. Every plugin module shares one instance so all
 * output lands in a single chronological log under %TEMP%.
 */

const fs = require('node:fs');
const path = require('node:path');

function safeJson(a) {
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

class Log {
  /**
   * @param {string} [file] absolute log path (defaults to %TEMP%)
   */
  constructor(file) {
    this.file =
      file || path.join(process.env.TEMP || process.cwd(), 'volume-monitor-streamdeck.log');
  }

  _write(level, args) {
    const fmt = (a) =>
      typeof a === 'object' && a !== null ? safeJson(a) : String(a);
    const line =
      new Date().toISOString() + ' [' + level + '] ' + args.map(fmt).join(' ') + '\n';
    try {
      fs.appendFileSync(this.file, line);
    } catch {
      // Logging must never take the plugin down.
    }
  }

  debug(...args) {
    this._write('DEBUG', args);
  }

  info(...args) {
    this._write('INFO', args);
  }

  warn(...args) {
    this._write('WARN', args);
  }

  error(...args) {
    this._write('ERROR', args);
  }
}

module.exports = { Log };
