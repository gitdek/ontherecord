import { sourceKey, sourceOf } from './retrieval-source.ts'
import type { ScreenSearch } from './screens.ts'
import type { PreparedQuery } from './search.ts'
import { chunkKind, relatedMatch, type ChunkKind, type Semantic } from './semantic.ts'

export async function meaning(semantic: Semantic, query: PreparedQuery, opts: { k?: number; kinds?: ChunkKind[]; signal?: AbortSignal; current?: () => PreparedQuery; screens?: ScreenSearch } = {}) {
  const { current = () => query, screens, ...settings } = opts
  settings.signal?.throwIfAborted()
  if (!query.valid) return []
  const screenScope = query.q.areas.includes('screen')
  let selected: PreparedQuery | undefined
  const local = query.embeddingText.length > 2 && (!screenScope || query.q.areas.some((area) => area !== 'screen'))
    ? semantic.query(query.embeddingText, { ...settings, select: (c) => (selected ??= current()).chunk(c), identity: (c) => sourceKey(sourceOf({ ...c, kind: chunkKind(c), board: c.kind === 'board', text: c.evidence ?? c.text })) })
    : []
  if (!screenScope || !screens?.enabled || (settings.kinds && !settings.kinds.includes('screen'))) return local
  const [words, visual] = await Promise.all([local, screens.find(current, settings.k ?? 20, settings.signal)])
  if (!visual.length) return words
  const text = words.filter((row) => relatedMatch(row, semantic.related))
  // Interleave the two ranked lists without comparing scores from different models.
  return Array.from({ length: Math.max(text.length, visual.length) }, (_, i) => [text[i], visual[i]])
    .flat().filter((row) => row !== undefined)
}
