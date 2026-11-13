// A settled question combines keyword and meaning ranks. The reranker can contribute a third vote.
import { sourceKey, sourceLink, sourceOf, type SourceIdentity } from './retrieval-source.ts'
import { keywordSources, type Hit, type Results } from './search.ts'
import { chunkKind, relatedMatch, type Chunk, type ChunkKind, type Reranker } from './semantic.ts'

export const rrf = (rank: number) => 1 / (60 + rank)

export type Fused = Hit & {
  title?: string
  end?: number
  exact: boolean
  meaning: boolean
  similarity?: number
  semanticKind?: ChunkKind
  source: SourceIdentity
  link: string
  evidence: string
}

const sameTranscript = (c: Pick<Chunk, 'kind' | 'meetingId' | 'transcriptId' | 't' | 'end'>, h: Pick<Hit, 'kind' | 'meetingId' | 'transcriptId' | 't'>) =>
  c.kind === 'transcript' && h.kind === 'transcript' && c.meetingId === h.meetingId &&
  (!c.transcriptId || !h.transcriptId || c.transcriptId === h.transcriptId) &&
  c.t != null && h.t != null && h.t >= c.t - 5 && h.t <= (c.end ?? c.t) + 5

function semanticHit(c: Chunk): Hit {
  return {
    kind: chunkKind(c),
    meetingId: c.meetingId ?? '',
    text: c.kind === 'screen' ? c.text : c.evidence ?? c.text,
    noteId: c.noteId,
    fileId: c.fileId,
    ...(c.videoId ? { videoId: c.videoId } : {}),
    actionId: c.actionId,
    t: c.t,
    transcriptId: c.transcriptId,
    topicKey: c.topicKey,
    section: c.section,
    ...(c.kind === 'board' ? { board: true } : {}),
    marks: [],
    score: 0,
  }
}

export function fuse(keyword: Results, near: { chunk: Chunk; score: number }[], related: number, limit = 60): Fused[] {
  if (keyword.badFilters.length || keyword.unknownPeople.length || keyword.ambiguousPeople?.length) return []
  const exact = !keyword.loose && !Object.keys(keyword.fuzzy).length
  const rows = new Map<string, Fused>()
  for (const [rank, h] of keyword.hits.entries()) {
    const source = sourceOf(h)
    const key = sourceKey(source)
    if (rows.has(key)) continue
    const evidence = [h.before, h.text, h.after].filter(Boolean).join(' ')
    rows.set(key, { ...h, exact, meaning: false, score: rrf(rank), source, link: sourceLink(h), evidence })
  }
  near.filter((n) => relatedMatch(n, related)).forEach(({ chunk: c, score }, rank) => {
    const h = semanticHit(c)
    const source = sourceOf({ ...h, end: c.end })
    const key = sourceKey(source)
    const same = rows.get(key) ?? [...rows.values()].find((r) => r.title === undefined &&
      (sameTranscript(c, r) ||
        (h.kind === 'update' && r.kind === 'update' && h.actionId && h.actionId === r.actionId && r.text && h.text.includes(r.text)) ||
        (c.topicKey && r.topicKey === c.topicKey && r.meetingId === c.meetingId)))
    if (same) {
      if (!same.meaning) {
        same.score += rrf(rank)
        same.meaning = true
        same.similarity = score
        same.semanticKind = c.kind
        // Preserve the marked line and add the semantic context if it supplies more evidence.
        if (h.text.length > same.evidence.length) same.evidence = h.text.includes(same.text) ? h.text : [same.evidence, h.text].join('\n\n')
      }
      return
    }
    rows.set(key, {
      ...h,
      end: c.end,
      title: c.title,
      noteTitle: c.noteId ? c.title : undefined,
      text: h.text.length > 360 ? `${h.text.slice(0, 357)}…` : h.text,
      exact: false,
      meaning: true,
      similarity: score,
      semanticKind: c.kind,
      score: rrf(rank),
      source,
      link: sourceLink(h),
      evidence: c.kind === 'screen' ? c.evidence ?? '' : h.text,
    })
  })
  return [...rows.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}

// The grouped list shares the settled result set. Keep counts for keyword hits outside the visible window.
export function grouped(keyword: Results, rows: Fused[], limit: number) {
  const seen = keywordSources.get(keyword)
  const perMeeting = new Map(keyword.meetings.map((m) => [m.id, { ...m, best: 0 }]))
  let total = keyword.total
  let notebookCount = keyword.notebookCount ?? 0
  let boardCount = keyword.boardCount ?? 0
  for (const row of rows) {
    const newSource = row.title !== undefined && !seen?.keys.has(sourceKey(row.source)) &&
      !seen?.transcripts.get(row.meetingId)?.some((h) => row.source.kind === 'transcript' && sameTranscript({ ...row, kind: 'transcript' }, h))
    if (newSource) {
      total++
      if (row.noteId) notebookCount++
      if (row.board && !row.meetingId) boardCount++
    }
    if (row.meetingId) {
      const m = perMeeting.get(row.meetingId) ?? { id: row.meetingId, count: 0, best: 0 }
      if (newSource) m.count++
      m.best = Math.max(m.best, row.score)
      perMeeting.set(m.id, m)
    }
  }
  return { ...keyword, total, notebookCount, boardCount, hits: rows.slice(0, limit), meetings: [...perMeeting.values()].sort((a, b) => b.best - a.best) }
}

export async function rerank(question: string, rows: Fused[], reranker: Reranker, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  if (!question.trim()) return false
  const shortlist = rows.filter((r) => r.kind !== 'screen').slice(0, 20)
  const order = await reranker.order(question, shortlist.map((r) => r.evidence), signal)
  if (!order) return false
  order.forEach((i, rank) => (shortlist[i].score += rrf(rank)))
  rows.sort((a, b) => b.score - a.score)
  return true
}
