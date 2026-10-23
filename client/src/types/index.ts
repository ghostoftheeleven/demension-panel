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
