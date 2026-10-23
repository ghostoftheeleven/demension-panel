import crypto from 'node:crypto';
import { db } from '../db/index.js';

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
   * Generate 32-byte random Pre-shared Key (PSK) in Base64
   */
  static generatePresharedKey(): string {
    return crypto.randomBytes(32).toString('base64');
  }

  /**
   * Generate randomized AmneziaWG obfuscation parameters
   */
  static generateRandomParams(): AwgParams {
    const randomInt = (min: number, max: number) =>
      Math.floor(Math.random() * (max - min + 1)) + min;

    // H1-H4 are custom 32-bit positive integers
    return {
      jc: randomInt(3, 7),
      jmin: randomInt(30, 45),
      jmax: randomInt(60, 95),
      s1: randomInt(20, 100),
      s2: randomInt(50, 150),
      h1: randomInt(100000000, 999999999),
      h2: randomInt(100000000, 999999999),
      h3: randomInt(100000000, 999999999),
      h4: randomInt(100000000, 999999999),
    };
  }

  /**
   * Calculate next available IP address for a client on the given server
   */
  static getNextClientIp(serverId: number, subnet = '10.8.0.1/24'): string {
    const prefix = subnet.split('/')[0].split('.').slice(0, 3).join('.');
    
    // Get all assigned client IPs for this server
    const rows = db.prepare('SELECT client_ip FROM clients WHERE server_id = ?').all(serverId) as { client_ip: string }[];
    const usedOctets = new Set<number>();
    usedOctets.add(1); // Server IP is usually .1

    for (const row of rows) {
      const parts = row.client_ip.split('.');
      if (parts.length === 4) {
        const last = parseInt(parts[3], 10);
        if (!isNaN(last)) usedOctets.add(last);
      }
    }

    // Find first free octet from 2 to 254
    for (let octet = 2; octet <= 254; octet++) {
      if (!usedOctets.has(octet)) {
        return `${prefix}.${octet}`;
      }
    }

    throw new Error('Подсеть переполнена: нет свободных IP-адресов');
  }

  /**
   * Generate client .conf file string
   */
  static generateClientConfig(server: any, client: any, dns = '1.1.1.1, 8.8.8.8'): string {
    return `[Interface]
Address = ${client.client_ip}/32
DNS = ${dns}
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
Endpoint = ${server.host}:${server.awg_port}
PersistentKeepalive = 25
`;
  }

  /**
   * Generate full server awg0.conf containing interface and all active peers
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
      if (client.enabled) {
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
}
