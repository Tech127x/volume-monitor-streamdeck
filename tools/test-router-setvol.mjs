#!/usr/bin/env node
// Test volume changes through the Elgato audio router.
// node --experimental-websocket tools/test-router-setvol.mjs
'use strict';
const URL = 'ws://127.0.0.1:1844';
let id = 0;
const pending = new Map();

function rpc(ws, method, params, timeoutMs = 6000) {
  const rid = ++id;
  return new Promise((resolve, reject) => {
    pending.set(rid, { resolve, reject });
    ws.send(JSON.stringify({ id: rid, jsonrpc: '2.0', method, params }));
    setTimeout(() => {
      if (pending.has(rid)) {
        pending.delete(rid);
        reject(new Error('timeout: ' + method));
      }
    }, timeoutMs);
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
ws.onerror = () => console.error('ws error');
ws.onopen = async () => {
  try {
    const { count } = await rpc(ws, 'getApplicationInstanceCount');
    console.log('count:', count);
    // find vacuumtube
    let vt = null;
    for (let i = 0; i < count; i++) {
      const a = await rpc(ws, 'getApplicationInstanceAtIndex', { index: i });
      if (a && a.processID && String(a.executableFile).toLowerCase().includes('vacuumtube')) vt = a;
    }
    if (!vt) {
      console.log('vacuumtube not found');
      process.exit(0);
    }
    console.log('vacuumtube pid', vt.processID, 'volume was', vt.volume);
    // 1. plain set
    try {
      const r = await rpc(ws, 'setApplicationInstanceVolume', { processID: vt.processID, volume: 0.3 });
      console.log('set 0.3 responded:', JSON.stringify(r));
    } catch (e) {
      console.log('set 0.3 FAILED:', e.message);
    }
    await new Promise((r) => setTimeout(r, 800));
    const after = await rpc(ws, 'getApplicationInstance', { processID: vt.processID });
    console.log('volume after plain set:', after && after.volume);
    // 2. try with mute-style key (mute instead of muted)? check setApplicationInstanceMute too
    try {
      const r = await rpc(ws, 'setApplicationInstanceMute', { processID: vt.processID, mute: false });
      console.log('setMute responded:', JSON.stringify(r));
    } catch (e) {
      console.log('setMute FAILED:', e.message);
    }
    // 3. restore
    try {
      await rpc(ws, 'setApplicationInstanceVolume', { processID: vt.processID, volume: vt.volume });
      console.log('restored');
    } catch (e) {
      console.log('restore FAILED:', e.message);
    }
  } catch (e) {
    console.error('error:', e.message);
  }
  process.exit(0);
};
setTimeout(() => {
  console.error('no response at all');
  process.exit(1);
}, 15000);
