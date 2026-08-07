#!/usr/bin/env node
/**
 * Integration test: spawns the REAL plugin.js (with the REAL audio bridge)
 * against a minimal Stream Deck websocket server, and asserts the
 * registration handshake, feedback pushes, and a dialRotate round-trip.
 *
 * Requires the bundled Node runtime (WebSocket behind the experimental
 * flag on Node <22):
 *   node --experimental-websocket tests/integration.mjs
 */
'use strict';

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.join(__dirname, '..', 'com.tech127x.volume-monitor.sdPlugin');
const NODE = process.execPath;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Minimal RFC6455 websocket server (no deps)
// ---------------------------------------------------------------------------

class WsServer {
  constructor() {
    this.server = createServer();
    this.server.on('upgrade', (req, socket) => this._upgrade(req, socket));
    this.messages = [];
    this.waiters = [];
  }
  listen() {
    return new Promise((r) => this.server.listen(0, '127.0.0.1', () => r(this.server.address().port)));
  }
  close() {
    return new Promise((r) => this.server.close(() => r()));
  }
  _upgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' +
        accept +
        '\r\n\r\n'
    );
    socket.on('error', () => {}); // child teardown resets the connection
    this.socket = socket;
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const masked = (buf[1] & 0x80) !== 0;
        if (masked) {
          if (buf.length < off + 4) return;
          const mask = buf.subarray(off, off + 4);
          off += 4;
          const payload = Buffer.from(buf.subarray(off, off + len));
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
          if (opcode === 1) this._onMessage(payload.toString('utf8'));
          buf = buf.subarray(off + len);
        } else {
          if (buf.length < off + len) return;
          if (opcode === 1) this._onMessage(buf.subarray(off, off + len).toString('utf8'));
          buf = buf.subarray(off + len);
        }
      }
    });
  }
  _onMessage(str) {
    let msg;
    try {
      msg = JSON.parse(str);
    } catch {
      return;
    }
    this.messages.push(msg);
    for (const w of [...this.waiters]) {
      if (w.pred(msg)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  }
  send(obj) {
    const data = Buffer.from(JSON.stringify(obj));
    if (data.length < 126) {
      const header = Buffer.from([0x81, data.length]);
      this.socket.write(Buffer.concat([header, data]));
    } else {
      const header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(data.length, 2);
      this.socket.write(Buffer.concat([header, data]));
    }
  }
  /** Wait for a message matching pred, or throw after timeoutMs. */
  waitFor(pred, timeoutMs, what) {
    const existing = this.messages.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const w = {
        pred,
        resolve,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error('timeout waiting for ' + what));
        }, timeoutMs),
      };
      this.waiters.push(w);
    });
  }
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('Volume Monitor integration test (real plugin + real audio bridge)\n');

  const server = new WsServer();
  const port = await server.listen();
  const UUID = 'com.tech127x.volume-monitor';
  const REGISTER = 'registerPlugin';

  const child = spawn(
    NODE,
    ['--experimental-websocket', 'plugin.js', '-port', String(port), '-pluginUUID', UUID, '-registerEvent', REGISTER],
    { cwd: PLUGIN_DIR, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  let outLog = '';
  let errLog = '';
  child.stdout.on('data', (d) => (outLog += d));
  child.stderr.on('data', (d) => (errLog += d));

  try {
    // 1. Registration handshake
    const reg = await server.waitFor((m) => m.event === REGISTER, 10000, 'registration');
    check('plugin registers with UUID', reg.uuid === UUID, JSON.stringify(reg));
    const gs = await server.waitFor((m) => m.event === 'getGlobalSettings', 5000, 'getGlobalSettings');
    check('plugin requests global settings', gs.context === UUID, JSON.stringify(gs));

    // 2. Deliver global settings
    server.send({
      event: 'didReceiveGlobalSettings',
      payload: { settings: { excludeApps: ['svchost', 'audiodg', 'background', 'system sounds'], defaultVolume: 50, pollInterval: 100, notifyOnSwitch: true } },
    });

    // 3. willAppear master -> real audio feedback
    server.send({ event: 'willAppear', action: 'com.tech127x.volume-monitor.master', context: 'IT-M', payload: { settings: {} } });
    const fb1 = await server.waitFor(
      (m) => m.event === 'setFeedback' && m.context === 'IT-M' && /%/.test(m.payload.value),
      8000,
      'master volume feedback'
    );
    check('master feedback with real device', typeof fb1.payload.title === 'string' && fb1.payload.title.length > 0, JSON.stringify(fb1.payload));
    check('master feedback has volume', /%/.test(fb1.payload.value), fb1.payload.value);
    check('master layout $B1', fb1.payload.layout === '$B1', fb1.payload.layout);
    const beforeVolume = fb1.payload.value;

    // 4. willAppear appknob -> feedback (real sessions)
    server.send({ event: 'willAppear', action: 'com.tech127x.volume-monitor.appknob', context: 'IT-A', payload: { settings: {} } });
    const fbA = await server.waitFor((m) => m.event === 'setFeedback' && m.context === 'IT-A', 8000, 'appknob feedback');
    check('appknob feedback present', fbA.payload && fbA.payload.value !== undefined, JSON.stringify(fbA.payload));

    // 5. dialRotate round-trip against real audio (+2%, then restore)
    server.send({ event: 'dialRotate', action: 'com.tech127x.volume-monitor.master', context: 'IT-M', payload: { ticks: 1 } });
    await sleep(600);
    const fb2 = server.messages.filter((m) => m.event === 'setFeedback' && m.context === 'IT-M').pop();
    check('master feedback changed after rotate', fb2 && fb2.payload.value !== beforeVolume, `before=${beforeVolume} after=${fb2 && fb2.payload.value}`);
    server.send({ event: 'dialRotate', action: 'com.tech127x.volume-monitor.master', context: 'IT-M', payload: { ticks: -1 } });
    await sleep(1200);
    const restored = server.messages.filter(
      (m) => m.event === 'setFeedback' && m.context === 'IT-M' && m.payload.value === beforeVolume
    );
    check('volume restored after counter-rotate', restored.length > 0, `before=${beforeVolume} last=${server.messages.filter((m) => m.event === 'setFeedback' && m.context === 'IT-M').pop().payload.value}`);

    // 6. willDisappear
    server.send({ event: 'willDisappear', action: 'com.tech127x.volume-monitor.master', context: 'IT-M' });
    await sleep(300);

    // 7. Send a bogus event to make sure the plugin doesn't crash
    server.send({ event: 'dialUp', action: 'com.tech127x.volume-monitor.master', context: 'IT-M', payload: {} });
    await sleep(200);
    check('plugin alive after dialUp', child.exitCode == null, 'exitCode=' + child.exitCode);
  } finally {
    child.kill();
    server.close();
    await sleep(200);
  }

  if (errLog) console.log('plugin stderr:', errLog.slice(0, 500));
  console.log('\n' + (failed === 0 ? 'ALL TESTS PASSED' : failed + ' TEST(S) FAILED') + `  (${passed} passed, ${failed} failed)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('integration harness crashed:', err);
  process.exit(1);
});
