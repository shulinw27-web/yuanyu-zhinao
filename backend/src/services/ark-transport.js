const retryable = error => ['UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(error?.cause?.code);

// Model inference only: at most one retry for a transient transport failure,
// sharing the original deadline. No business write or HTTP error is retried.
export async function fetchArkChat(url, options) {
  try { return await fetch(url, options); } catch (error) {
    if (options.signal?.aborted || !retryable(error)) throw error;
    return fetch(url, options);
  }
}
