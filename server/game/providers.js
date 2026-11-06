// Slot providers: detected from the slot frame's address. Each profile can say where the buy-bonus button is.
// Positions are fractions of the slot frame (0..1). A provider with bonus: null is never clicked for a bonus.
// To map one: screenshot the slot in FUN mode, note where "Buy feature" and its "Confirm/Buy" button sit.
'use strict';
const PROVIDERS = [
  { id: 'pragmatic', name: 'Pragmatic Play', match: /pragmatic|ppgames|pp-game/i, bonus: null },
  { id: 'hacksaw',   name: 'Hacksaw Gaming', match: /hacksaw/i, bonus: null },
  { id: 'nolimit',   name: 'Nolimit City',   match: /nolimit/i, bonus: null },
  { id: 'relax',     name: 'Relax Gaming',   match: /relax/i, bonus: null },
  { id: 'push',      name: 'Push Gaming',    match: /pushgaming|push-gaming/i, bonus: null },
  { id: 'playngo',   name: "Play'n GO",      match: /playngo|playn-go/i, bonus: null },
  { id: 'netent',    name: 'NetEnt',         match: /netent/i, bonus: null },
  { id: 'btg',       name: 'Big Time Gaming', match: /bigtimegaming|btg/i, bonus: null },
  // example of a mapped provider (fill from a real screenshot):
  // bonus: { open: { x: 0.12, y: 0.55 }, confirm: { x: 0.5, y: 0.72 } }
];
function detect(url) {
  return PROVIDERS.find(p => p.match.test(url || '')) || { id: 'unknown', name: 'unknown provider', bonus: null };
}
module.exports = { PROVIDERS, detect };
