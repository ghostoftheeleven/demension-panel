export interface AdminUser {
  id: number;
  username: string;
}

export interface Subscriber {
  id: number;
  name: string;
  token: string;
  enabled: number;
  /** Лимит трафика в байтах (0 — без лимита) */
  traffic_limit: number;
  expire_at: string | null;
  created_at: string;
  /** Приостановлена из-за истечения срока или превышения лимита */
  suspended: boolean;
  expired: boolean;
  /** Отправлено пользователем (upload) */
  total_rx: number;
  /** Получено пользователем (download) */
  total_tx: number;
  traffic_used: number;
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

export type ServerStatus = 'uninstalled' | 'installing' | 'online' | 'offline' | 'error';

export interface Server {
  id: number;
  name: string;
  host: string;
  ssh_port: number;
  ssh_user: string;
  has_ssh_password: boolean;
  has_ssh_key: boolean;
  host_key: string | null;
  awg_port: number;
  deployed_port: number | null;
  subnet: string;
  server_public_key: string | null;
  jc: number;
  jmin: number;
  jmax: number;
  s1: number;
  s2: number;
  h1: number;
  h2: number;
  h3: number;
  h4: number;
  status: ServerStatus;
  needs_sync: boolean;
  needs_apply: boolean;
  installing: boolean;
  last_error: string | null;
  client_count?: number;
  active_client_count?: number;
  last_seen?: string;
  created_at: string;
}

export interface ServerUpdate {
  name?: string;
  host?: string;
  ssh_port?: number;
  ssh_user?: string;
  auth_type?: 'password' | 'key';
  ssh_password?: string;
  ssh_key?: string;
  reset_host_key?: boolean;
  awg_port?: number;
  subnet?: string;
  jc?: number;
  jmin?: number;
  jmax?: number;
  s1?: number;
  s2?: number;
  h1?: number;
  h2?: number;
  h3?: number;
  h4?: number;
}

export interface Client {
  id: number;
  server_id: number;
  subscriber_id?: number | null;
  name: string;
  client_ip: string;
  client_public_key: string;
  preshared_key: string;
  enabled: number;
  /** Отправлено клиентом (upload) */
  total_rx: number;
  /** Получено клиентом (download) */
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
  autoRenew: boolean;
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

export interface PanelSettings {
  public_url: string;
  client_dns: string;
  client_mtu: number;
}

export interface SubscriptionSettings {
  title: string;
  description: string;
  update_interval: number;
  announce: string;
  announce_url: string;
  support_url: string;
  support_email: string;
  web_page_url: string;
  sort_order: '' | 'ping' | 'name' | 'none';
  hide_url: boolean;
}

export interface SubscriptionServer {
  id: number;
  name: string;
  host: string;
  status: ServerStatus;
  sub_name: string | null;
  sub_order: number;
}
