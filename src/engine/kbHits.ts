/**
 * 知识库检索结果(文本格式)解析。
 * 移植自主仓 desktop/src/chat/kbHits.js(整文件逐字移植,注释保留)。
 */

/** 知识库命中片段:文本格式解析出的原始命中,或 kb.references 风格的 JSON 命中 */
export interface KbHit {
  index?: number
  chunkId?: string | number | null
  docName?: string
  headingPath?: string
  channel?: string
  content?: string
  kbId?: string | number | null
  docId?: string | number | null
  kbName?: string
  [key: string]: unknown
}

/** 知识库检索结果格式:[n] 《文档》 路径 (channel)\n    片段内容(4 空格缩进,块间空行)。 */
export function parseKbHits(text: string | null | undefined): KbHit[] {
  if (!text) return []
  const blocks = String(text).split(/\n\s*\n/)
  const hits: KbHit[] = []
  for (const block of blocks) {
    const lines = block.split('\n')
    const head = lines[0] || ''
    const m = head.match(/^\[(\d+)\]\s*《(.*?)》\s*(.*)$/)
    if (!m) continue
    const [, index, docName, rest] = m
    let headingPath = ''
    let channel = ''
    let tail = (rest || '').trim()
    const chM = tail.match(/^(.*?)\s*\(([^)]*)\)\s*$/)
    if (chM && chM[2]) {
      headingPath = (chM[1] || '').trim()
      channel = chM[2]
    } else {
      headingPath = tail
    }
    const content = lines.slice(1)
      .map(l => l.replace(/^ {4}/, ''))
      .join('\n')
      .trim()
    if (!content) continue
    hits.push({ index: Number(index) || hits.length + 1, docName, headingPath, channel, content })
  }
  return hits
}
