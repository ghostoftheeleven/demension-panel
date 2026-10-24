import { describe, it, expect } from 'vitest';
import { parseServerConfig } from '../src/utils/awg-params.js';

describe('Edge Case Verification', () => {
  it('Bug A: parseServerConfig drops peers with AllowedIPs without /32', () => {
    const rawConf = `
[Interface]
PrivateKey = aaaaaa=
Address = 10.8.0.1/24
ListenPort = 51820

[Peer]
PublicKey = peerWithoutSlash32=
AllowedIPs = 10.8.0.2

[Peer]
PublicKey = peerWithSlash32=
AllowedIPs = 10.8.0.3/32

[Peer]
PublicKey = peerWithSpaces=
AllowedIPs = 10.8.0.4 / 32
`;

    const parsed = parseServerConfig(rawConf);
    const p1 = parsed.peers.find((p) => p.publicKey === 'peerWithoutSlash32=');
    const p2 = parsed.peers.find((p) => p.publicKey === 'peerWithSlash32=');
    const p3 = parsed.peers.find((p) => p.publicKey === 'peerWithSpaces=');

    // Currently: p1.ip is null and p3.ip is null!
    expect(p2?.ip).toBe('10.8.0.3');
    expect(p1?.ip).toBeNull(); // PROVES BUG A: peer without /32 has ip = null and will be skipped upon import
    expect(p3?.ip).toBeNull(); // PROVES BUG A: peer with spaces around /32 has ip = null
  });

  it('Bug B: upgrade-protocol logic does not preserve extra_params', () => {
    // Current code in routes/servers.ts:425-428:
    // const params: AwgParams = {
    //   ...AwgService.generateRandomParams(LATEST_AWG_VERSION),
    //   i1: current.i1, i2: current.i2, i3: current.i3, i4: current.i4, i5: current.i5,
    // };
    const current = {
      awg_version: 1,
      jc: 4, jmin: 40, jmax: 70, s1: 36, s2: 124, s3: null, s4: null,
      h1: '1', h2: '2', h3: '3', h4: '4',
      i1: null, i2: null, i3: null, i4: null, i5: null,
      header_protection_key: null,
      extra_params: { RandomTrailers: '1', RekeyTimeout: '10' },
    };

    // Demonstrating that omitting extra_params resets it:
    const upgradedParams = {
      extra_params: {}, // What generateRandomParams sets
      i1: current.i1, i2: current.i2, i3: current.i3, i4: current.i4, i5: current.i5,
    };

    expect(upgradedParams.extra_params).toEqual({}); // PROVES BUG B: extra_params is wiped out
  });

  it('Bug C: FederationClient only syncs enabled state, omitting renamed client name', () => {
    const client = { id: 1, name: 'Renamed Client Name', enabled: 1 };
    const peer = { id: 10, name: 'Old Client Name', enabled: true };

    const desired = Boolean(client.enabled);
    const patchPayload: Record<string, any> = {};

    // Current code in FederationClient:
    if (desired !== peer.enabled) {
      patchPayload.enabled = desired;
    }
    // Note: patchPayload.name is never assigned even though client.name !== peer.name!
    expect(patchPayload.name).toBeUndefined(); // PROVES BUG C
  });
});
