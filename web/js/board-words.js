// The board's vocabulary: how a change reads in a toast and in an item's history. The server says what a
// change did in short words ("canceled", "hold", "note-cleared"); these turn them into sentences.
// No DOM in here, so the tests can import it.

// One change can do several things at once (cancel an item and point it at its replacement), so the most
// telling one names it.
const SAID = [
  ['canceled', '🚫', 'canceled an action item'],
  ['done', '✅', 'checked off an action item'],
  ['reopened', '↩️', 'reopened an action item'],
  ['restored', '♻️', 'brought back a deleted task'],
  ['undone', '↩️', 'took back a change to an action item'],
  ['redone', '↪️', 'put a change back on an action item'],
  ['hold', '⏸️', 'put an action item on hold'],
  ['released', '▶️', 'took an action item off hold'],
  ['checked', '🔎', 'looked into an action item'],
  ['reworded', '✎', 'reworded an action item'],
  ['note', '✎', 'left a note on an action item'],
]

export function said(did = []) {
  const [, icon, words] = SAID.find(([word]) => did.includes(word)) ?? ['', '✎', 'updated an action item']
  return { icon, words }
}

const TRAIL = {
  added: 'Added',
  done: 'Marked done',
  canceled: 'Canceled',
  reopened: 'Reopened',
  reason: 'Reason changed',
  evidence: 'Evidence updated',
  linked: 'Pointed at the item that replaces it',
  unlinked: 'Replacement link removed',
  note: 'Note',
  'note-cleared': 'Note cleared',
  hold: 'Put on hold',
  released: 'Taken off hold',
  checked: 'Looked, found nothing',
  reworded: 'Reworded',
  edited: 'Edited',
  undone: 'Last change taken back',
  redone: 'Change put back',
  restored: 'Brought back after a delete',
  relinked: 'Matched to reworded notes',
}

export const TRAIL_WORDS = Object.keys(TRAIL)
export const trailWord = (did) => TRAIL[did] ?? did
