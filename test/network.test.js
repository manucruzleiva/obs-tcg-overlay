const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { getLanAddresses, isShared } = require('../src/services/network');

describe('getLanAddresses', () => {
  it('lists real adapters before virtual ones and skips loopback, IPv6 and link-local', () => {
    const interfaces = {
      'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.0.1', internal: false }],
      Loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      'Wi-Fi': [
        { family: 'IPv6', address: 'fe80::1', internal: false },
        { family: 'IPv4', address: '192.168.1.20', internal: false }
      ],
      Ethernet: [{ family: 'IPv4', address: '169.254.10.10', internal: false }]
    };

    assert.deepEqual(getLanAddresses(interfaces), [
      { name: 'Wi-Fi', address: '192.168.1.20', virtual: false },
      { name: 'vEthernet (WSL)', address: '172.20.0.1', virtual: true }
    ]);
  });

  it('understands the numeric address family used by some Node versions', () => {
    const interfaces = { eth0: [{ family: 4, address: '10.0.0.5', internal: false }] };
    assert.deepEqual(getLanAddresses(interfaces).map((a) => a.address), ['10.0.0.5']);
  });

  it('returns an empty list when there is no network', () => {
    assert.deepEqual(getLanAddresses({}), []);
  });
});

describe('isShared', () => {
  it('is false only for loopback hosts', () => {
    assert.equal(isShared('0.0.0.0'), true);
    assert.equal(isShared('192.168.1.20'), true);
    assert.equal(isShared('127.0.0.1'), false);
    assert.equal(isShared('localhost'), false);
    assert.equal(isShared('::1'), false);
  });
});
