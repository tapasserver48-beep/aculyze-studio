/**
 * In-process event bus for automation triggers (Phase 04.2).
 *
 * Producers emit plain events; the automation service listens. Emitting never
 * throws into the producer — a failing listener must not break lead capture.
 *
 *   'lead.created'  { lead }   website chatbot captured a lead
 */

const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(20);

function emit(name, payload) {
  try {
    bus.emit(name, payload);
  } catch (err) {
    console.warn(`[automations] listener for ${name} failed: ${err.message}`);
  }
}

module.exports = { bus, emit };
