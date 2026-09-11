const retryable = error => ['UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(error?.cause?.code);

// Model inference only: at most one retry for a transient transport failure,
// sharing the original deadline. No business write or HTTP error is retried.
export async function fetchArkChat(url, options, timing) {
  const attempt = async () => {
    const startedAt = performance.now();
    try {
      const response = await fetch(url, options);
      timing?.attempts.push({ elapsedMs: Math.round(performance.now() - startedAt), status: response.status });
      return response;
    } catch (error) {
      timing?.attempts.push({ elapsedMs: Math.round(performance.now() - startedAt), code: retryable(error) ? error.cause.code : 'TRANSPORT_FAILURE' });
      throw error;
    }
  };
  try { return await attempt(); } catch (error) {
    if (options.signal?.aborted || !retryable(error)) throw error;
    return attempt();
  }
}
