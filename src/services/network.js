/**
 * Network helpers: which addresses can other devices use to reach this machine.
 */

const os = require('os');

// Adapter names that usually belong to virtual machines, containers or VPNs rather than the real LAN
const VIRTUAL_ADAPTER = /vethernet|virtualbox|vmware|vmnet|hyper-v|wsl|docker|veth|bridge|tailscale|zerotier|bluetooth/i;

// IPv4 addresses of this machine on its networks, real adapters first.
// `interfaces` is injectable for tests.
function getLanAddresses(interfaces = os.networkInterfaces()) {
  const found = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const iface of addresses || []) {
      const isIPv4 = iface.family === 'IPv4' || iface.family === 4;
      if (!isIPv4 || iface.internal) continue;
      if (iface.address.startsWith('169.254.')) continue; // link-local: no real network behind it
      found.push({ name, address: iface.address, virtual: VIRTUAL_ADAPTER.test(name) });
    }
  }
  return found.sort((a, b) => Number(a.virtual) - Number(b.virtual));
}

// Whether the server accepts connections from other machines (it does unless bound to loopback)
function isShared(host) {
  return !['127.0.0.1', 'localhost', '::1'].includes(host);
}

module.exports = { getLanAddresses, isShared };
