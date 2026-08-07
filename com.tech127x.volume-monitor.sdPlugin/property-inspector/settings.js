/**
 * Volume Monitor property inspector.
 *
 * - Global settings (excluded apps, default volume, poll interval, notify
 *   on switch) + status readout.
 * - For an app-knob action: the knob-slot selector.
 *
 * Stream Deck 7.x connects the property inspector by invoking the global
 * connectElgatoStreamDeckSocket(port, uuid, event, info, actionInfo) once
 * the DOM has loaded (official SDK contract — no URL query params).
 *
 * Global settings live in the plugin's globalSettings; the plugin owns
 * volumeMemory/knobSlots, so this page preserves those members whenever it
 * writes the global blob.
 */
'use strict';

const APP_KNOB_ACTION = 'com.tech127x.volume-monitor.appknob';

let ws = null;
let started = false;
let uiUuid = ''; // Stream Deck validates every command against this context
let actionContext = null; // action instance context (null = global panel)
let actionUuid = ''; // action type UUID ('' = global panel)
let globalSettings = null; // last known full blob (keeps volumeMemory/knobSlots)

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Websocket plumbing
// ---------------------------------------------------------------------------

function start(port, uuid, registerEvent, info, actionInfo) {
  if (started) return;
  started = true;

  // The uuid Stream Deck handed us is the context it will accept on our
  // commands — NOT the manifest UUID (Stream Deck logs "wrong context"
  // and silently drops the request otherwise).
  uiUuid = uuid;
  try {
    const ai = JSON.parse(actionInfo || '');
    if (ai && ai.context) {
      actionContext = ai.context;
      actionUuid = ai.action || '';
    }
  } catch {
    // No action info -> this is the plugin-level (global) panel.
  }

  ws = new WebSocket('ws://127.0.0.1:' + port);
  ws.onopen = () => {
    ws.send(JSON.stringify({ event: registerEvent, uuid }));
    ws.send(JSON.stringify({ event: 'getGlobalSettings', context: uiUuid }));
    if (actionContext) {
      ws.send(JSON.stringify({ event: 'getSettings', context: actionContext }));
    }
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.event === 'didReceiveGlobalSettings') {
      onGlobalSettings((msg.payload && msg.payload.settings) || {});
    } else if (msg.event === 'didReceiveSettings') {
      onActionSettings(msg);
    } else if (msg.event === 'sendToPropertyInspector') {
      onPluginMessage(msg.payload);
    }
  };
}

/** Official SDK entry point — invoked by Stream Deck after the DOM loads. */
window.connectElgatoStreamDeckSocket = (port, uuid, event, info, actionInfo) => {
  start(port, uuid, event, info, actionInfo);
};

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Global settings
// ---------------------------------------------------------------------------

function onGlobalSettings(settings) {
  globalSettings = settings;
  populateGlobal(globalSettings);

  const isActionPanel = !!actionContext;
  const isAppKnob = actionUuid === APP_KNOB_ACTION;
  $('action-heading').style.display = isActionPanel ? '' : 'none';
  $('row-knob').style.display = isAppKnob ? '' : 'none';
  $('row-knob-save').style.display = isAppKnob ? '' : 'none';
}

function populateGlobal(s) {
  $('excludeApps').value = Array.isArray(s.excludeApps) ? s.excludeApps.join('\n') : '';
  $('defaultVolume').value = s.defaultVolume != null ? s.defaultVolume : 24;
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
  merged.defaultVolume = Number($('defaultVolume').value) || 24;
  merged.pollInterval = Number($('pollInterval').value) || 100;
  merged.notifyOnSwitch = $('notifyOnSwitch').checked;
  return merged;
}

function saveGlobal() {
  send({ event: 'setGlobalSettings', context: uiUuid, payload: collectGlobal() });
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
  send({
    event: 'setSettings',
    action: actionUuid,
    context: actionContext,
    payload: { knob },
  });
  $('btnSaveAction').textContent = 'Saved';
  setTimeout(() => ($('btnSaveAction').textContent = 'Save action settings'), 1200);
}

// ---------------------------------------------------------------------------
// Status panel
// ---------------------------------------------------------------------------

function piContext() {
  return actionContext || uiUuid;
}

function requestState() {
  send({
    event: 'sendToPlugin',
    action: actionUuid || '',
    context: piContext(),
    payload: { type: 'getState' },
  });
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
  send({
    event: 'sendToPlugin',
    action: actionUuid || '',
    context: piContext(),
    payload: { type: 'refresh' },
  });
  requestState();
});
$('btnToast').addEventListener('click', () => {
  send({
    event: 'sendToPlugin',
    action: actionUuid || '',
    context: piContext(),
    payload: { type: 'testToast' },
  });
});
