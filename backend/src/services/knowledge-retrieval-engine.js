// Local lexical baseline. No embeddings, network calls, or implicit synonyms.
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
export function knowledgeTokens(value) {
  return [...segmenter.segment(String(value).normalize('NFKC').toLowerCase())]
    .filter(item => item.isWordLike).map(item => item.segment);
}

export function previewKnowledgeChunks(text, size = 1000) {
  if (typeof text !== 'string' || !text.trim() || text.length > 120000) throw new Error('KNOWLEDGE_TEXT_INVALID');
  if (!Number.isInteger(size) || size < 200 || size > 2000) throw new Error('KNOWLEDGE_CHUNK_SIZE_INVALID');
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf('\n', end - 1);
      if (boundary >= start + size / 2) end = boundary + 1;
      // Do not split a UTF-16 surrogate pair.
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    chunks.push({ index: chunks.length, start, end, text: text.slice(start, end), location: 'text_offsets' });
    start = end;
  }
  return chunks;
}

// Weighted reciprocal rank fusion is also the port for future ranked providers.
// Inputs contain IDs and finite scores, never provider-authored evidence text.
export function fuseKnowledgeRanks(rankings, limit = 10) {
  const scores = new Map();
  for (const ranking of rankings) {
    const seen = new Set();
    for (const [index, item] of ranking.entries()) {
      if (!item || typeof item.id !== 'string' || !Number.isFinite(item.score) || item.score <= 0 || seen.has(item.id)) continue;
      seen.add(item.id);
      scores.set(item.id, (scores.get(item.id) || 0) + 1 / (60 + index + 1));
    }
  }
  return [...scores].map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

export function rankKnowledgeChunks(query, chunks, limit = 10) {
  const terms = [...new Set(knowledgeTokens(query))];
  if (!terms.length || !chunks.length) return [];
  const corpus = chunks.map(chunk => {
    const tokens = knowledgeTokens(`${chunk.title}\n${chunk.text}`);
    const frequencies = new Map();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) || 0) + 1);
    return { chunk, length: tokens.length, frequencies };
  });
  const avgLength = corpus.reduce((sum, row) => sum + row.length, 0) / corpus.length || 1;
  const documentFrequency = new Map(terms.map(term => [term, corpus.filter(row => row.frequencies.has(term)).length]));
  return corpus.map(({ chunk, length, frequencies }) => {
    let score = 0;
    for (const term of terms) {
      const frequency = frequencies.get(term) || 0;
      if (!frequency) continue;
      const df = documentFrequency.get(term);
      const idf = Math.log(1 + (corpus.length - df + 0.5) / (df + 0.5));
      score += idf * (frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * length / avgLength));
    }
    return { id: chunk.id, score };
  }).filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
