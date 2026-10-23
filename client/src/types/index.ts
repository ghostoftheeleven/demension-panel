export interface AdminUser {
  id: number;
  username: string;
}

export interface Subscriber {
  id: number;
  name: string;
  token: string;
  enabled: number;
  traffic_limit: number;
  expire_at: string | null;
  created_at: string;
  total_rx: number;
  total_tx: number;
  peer_count: number;
  server_ids: number[];
  servers: {
    id: number;
    name: string;
    host: string;
    client_ip: string;
    enabled: number;
  }[];
}

export interface Server {
  id: number;
  name: string;
  host: string;
  ssh_port: number;
  ssh_user: string;
  awg_port: number;
  subnet: string;
  server_public_key: string | null;
  preshared_key: string | null;
  jc: number;
  jmin: number;
  jmax: number;
  s1: number;
  s2: number;
  h1: number;
  h2: number;
  h3: number;
  h4: number;
  status: 'uninstalled' | 'installing' | 'online' | 'offline' | 'error';
  client_count?: number;
  active_client_count?: number;
  last_seen?: string;
  created_at: string;
}

export interface Client {
  id: number;
  server_id: number;
  subscriber_id?: number | null;
  name: string;
  client_ip: string;
  client_public_key: string;
  client_private_key: string;
  preshared_key: string;
  enabled: number;
  total_rx: number;
  total_tx: number;
  last_handshake: string | null;
  created_at: string;
}

export interface QrCodeData {
  qrcode: string;
  config: string;
  clientName: string;
}

export interface SslStatus {
  enabled: boolean;
  hasCert: boolean;
  domain: string | null;
  mode: 'letsencrypt_cf' | 'letsencrypt_http' | 'selfsigned_ip' | 'custom' | null;
  expiresAt: string | null;
}

export interface Fail2banStatus {
  installed: boolean;
  active: boolean;
  jail: string;
  totalFailed: number;
  totalBanned: number;
  currentlyBanned: string[];
  maxRetry: number;
  banTime: number;
  findTime: number;
}

export interface CloudflareZone {
  id: string;
  name: string;
}
