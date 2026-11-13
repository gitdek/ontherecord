import { createHash } from 'node:crypto'
import type { Part } from './search.ts'

export type SourceIdentity =
  | { kind: 'action'; id: string; part?: Part | 'updates' | 'board-wording' }
  | { kind: 'note' | 'document' | 'transcript' | 'meeting' | 'screen'; id: string }

type Location = {
  kind: string
  meetingId?: string
  actionId?: string
  board?: boolean
  part?: Part
  noteId?: string
  fileId?: string
  videoId?: string
  transcriptId?: string
  segIndex?: number
  t?: number
  end?: number
  section?: string
  topicKey?: string
  text: string
}

export function sourceOf(row: Location): SourceIdentity {
  if (row.kind === 'screen') return { kind: 'screen', id: JSON.stringify([row.meetingId, row.videoId, row.t]) }
  if (row.actionId) {
    const part = row.kind === 'update' ? row.part ?? 'updates' : row.board ? 'board-wording' : undefined
    return { kind: 'action', id: row.actionId, ...(part ? { part } : {}) }
  }
  if (row.noteId) return { kind: 'note', id: row.noteId }
  if (row.fileId) return { kind: 'document', id: row.fileId }
  if (row.kind === 'transcript' && (row.segIndex != null || row.t != null))
    return { kind: 'transcript', id: JSON.stringify([row.meetingId, row.transcriptId, row.segIndex ?? row.t, row.end]) }
  if (row.topicKey) return { kind: 'meeting', id: JSON.stringify([row.meetingId, row.topicKey]) }
  const id = createHash('sha1').update(JSON.stringify([row.meetingId, row.kind, row.t, row.section, row.text])).digest('base64url')
  return { kind: row.kind === 'transcript' ? 'transcript' : 'meeting', id }
}

export const sourceKey = (source: SourceIdentity) =>
  JSON.stringify([source.kind, source.id, source.kind === 'action' ? source.part : undefined])

// An action item's card on the board.
export const boardLink = (actionId: string) => `/actions?show=all&focus=${encodeURIComponent(actionId)}`

// An action item from a meeting's notes opens that meeting at the moment it was agreed; one without a time,
// and what the board holds (a task added there, corrected wording, an update), open the item's card instead.
export function sourceLink(row: Location): string {
  const fromBoard = row.board || row.kind === 'update' || row.kind === 'board'
  if (row.actionId && (fromBoard || !row.meetingId || row.t == null || !Number.isFinite(row.t))) return boardLink(row.actionId)
  if (row.noteId) return `/notebook/${encodeURIComponent(row.noteId)}`
  if (!row.meetingId) return '/actions'
  const path = `/m/${encodeURIComponent(row.meetingId)}`
  if (row.fileId) return `${path}?tab=excerpt&file=${encodeURIComponent(row.fileId)}`
  const params = new URLSearchParams()
  if (row.kind === 'screen' && row.videoId && row.t != null && Number.isFinite(row.t)) {
    params.set('video', row.videoId)
    params.set('vt', String(row.t))
    return `${path}?${params}`
  }
  if (row.t != null && Number.isFinite(row.t)) params.set('t', String(row.t))
  if (row.kind === 'transcript') {
    params.set('tab', 'transcript')
    if (row.transcriptId) params.set('transcript', row.transcriptId)
  } else params.set('tab', 'notes')
  if (row.topicKey) params.set('topic', row.topicKey)
  return params.size ? `${path}?${params}` : path
}
