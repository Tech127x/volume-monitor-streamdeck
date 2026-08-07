/**
 * Volume Monitor property inspector.
 *
 * - Global panel (opened from the action list): excluded apps, default
 *   volume, poll interval, notify on switch, status readout.
 * - Action panel (opened on a placed action): knob slot for app knobs,
 *   plus the same status readout.
 *
 * Global settings live in the plugin's globalSettings; the plugin is the
 * owner of volumeMemory/knobSlots, so this page preserves those members
 * whenever it writes the global blob.
 */
'use strict';

const params = new URLSearchParams(location.search);
const port = params.get('port');
const pluginUUID = params.get('pluginUUID');
const registerEvent = params.get('registerEvent') || 'registerPropertyInspector';

let ws = null;
let actionContext = null; // set when this PI belongs to a placed action
let globalSettings = null; // last known full blob (keeps volumeMemory/knobSlots)

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Websocket plumbing
// ---------------------------------------------------------------------------

function connect() {
  ws = new WebSocket('ws://127.0.0.1:' + port);
  ws.onopen = () => {
    ws.send(JSON.stringify({ event: registerEvent, uuid: pluginUUID }));
    // Ask for the global blob; the response's context tells us whether this
    // PI is the global panel or an action panel.
    ws.send(JSON.stringify({ event: 'getGlobalSettings', context: pluginUUID }));
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.event === 'didReceiveGlobalSettings') onGlobalSettings(msg);
    else if (msg.event === 'didReceiveSettings') onActionSettings(msg);
    else if (msg.event === 'sendToPropertyInspector') onPluginMessage(msg.payload);
  };
  ws.onclose = () => {
    setTimeout(connect, 1000);
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Global settings
// ---------------------------------------------------------------------------

function onGlobalSettings(msg) {
  globalSettings = msg.payload && msg.payload.settings ? msg.payload.settings : {};
  const isGlobalPanel = msg.context === pluginUUID;
  if (!isGlobalPanel) {
    actionContext = msg.context;
    $('action-heading').style.display = '';
    $('row-knob').style.display = '';
    $('row-knob-save').style.display = '';
    send({ event: 'getSettings', context: actionContext });
  }
  populateGlobal(globalSettings);
}

function populateGlobal(s) {
  $('excludeApps').value = Array.isArray(s.excludeApps) ? s.excludeApps.join('\n') : '';
  $('defaultVolume').value = s.defaultVolume != null ? s.defaultVolume : 50;
  $('pollInterval').value = s.pollInterval != null ? s.pollInterval : 100;
  $('notifyOnSwitch').checked = s.notifyOnSwitch !== false;
  requestState();
}

function collectGlobal() {
  const merged = Object.assign({}, globalSettings || {});
  merged.excludeApps = $('excludeApps')
    .value.split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  merged.defaultVolume = Number($('defaultVolume').value) || 50;
  merged.pollInterval = Number($('pollInterval').value) || 100;
  merged.notifyOnSwitch = $('notifyOnSwitch').checked;
  return merged;
}

function saveGlobal() {
  send({ event: 'setGlobalSettings', context: pluginUUID, payload: collectGlobal() });
  $('btnSaveGlobal').textContent = 'Saved';
  setTimeout(() => ($('btnSaveGlobal').textContent = 'Save global settings'), 1200);
}

// ---------------------------------------------------------------------------
// Action settings (app knob slot)
// ---------------------------------------------------------------------------

function onActionSettings(msg) {
  const s = (msg.payload && msg.payload.settings) || {};
  const knob = s.knob || 'auto';
  $('knobSlot').value = String(knob);
}

function saveAction() {
  if (!actionContext) return;
  const knob = Number($('knobSlot').value) || 0;
  send({ event: 'setSettings', context: actionContext, payload: { knob } });
  $('btnSaveAction').textContent = 'Saved';
  setTimeout(() => ($('btnSaveAction').textContent = 'Save action settings'), 1200);
}

// ---------------------------------------------------------------------------
// Status panel
// ---------------------------------------------------------------------------

function requestState() {
  send({ event: 'sendToPlugin', context: actionContext || pluginUUID, payload: { type: 'getState' } });
}

function onPluginMessage(payload) {
  if (!payload || payload.type !== 'state') return;
  const parts = [];
  if (payload.device) parts.push('Device: ' + payload.device);
  if (payload.volume != null) parts.push('Volume: ' + payload.volume + '%');
  if (payload.muted) parts.push('Muted');
  if (payload.knobCount != null) parts.push('Knobs: ' + payload.knobCount);
  $('statusText').textContent = parts.length ? parts.join('  |  ') : 'No audio state yet';
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

$('btnSaveGlobal').addEventListener('click', saveGlobal);
$('btnSaveAction').addEventListener('click', saveAction);
$('btnRefresh').addEventListener('click', () => {
  send({ event: 'sendToPlugin', context: actionContext || pluginUUID, payload: { type: 'refresh' } });
  requestState();
});
$('btnToast').addEventListener('click', () => {
  send({ event: 'sendToPlugin', context: actionContext || pluginUUID, payload: { type: 'testToast' } });
});

connect();
