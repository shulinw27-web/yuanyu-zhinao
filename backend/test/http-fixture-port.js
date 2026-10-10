// Test-only binding: OS ephemeral ports can be forbidden by Fetch (e.g. 6667).
// Probe our own server; never bypass Fetch's blocked-port policy or retry business requests.
export async function listenOnFetchableLoopback(server, probe = async origin => {
  const response = await fetch(origin, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(3000) });
  await response.body?.cancel();
}) {
  for (let attempt = 0; attempt < 16; attempt++) {
    await new Promise((resolve, reject) => {
      const onError = error => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError); server.once('listening', onListening); server.listen(0, '127.0.0.1');
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    try { await probe(origin); return origin; }
    catch (error) {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      if (error?.cause?.message !== 'bad port') throw error;
    }
  }
  throw new Error('FETCHABLE_TEST_PORT_UNAVAILABLE');
}
