'use strict';
/**
 * Volume Monitor plugin entry point.
 *
 * Stream Deck launches this file with the Node runtime named in the
 * manifest (Nodejs.Version 24) and three argv values:
 *
 *   node plugin.js -port <port> -pluginUUID <uuid> -registerEvent <event>
 *
 * The plugin opens the Stream Deck websocket, registers, and forwards every
 * event to VolumeMonitorCore, which polls the audio bridge/router and
 * pushes dial/keypad feedback.
 */

const { Log } = require('./lib/log');
const { VolumeMonitorCore } = require('./lib/core');
const { AudioBridge } = require('./lib/bridge');

const log = new Log();

function arg(name, fallback) {
  const i = process.argv.indexOf('-' + name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : fallback;
}

const port = Number(arg('port', 0));
const pluginUUID = arg('pluginUUID', 'com.tech127x.volume-monitor');
const registerEvent = arg('registerEvent', 'registerPlugin');

if (!port) {
  log.error('missing -port argument, args:', process.argv.slice(2).join(' '));
  process.exit(1);
}

log.info('starting plugin', pluginUUID, 'on port', port);

const bridge = new AudioBridge({ log });
const core = new VolumeMonitorCore({
  pluginUUID,
  pluginDir: __dirname,
  send: (str) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(str);
  },
  bridge,
  log,
});

// A single bad frame or stray rejection must not kill the plugin.
process.on('uncaughtException', (err) => log.error('uncaught exception:', err && err.message));
process.on('unhandledRejection', (err) => log.error('unhandled rejection:', err && err.message));

const ws = new WebSocket('ws://127.0.0.1:' + port);

ws.onopen = () => {
  log.info('connected to Stream Deck');
  ws.send(JSON.stringify({ event: registerEvent, uuid: pluginUUID }));
  ws.send(JSON.stringify({ event: 'getGlobalSettings', context: pluginUUID }));
  bridge
    .start()
    .then((ok) => {
      if (!ok) log.warn('audio bridge failed to start');
    })
    .catch((err) => log.error('bridge start failed:', err.message));
  core.start();
};

ws.onmessage = (ev) => {
  let msg;
  try {
    msg = JSON.parse(String(ev.data));
  } catch {
    log.error('non-JSON message from Stream Deck:', String(ev.data).slice(0, 200));
    return;
  }
  try {
    core.onEvent(msg);
  } catch (err) {
    log.error('onEvent failed for', msg.event, ':', err.message);
  }
};

ws.onerror = (err) => {
  log.error('websocket error:', err && err.message);
};

ws.onclose = () => {
  log.info('websocket closed, exiting');
  core.stop();
  bridge.stop();
  process.exit(0);
};

// If Stream Deck never answers (port closed at spawn time), don't linger.
setTimeout(() => {
  if (ws.readyState !== WebSocket.OPEN) {
    log.error('websocket never opened, exiting');
    process.exit(1);
  }
}, 10000);
