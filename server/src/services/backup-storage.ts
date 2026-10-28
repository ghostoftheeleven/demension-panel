export interface RemoteBackup {
  id: string;
  name: string;
  created_at: string;
  size: number;
}

export interface BackupStorage {
  test(): Promise<void>;
  upload(name: string, data: Buffer): Promise<void>;
  list(): Promise<RemoteBackup[]>;
  download(id: string): Promise<Buffer>;
  delete(id: string): Promise<void>;
}

const TIMEOUT = 30000;
async function checked(response: Response, expected: number[]): Promise<Response> {
  if (!expected.includes(response.status)) throw new Error(`Хранилище вернуло HTTP ${response.status}`);
  return response;
}
const segment = (value: string) => encodeURIComponent(value);

export interface YandexSettings { username: string; password: string }
export class YandexDiskStorage implements BackupStorage {
  constructor(private settings: YandexSettings) {}
  private request(path: string, method: string, body?: Buffer): Promise<Response> {
    return fetch(`https://webdav.yandex.ru${path}`, {
      method,
      headers: { Authorization: `Basic ${Buffer.from(`${this.settings.username}:${this.settings.password}`).toString('base64')}` },
      body,
      signal: AbortSignal.timeout(TIMEOUT),
    });
  }
  async test(): Promise<void> {
    await checked(await this.request('/dementia-panel/', 'MKCOL'), [201, 405]);
  }
  async upload(name: string, data: Buffer): Promise<void> {
    await this.test();
    await checked(await this.request(`/dementia-panel/${segment(name)}`, 'PUT', data), [201, 202, 204]);
  }
  async list(): Promise<RemoteBackup[]> {
    const response = await checked(await this.request('/dementia-panel/', 'PROPFIND'), [207]);
    const xml = (await response.text()).slice(0, 2_000_000);
    return [...xml.matchAll(/<(?:\w+:)?response>([\s\S]*?)<\/(?:\w+:)?response>/g)].flatMap((match) => {
      const href = /<(?:\w+:)?href>([^<]+)/.exec(match[1])?.[1];
      const name = href ? decodeURIComponent(href.split('/').filter(Boolean).pop() ?? '') : '';
      if (!/^dementia-\d{4}-\d{2}-\d{2}T[\d-]+Z\.dpm$/.test(name)) return [];
      const modified = /<(?:\w+:)?getlastmodified>([^<]+)/.exec(match[1])?.[1];
      const size = Number(/<(?:\w+:)?getcontentlength>(\d+)/.exec(match[1])?.[1] ?? 0);
      return [{ id: name, name, created_at: modified && !Number.isNaN(Date.parse(modified)) ? new Date(modified).toISOString() : '', size }];
    }).slice(0, 100);
  }
  async download(id: string): Promise<Buffer> {
    this.validateId(id);
    const response = await checked(await this.request(`/dementia-panel/${segment(id)}`, 'GET'), [200]);
    return Buffer.from(await response.arrayBuffer());
  }
  async delete(id: string): Promise<void> {
    this.validateId(id);
    await checked(await this.request(`/dementia-panel/${segment(id)}`, 'DELETE'), [200, 202, 204, 404]);
  }
  private validateId(id: string): void {
    if (!/^dementia-\d{4}-\d{2}-\d{2}T[\d-]+Z\.dpm$/.test(id)) throw new Error('Некорректный идентификатор копии');
  }
}

export interface GoogleSettings { client_id: string; client_secret: string; refresh_token: string; folder_id?: string }
export class GoogleDriveStorage implements BackupStorage {
  private accessToken: { value: string; expires: number } | null = null;
  constructor(private settings: GoogleSettings) {}
  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expires > Date.now() + 60000) return this.accessToken.value;
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.settings.client_id, client_secret: this.settings.client_secret, refresh_token: this.settings.refresh_token, grant_type: 'refresh_token' }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    await checked(response, [200]);
    const data = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof data.access_token !== 'string' || data.access_token.length > 4096) throw new Error('Google не выдал токен доступа');
    this.accessToken = { value: data.access_token, expires: Date.now() + Math.min(Math.max(Number(data.expires_in) || 3600, 60), 3600) * 1000 };
    return this.accessToken.value;
  }
  private async request(url: string, options: RequestInit = {}): Promise<Response> {
    return fetch(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(TIMEOUT) });
  }
  private folder(): string {
    const id = this.settings.folder_id || 'root';
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error('Некорректный ID папки Google Drive');
    return id;
  }
  async test(): Promise<void> { await this.list(); }
  async upload(name: string, data: Buffer): Promise<void> {
    const boundary = `dementia-${Date.now()}`;
    const metadata = JSON.stringify({ name, parents: [this.folder()] });
    const head = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const body = Buffer.concat([head, data, Buffer.from(`\r\n--${boundary}--`)]);
    await checked(await this.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body }), [200]);
  }
  async list(): Promise<RemoteBackup[]> {
    const params = new URLSearchParams({ q: `'${this.folder()}' in parents and trashed=false`, fields: 'files(id,name,createdTime,size)', orderBy: 'createdTime desc', pageSize: '100', spaces: 'drive' });
    const response = await checked(await this.request(`https://www.googleapis.com/drive/v3/files?${params}`), [200]);
    const data = await response.json() as { files?: unknown };
    if (!Array.isArray(data.files)) throw new Error('Некорректный ответ Google Drive');
    return data.files.flatMap((file: any) => {
      if (!file || typeof file.id !== 'string' || !/^[\w-]{1,200}$/.test(file.id) || typeof file.name !== 'string' || !/^dementia-\d{4}-\d{2}-\d{2}T[\d-]+Z\.dpm$/.test(file.name)) return [];
      return [{ id: file.id, name: file.name.slice(0, 200), created_at: typeof file.createdTime === 'string' && !Number.isNaN(Date.parse(file.createdTime)) ? new Date(file.createdTime).toISOString() : '', size: Math.max(0, Number(file.size) || 0) }];
    });
  }
  async download(id: string): Promise<Buffer> {
    this.validateId(id);
    const response = await checked(await this.request(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`), [200]);
    return Buffer.from(await response.arrayBuffer());
  }
  async delete(id: string): Promise<void> {
    this.validateId(id);
    await checked(await this.request(`https://www.googleapis.com/drive/v3/files/${id}`, { method: 'DELETE' }), [204, 404]);
  }
  private validateId(id: string): void {
    if (!/^[\w-]{1,200}$/.test(id)) throw new Error('Некорректный идентификатор копии');
  }
}
