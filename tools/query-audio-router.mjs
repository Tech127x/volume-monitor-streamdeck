#!/usr/bin/env node
// Query the running Elgato Audio Router service (ws://127.0.0.1:1844) to see
// how it identifies the currently playing apps. Requires the experimental
// WebSocket flag on Node < 22:
//   node --experimental-websocket tools/query-audio-router.mjs
'use strict';
import fs from 'node:fs';

const URL = 'ws://127.0.0.1:1844';
let id = 0;
const pending = new Map();

function rpc(ws, method, params) {
  const rid = ++id;
  return new Promise((resolve, reject) => {
    pending.set(rid, { resolve, reject, method });
    ws.send(JSON.stringify({ id: rid, jsonrpc: '2.0', method, params }));
    setTimeout(() => {
      if (pending.has(rid)) {
        pending.delete(rid);
        reject(new Error('timeout: ' + method));
      }
    }, 4000);
  });
}

const ws = new WebSocket(URL);
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id != null && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }
};

ws.onerror = (e) => {
  console.error('WS error:', e && e.message);
  process.exit(1);
};

ws.onopen = async () => {
  try {
    const { count } = await rpc(ws, 'getApplicationInstanceCount');
    console.log('application instance count:', count);
    for (let i = 0; i < count; i++) {
      const app = await rpc(ws, 'getApplicationInstanceAtIndex', { index: i });
      console.log(
        `[${i}] pid=${app.processID} name="${app.displayName}" exe="${app.executableFile}" vol=${app.volume} mute=${app.mute} activity=${app.activity}`
      );
      if (i === 0 && app.processID != null) {
        try {
          const img = await rpc(ws, 'getApplicationInstanceImage', { processID: app.processID });
          if (img && img.image) {
            const buf = Buffer.from(img.image, 'base64');
            fs.writeFileSync('tools/elgato-app-icon.png', buf);
            console.log('  icon saved: tools/elgato-app-icon.png', img.imageSize, img.imageFormat, buf.length, 'bytes');
          }
        } catch (e) {
          console.log('  icon fetch failed:', e.message);
        }
      }
    }
  } catch (e) {
    console.error('query failed:', e.message);
  }
  ws.close();
  process.exit(0);
};

setTimeout(() => {
  console.error('no response from Audio Router on ' + URL);
  process.exit(1);
}, 8000);
