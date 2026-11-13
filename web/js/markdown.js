// A small, safe markdown renderer for notebook entries. Everything is escaped first; the only HTML that
// comes out is the handful of tags generated here, and links must be http(s) or a path on this site.
import { esc } from './util.js'

const SAFE_HREF = /^(?:https?:\/\/|\/(?!\/))[^\s"'<>]*$/i

function link(href, inner) {
  if (!SAFE_HREF.test(href)) return inner
  const external = /^https?:/i.test(href)
  return `<a href="${esc(href)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${inner}</a>`
}

function inline(s, depth = 0) {
  if (depth > 4) return esc(s)
  const re = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/g
  let out = ''
  let last = 0
  for (const m of s.matchAll(re)) {
    out += esc(s.slice(last, m.index))
    if (m[1] != null) out += `<code>${esc(m[1])}</code>`
    else if (m[2] != null) out += link(m[3], inline(m[2], depth + 1))
    else if (m[4] != null) out += `<strong>${inline(m[4], depth + 1)}</strong>`
    else if (m[5] != null || m[6] != null) out += `<em>${inline(m[5] ?? m[6], depth + 1)}</em>`
    else if (m[7] != null) out += link(m[7], esc(m[7]))
    last = m.index + m[0].length
  }
  return out + esc(s.slice(last))
}

// Markdown's own marks: a heading's #s, a quote's >, a list bullet or a code fence at the start of a line;
// emphasis, code ticks, and a link's brackets and address (the link's words stay)
const MARKUP = /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|`{3,}\w*)|\*{2,3}|_{2,3}|`+|(?<![\w*])\*(?=[^\s*])|(?<=[^\s*])\*(?![\w*])|(?<![\w_])_(?=[^\s_])|(?<=[^\s_])_(?![\w_])|\[(?=[^\]\n]*\]\([^)\s]*\))|\]\([^)\s]*\)/gm

// A passage as plain words, for an excerpt. marks are [start, end) ranges in src (a search hit's highlights);
// they come back moved to where their words now stand.
export function unmark(src, marks = []) {
  const text = String(src ?? '')
  const at = []
  let out = ''
  let last = 0
  const keep = (from, to) => {
    for (let i = from; i < to; i++) at[i] = out.length + i - from
    out += text.slice(from, to)
  }
  for (const m of text.matchAll(MARKUP)) {
    keep(last, m.index)
    last = m.index + m[0].length
  }
  keep(last, text.length)
  const moved = marks.flatMap(([a, b]) => {
    const kept = []
    for (let i = a; i < b; i++) if (at[i] !== undefined) kept.push(at[i])
    return kept.length ? [[kept[0], kept.at(-1) + 1]] : []
  })
  return { text: out, marks: moved }
}

export function markdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let para = []
  let list = null
  let quote = []
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`)
    para = []
  }
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`)
    list = null
  }
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`)
    quote = []
  }
  const flush = () => {
    flushPara()
    flushList()
    flushQuote()
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^```/.exec(line.trim())
    if (fence) {
      flush()
      const code = []
      while (++i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i])
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`)
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      flush()
      out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`)
      continue
    }
    if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) {
      flush()
      out.push('<hr />')
      continue
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ul || ol) {
      flushPara()
      flushQuote()
      const tag = ul ? 'ul' : 'ol'
      if (list && list.tag !== tag) flushList()
      list ??= { tag, items: [] }
      list.items.push((ul ?? ol)[1])
      continue
    }
    const q = /^\s*>\s?(.*)$/.exec(line)
    if (q) {
      flushPara()
      flushList()
      quote.push(q[1])
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`
      continue
    }
    flushList()
    flushQuote()
    para.push(line.trim())
  }
  flush()
  return out.join('\n')
}
