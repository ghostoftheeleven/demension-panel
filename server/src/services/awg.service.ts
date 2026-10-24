import crypto from 'node:crypto';
import { db, getSetting } from '../db/index.js';
import { allocateIp, formatEndpointHost, parseSubnet } from '../utils/net.js';

export interface AwgParams {
  jc: number;
  jmin: number;
  jmax: number;
  s1: number;
  s2: number;
  h1: number;
  h2: number;
  h3: number;
  h4: number;
}

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

export interface ClientNetworkSettings {
  dns: string;
  mtu: number;
}

const MAX_HEADER = 0xffffffff;

export class AwgService {
  /**
   * Generate Curve25519 (x25519) keypair in WireGuard/AmneziaWG Base64 format
   */
  static generateKeyPair(): KeyPair {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');

    // In PKCS#8 DER format, the raw 32-byte private key starts at byte offset 16
    const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
    const privBase64 = privDer.subarray(16).toString('base64');

    // In SPKI DER format, the raw 32-byte public key starts at byte offset 12
    const pubDer = publicKey.export({ type: 'spki', format: 'der' });
    const pubBase64 = pubDer.subarray(12).toString('base64');

    return {
      privateKey: privBase64,
      publicKey: pubBase64,
    };
  }

  /**
   * Derive public key from a Base64 private key
   */
  static derivePublicKey(privateKeyBase64: string): string {
    const raw = Buffer.from(privateKeyBase64, 'base64');
    const der = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]);
    const privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    return crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
  }

  /**
   * Generate 32-byte random Pre-shared Key (PSK) in Base64
   */
  static generatePresharedKey(): string {
    return crypto.randomBytes(32).toString('base64');
  }

  /**
   * Generate randomized AmneziaWG obfuscation parameters that satisfy protocol constraints
   */
  static generateRandomParams(): AwgParams {
    const randomInt = (min: number, max: number) => crypto.randomInt(min, max + 1);

    const jmin = randomInt(30, 60);
    const jmax = randomInt(jmin + 20, jmin + 60);
    const s1 = randomInt(15, 120);
    let s2 = randomInt(15, 120);
    while (s1 + 56 === s2) s2 = randomInt(15, 120);

    // H1-H4: попарно различные 32-битные значения, не пересекающиеся со стандартными типами WireGuard (1-4)
    const headers = new Set<number>();
    while (headers.size < 4) headers.add(randomInt(100000000, 2147483647));
    const [h1, h2, h3, h4] = [...headers];

    return { jc: randomInt(3, 10), jmin, jmax, s1, s2, h1, h2, h3, h4 };
  }

  /**
   * Validate obfuscation parameters; returns error message or null
   */
  static validateParams(p: AwgParams): string | null {
    const ints = Object.entries(p);
    for (const [key, value] of ints) {
      if (!Number.isInteger(value) || value < 0) return `Параметр ${key.toUpperCase()} должен быть целым неотрицательным числом`;
    }
    if (p.jc < 1 || p.jc > 128) return 'Jc должен быть в диапазоне 1–128';
    if (p.jmin >= p.jmax) return 'Jmin должен быть меньше Jmax';
    if (p.jmax > 1280) return 'Jmax не может превышать 1280';
    if (p.s1 > 1132) return 'S1 не может превышать 1132';
    if (p.s2 > 1188) return 'S2 не может превышать 1188';
    if (p.s1 + 56 === p.s2) return 'S1 + 56 не должно быть равно S2 (пакеты станут неразличимы)';
    const headers = [p.h1, p.h2, p.h3, p.h4];
    if (headers.some((h) => h < 5 || h > MAX_HEADER)) return `H1–H4 должны быть в диапазоне 5–${MAX_HEADER}`;
    if (new Set(headers).size !== 4) return 'H1–H4 должны быть попарно различными';
    return null;
  }

  /**
   * Calculate next available IP address for a client on the given server
   */
  static getNextClientIp(serverId: number, subnet = '10.8.0.1/24'): string {
    const rows = db.prepare('SELECT client_ip FROM clients WHERE server_id = ?').all(serverId) as { client_ip: string }[];
    return allocateIp(subnet, rows.map((r) => r.client_ip));
  }

  static getClientNetworkSettings(): ClientNetworkSettings {
    const mtu = Number(getSetting('client_mtu'));
    return {
      dns: getSetting('client_dns') || '1.1.1.1, 8.8.8.8',
      mtu: Number.isInteger(mtu) && mtu >= 576 && mtu <= 1500 ? mtu : 1280,
    };
  }

  /**
   * Generate client .conf file string
   */
  static generateClientConfig(server: any, client: any, settings = AwgService.getClientNetworkSettings()): string {
    return `[Interface]
Address = ${client.client_ip}/32
DNS = ${settings.dns}
MTU = ${settings.mtu}
PrivateKey = ${client.client_private_key}
Jc = ${server.jc}
Jmin = ${server.jmin}
Jmax = ${server.jmax}
S1 = ${server.s1}
S2 = ${server.s2}
H1 = ${server.h1}
H2 = ${server.h2}
H3 = ${server.h3}
H4 = ${server.h4}

[Peer]
PublicKey = ${server.server_public_key}
PresharedKey = ${client.preshared_key || server.preshared_key}
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = ${formatEndpointHost(server.host)}:${server.awg_port}
PersistentKeepalive = 25
`;
  }

  /**
   * Generate full server awg0.conf containing interface and all active peers.
   * Peer is active when the client is enabled and (if it belongs to a subscriber) the subscriber is active.
   */
  static generateServerConfig(server: any, clients: any[]): string {
    let conf = `[Interface]
PrivateKey = ${server.server_private_key}
Address = ${server.subnet}
ListenPort = ${server.awg_port}
Jc = ${server.jc}
Jmin = ${server.jmin}
Jmax = ${server.jmax}
S1 = ${server.s1}
S2 = ${server.s2}
H1 = ${server.h1}
H2 = ${server.h2}
H3 = ${server.h3}
H4 = ${server.h4}
`;

    for (const client of clients) {
      if (client.enabled && client.subscriber_active !== 0) {
        conf += `
[Peer]
PublicKey = ${client.client_public_key}
PresharedKey = ${client.preshared_key || server.preshared_key}
AllowedIPs = ${client.client_ip}/32
`;
      }
    }

    return conf;
  }

  /**
   * Network address of the tunnel subnet (used for NAT inside the container)
   */
  static getTunnelNetwork(subnet: string): string {
    return parseSubnet(subnet).network;
  }
}
