// Diagnostic adapter only. Not imported by the production API. It buffers the
// entire SSE response for the normal model gateway/output guard to validate.
export async function bufferDiagnosticStream(response, timing, startedAt, signal) {
  if (!response.ok) return response;
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('DIAGNOSTIC_STREAM_CONTENT_TYPE');
  const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = ''; let content = ''; let bytes = 0; let finished = false; let stop = false; let usage;
  const elapsed = () => Math.round(performance.now() - startedAt);
  const accept = frame => {
    const data = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data === '[DONE]') { finished = true; return; }
    if (finished) throw new Error('DIAGNOSTIC_STREAM_AFTER_DONE');
    let item;
    try { item = JSON.parse(data); } catch { throw new Error('DIAGNOSTIC_STREAM_JSON'); }
    if (item.error) throw new Error('DIAGNOSTIC_STREAM_PROVIDER_ERROR');
    if (item.usage) usage = item.usage;
    for (const choice of item.choices || []) {
      if (choice.index !== 0) throw new Error('DIAGNOSTIC_STREAM_CHOICE');
      if (choice.delta?.tool_calls || choice.delta?.function_call) throw new Error('DIAGNOSTIC_STREAM_TOOL_CALL');
      // Never retain or display reasoning_content.
      if (choice.delta?.content) {
        if (stop || typeof choice.delta.content !== 'string') throw new Error('DIAGNOSTIC_STREAM_CONTENT');
        if (timing.firstContentMs == null) timing.firstContentMs = elapsed();
        timing.lastContentMs = elapsed(); content += choice.delta.content;
      }
      if (choice.finish_reason) {
        if (choice.finish_reason !== 'stop') throw new Error('DIAGNOSTIC_STREAM_NOT_COMPLETE');
        stop = true;
      }
    }
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1048576) throw new Error('DIAGNOSTIC_STREAM_BUDGET');
      buffer += decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        accept(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) accept(buffer);
    if (!finished || !stop || !content) throw new Error('DIAGNOSTIC_STREAM_TRUNCATED');
    timing.totalMs = elapsed(); timing.bytes = bytes;
    timing.contentSpanMs = timing.lastContentMs - timing.firstContentMs;
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), { headers: { 'content-type': 'application/json' } });
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
