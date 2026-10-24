import { Router } from 'express';
import net from 'node:net';
import { getSetting, setSetting } from '../db/index.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { HttpError } from '../utils/http.js';
import { DEFAULT_AWG_IMAGE } from '../services/provision.service.js';

export const settingsRouter = Router();

settingsRouter.use(requireAuth);

export interface PanelSettings {
  public_url: string;
  client_dns: string;
  client_mtu: number;
  sub_update_interval: number;
  sub_title: string;
  awg_image: string;
}

function readSettings(): PanelSettings {
  return {
    public_url: getSetting('public_url') || '',
    client_dns: getSetting('client_dns') || '1.1.1.1, 8.8.8.8',
    client_mtu: Number(getSetting('client_mtu')) || 1280,
    sub_update_interval: Number(getSetting('sub_update_interval')) || 12,
    sub_title: getSetting('sub_title') || '',
    awg_image: getSetting('awg_image') || DEFAULT_AWG_IMAGE,
  };
}

settingsRouter.get('/', (req, res) => {
  res.json(readSettings());
});

settingsRouter.put('/', (req, res) => {
  const body = req.body ?? {};

  if (body.public_url !== undefined) {
    const value = String(body.public_url).trim().replace(/\/+$/, '');
    if (value) {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new HttpError(400, 'Публичный адрес должен быть URL вида https://panel.example.com');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(400, 'Допустимы только http:// и https://');
    }
    setSetting('public_url', value || null);
  }

  if (body.client_dns !== undefined) {
    const servers = String(body.client_dns).split(',').map((s) => s.trim()).filter(Boolean);
    if (servers.length === 0 || servers.length > 4 || servers.some((s) => !net.isIP(s))) {
      throw new HttpError(400, 'DNS: от 1 до 4 IP-адресов через запятую');
    }
    setSetting('client_dns', servers.join(', '));
  }

  if (body.client_mtu !== undefined) {
    const mtu = Number(body.client_mtu);
    if (!Number.isInteger(mtu) || mtu < 576 || mtu > 1500) throw new HttpError(400, 'MTU должен быть от 576 до 1500');
    setSetting('client_mtu', String(mtu));
  }

  if (body.sub_update_interval !== undefined) {
    const hours = Number(body.sub_update_interval);
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new HttpError(400, 'Интервал обновления: от 1 до 168 часов');
    setSetting('sub_update_interval', String(hours));
  }

  if (body.sub_title !== undefined) {
    const title = String(body.sub_title).trim();
    if (title.length > 25) throw new HttpError(400, 'Название подписки не длиннее 25 символов');
    setSetting('sub_title', title || null);
  }

  if (body.awg_image !== undefined) {
    const image = String(body.awg_image).trim();
    if (image && !/^[a-z0-9][a-z0-9._\/-]*(:[\w.-]+)?(@sha256:[a-f0-9]{64})?$/i.test(image)) {
      throw new HttpError(400, 'Некорректное имя Docker-образа');
    }
    setSetting('awg_image', image || null);
  }

  res.json(readSettings());
});
