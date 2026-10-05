/**
 * Is the program that answers on OTO's port really this copy of OTO?
 *
 * On Windows a program can listen on 127.0.0.1:6767 while OTO listens on 0.0.0.0:6767. Both start fine,
 * and every request from this same computer (the control panel window, an OBS browser source) then goes
 * to the other program, which may be an old test server or another app. Nothing looks broken: pages
 * just show old or wrong things. So once OTO is listening it asks its own port who answers, and
 * compares the instance id it gets back with its own.
 */

const PROBLEM = (port) => `Another program is answering on port ${port}, so the control panel and the overlay may show old or wrong things. Close that program, or start OTO on another port.`;

async function checkPort({ port, host, instanceId, fetchImpl = fetch, timeoutMs = 3000 }) {
  // "all interfaces" is reached through the loopback address
  const target = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  try {
    const response = await fetchImpl(`http://${target}:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    let body = null;
    try { body = await response.json(); } catch { /* ours always answers JSON */ }
    if (body && body.status === 'ok' && body.instance === instanceId) return { ok: true };
    return { ok: false, reason: 'other', message: PROBLEM(port) };
  } catch (error) {
    // Nobody answered: nothing to say about who owns the port (a firewall may be in the way)
    return { ok: false, reason: 'unreachable', message: `Nothing answered on port ${port}: ${error.message}` };
  }
}

module.exports = { checkPort };
