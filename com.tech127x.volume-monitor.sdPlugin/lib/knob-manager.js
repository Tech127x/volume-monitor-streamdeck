'use strict';
/**
 * Assigns playing app streams to the app-knob dial slots (2-4).
 *
 * - Streams are packed left-to-right in the order the audio source reports
 *   them ("one knob per app, in the order they appear").
 * - A stream that vanished is "ghosted" in place for 500ms so knobs don't
 *   flicker when an app briefly stops emitting. The grace counts from the
 *   last time the stream was actually seen alive (not from when its
 *   absence was noticed), so a stream that died between polls expires on
 *   time. A ghost keeps its slot, which also stops later streams from
 *   shifting during the grace window.
 * - Once the grace expires the ghost is dropped and everything compacts
 *   left to fill the gap.
 */

const GRACE_MS = 500;

class KnobManager {
  /**
   * @param {object} opts
   * @param {number} opts.firstSlot first app-knob slot (2)
   * @param {number} opts.lastSlot  last app-knob slot (4)
   */
  constructor({ firstSlot, lastSlot }) {
    this.firstSlot = firstSlot;
    this.lastSlot = lastSlot;
    /** slot -> { id, stream } (stream may be a stale ghost) */
    this.slots = new Map();
    /** streamId -> last poll time it was seen alive */
    this.lastSeen = new Map();
  }

  /** Record which streams are alive right now; call before assign(). */
  track(streams, now) {
    for (const s of streams) this.lastSeen.set(s.id, now);
  }

  /**
   * Compute the current slot layout: { slot -> stream } for every visible
   * slot. Ghosts within the grace period keep their slot; everything else
   * packs left in stream order. Mutates internal state (expiry/layout).
   */
  assign(streams, now) {
    const liveIds = new Set(streams.map((s) => s.id));
    const out = {};

    // Ghosts: slotted streams that are absent now but were seen recently.
    const ghosts = new Map();
    for (const [slot, entry] of this.slots) {
      if (liveIds.has(entry.id)) continue;
      const last = this.lastSeen.get(entry.id);
      if (last != null && now - last < GRACE_MS) ghosts.set(slot, entry.stream);
    }

    // Left-pack: ghosts block their exact slot, live streams fill the rest
    // in order.
    let i = 0;
    for (let slot = this.firstSlot; slot <= this.lastSlot; slot++) {
      if (ghosts.has(slot)) {
        out[slot] = ghosts.get(slot);
        continue;
      }
      const s = streams[i++];
      if (!s) break;
      out[slot] = s;
    }

    // Persist the layout; existing entries keep their stream object.
    for (const [slot, s] of Object.entries(out)) {
      const existing = this.slots.get(Number(slot));
      if (existing && existing.id === s.id) continue;
      this.slots.set(Number(slot), { id: s.id, stream: s });
    }
    // Drop entries for slots that left the layout.
    for (const slot of this.slots.keys()) {
      if (!(slot in out)) this.slots.delete(slot);
    }

    return out;
  }

  /** Current stream shown on a slot (null when empty). */
  streamForSlot(slot) {
    const entry = this.slots.get(slot);
    return entry ? entry.stream : null;
  }
}

module.exports = { KnobManager, GRACE_MS };
