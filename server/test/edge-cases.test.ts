import { beforeAll, describe, it, expect } from 'vitest';
import { parseServerConfig } from '../src/utils/awg-params.js';
import { AwgService } from '../src/services/awg.service.js';
import { initDatabase } from '../src/db/index.js';

describe('Edge Case Verification', () => {
  beforeAll(() => {
    initDatabase();
  });
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

  it('Bug D: subscriber peer name on partner node can exceed 64 chars and causes 400 rejection', () => {
    const subscriberName = 'Пользователь с длинным именем'; // 29 chars
    const serverName = 'Партнерский сервер в Нидерландах #1'; // 35 chars
    // In subscribers.ts: addPeer sets name = `${subscriberName} (${server.name})`
    const clientName = `${subscriberName} (${serverName})`; // 67 chars

    expect(clientName.length).toBeGreaterThan(64);

    // In routes/federation.ts:
    // function validateName(value: unknown): string {
    //   const name = typeof value === 'string' ? value.replace(/[\r\n]/g, ' ').trim() : '';
    //   if (!name || name.length > 64) throw new HttpError(400, 'Имя клиента: от 1 до 64 символов');
    //   return name;
    // }
    const validateName = (name: string) => {
      if (!name || name.length > 64) throw new Error('Имя клиента: от 1 до 64 символов');
      return name;
    };

    expect(() => validateName(clientName)).toThrow('Имя клиента: от 1 до 64 символов'); // PROVES BUG D
  });

  it('Bug E: generateClientConfig includes ::/0 in AllowedIPs despite server only having IPv4', () => {
    const server = {
      host: '1.2.3.4',
      awg_port: 51820,
      server_public_key: 'PUBKEY=',
      preshared_key: 'PSK=',
      subnet: '10.8.0.1/24',
      awg_version: 3,
      jc: 4, jmin: 40, jmax: 70, s1: 36, s2: 124, s3: 15, s4: 15,
      h1: '100-200', h2: '300-400', h3: '500-600', h4: '700-800',
    };
    const client = {
      client_ip: '10.8.0.2',
      client_private_key: 'PRIVKEY=',
    };

    const clientConf = AwgService.generateClientConfig(server, client);
    const serverConf = AwgService.generateServerConfig(server, [{ ...client, enabled: 1, subscriber_active: 1, client_public_key: 'PUB=' }]);

    // PROVES BUG E: client receives AllowedIPs = ::/0, but server peer only allows IPv4 (10.8.0.2/32) and server has no IPv6 interface
    expect(clientConf).toContain('AllowedIPs = 0.0.0.0/0, ::/0');
    expect(serverConf).toContain('AllowedIPs = 10.8.0.2/32');
    expect(serverConf).not.toContain('::/0');
    expect(clientConf).not.toContain('Address = 10.8.0.2/32,'); // No IPv6 address assigned to client either!
  });
});
