import React, { useState } from 'react';
import {
  Server as ServerIcon,
  Play,
  Settings2,
  RefreshCw,
  Trash2,
  KeyRound,
  Shield,
  Pencil,
  AlertTriangle,
  Zap,
  ScanSearch,
  ArrowUpCircle,
} from 'lucide-react';
import type { Server } from '../types';
import { api } from '../api';

interface ServerCardsProps {
  servers: Server[];
  selectedServerId: number | null;
  onSelectServer: (id: number) => void;
  onInstallServer: (server: Server) => void;
  onEditParams: (server: Server) => void;
  onServerDeleted: (id: number) => void;
  onEditServer: (server: Server) => void;
  onServerChanged: () => void;
}

const STATUS_LABELS: Record<Server['status'], string> = {
  online: 'AmneziaWG Активен',
  installing: 'Идет установка',
  offline: 'Недоступен',
  error: 'Ошибка',
  uninstalled: 'Не установлен',
};

export const ServerCards: React.FC<ServerCardsProps> = ({
  servers,
  selectedServerId,
  onSelectServer,
  onInstallServer,
  onEditParams,
  onServerDeleted,
  onEditServer,
  onServerChanged,
}) => {
  const [applying, setApplying] = useState<number | null>(null);
  const [scanning, setScanning] = useState<number | null>(null);
  const [upgrading, setUpgrading] = useState<number | null>(null);

  const handleScan = async (server: Server) => {
    setScanning(server.id);
    try {
      const res = await api.scanServer(server.id);
      alert(res.message);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setScanning(null);
      onServerChanged();
    }
  };

  const handleUpgrade = async (server: Server) => {
    const message =
      `Перевести «${server.name}» на AmneziaWG ${server.latest_awg_version}.x?\n\n` +
      'Будут сгенерированы параметры актуальной версии, AmneziaWG переустановлен с последним образом (клиенты сохраняются). ' +
      'Все пользователи должны обновить подписку или конфигурацию.';
    if (!confirm(message)) return;
    setUpgrading(server.id);
    try {
      const res = await api.upgradeProtocol(server.id);
      alert(res.success ? 'Сервер переведён на актуальную версию AmneziaWG.' : `Ошибка переустановки: ${res.error}`);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setUpgrading(null);
      onServerChanged();
    }
  };
  const [testingSsh, setTestingSsh] = useState<number | null>(null);
  const [syncing, setSyncing] = useState<number | null>(null);

  const selectedServer = servers.find((s) => s.id === selectedServerId) || servers[0];

  const handleTestSsh = async (serverId: number) => {
    setTestingSsh(serverId);
    try {
      const res = await api.testSsh(serverId);
      alert(res.message);
    } catch (err: any) {
      alert(`Ошибка SSH: ${err.message}`);
    } finally {
      setTestingSsh(null);
    }
  };

  const handleSync = async (serverId: number) => {
    setSyncing(serverId);
    try {
      const res = await api.syncServer(serverId);
      if (res.success) {
        alert('Пиры успешно синхронизированы на сервере!');
      } else {
        alert(`Ошибка синхронизации: ${res.error}`);
      }
    } catch (err: any) {
      alert(err.message);
    } finally {
      setSyncing(null);
      onServerChanged();
    }
  };

  const handleApply = async (serverId: number) => {
    setApplying(serverId);
    try {
      const res = await api.applyServer(serverId);
      alert(res.success ? 'Параметры применены, AmneziaWG перезапущен.' : `Ошибка применения: ${res.error}`);
    } finally {
      setApplying(null);
      onServerChanged();
    }
  };

  const handleDelete = async (server: Server) => {
    if (!confirm(`Удалить сервер "${server.name}" из панели вместе со всеми его клиентами?`)) return;
    const teardown =
      server.status !== 'uninstalled' &&
      confirm(
        'Остановить и удалить AmneziaWG на самом сервере?\n\n' +
          'ОК — VPN на сервере будет отключён.\n' +
          'Отмена — удалить только из панели (VPN на сервере продолжит работать для всех выданных конфигов).'
      );
    try {
      await api.deleteServer(server.id, { teardown });
      onServerDeleted(server.id);
    } catch (err: any) {
      if (teardown && confirm(`${err.message}\n\nУдалить сервер из панели принудительно?`)) {
        await api.deleteServer(server.id, { force: true }).catch((e) => alert(e.message));
        onServerDeleted(server.id);
      } else {
        alert(err.message);
      }
    }
  };

  if (servers.length === 0) {
    return null;
  }

  return (
    <div className="space-y-4">
      {/* Server Switcher Tabs */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {servers.map((s) => {
          const isSelected = s.id === selectedServer?.id;
          const isOnline = s.status === 'online';

          return (
            <button
              key={s.id}
              onClick={() => onSelectServer(s.id)}
              className={`flex items-center gap-2.5 px-4 py-2.5 rounded-xl border text-xs font-medium transition flex-shrink-0 ${
                isSelected
                  ? 'bg-zinc-800/90 border-emerald-500/40 text-white shadow-lg shadow-emerald-950/40'
                  : 'bg-zinc-900/50 border-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-800/50'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  isOnline
                    ? 'bg-emerald-400 shadow-sm shadow-emerald-400'
                    : s.status === 'installing'
                    ? 'bg-amber-400 animate-ping'
                    : s.status === 'error'
                    ? 'bg-red-400'
                    : s.status === 'offline'
                    ? 'bg-orange-400'
                    : 'bg-zinc-500'
                }`}
              />
              <span className="font-semibold">{s.name}</span>
              <span className="text-[11px] font-mono text-zinc-500">{s.host}</span>
            </button>
          );
        })}
      </div>

      {/* Selected Server Detailed Card */}
      {selectedServer && (
        <div className="bg-gradient-to-b from-zinc-900/90 to-zinc-950/90 border border-zinc-800/90 rounded-2xl p-6 shadow-2xl space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            {/* Left Info */}
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-2xl bg-zinc-800/80 border border-zinc-700/50 flex items-center justify-center flex-shrink-0">
                <ServerIcon className="w-6 h-6 text-emerald-400" />
              </div>
              <div>
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-bold text-white tracking-tight">{selectedServer.name}</h2>
                  <span
                    className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                      selectedServer.status === 'online'
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                        : selectedServer.status === 'installing'
                        ? 'bg-amber-400/10 text-amber-400 border border-amber-400/20'
                        : selectedServer.status === 'error'
                        ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                        : selectedServer.status === 'offline'
                        ? 'bg-orange-500/10 text-orange-400 border border-orange-500/20'
                        : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                    }`}
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-current" />
                    {STATUS_LABELS[selectedServer.status]}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-4 text-xs text-zinc-400 mt-1 font-mono">
                  <span>Хост: <strong className="text-zinc-200">{selectedServer.host}</strong></span>
                  <span>SSH Порт: <strong className="text-zinc-200">{selectedServer.ssh_port}</strong></span>
                  <span>AWG Порт: <strong className="text-zinc-200">{selectedServer.awg_port} (UDP)</strong></span>
                  <span>Подсеть: <strong className="text-zinc-200">{selectedServer.subnet}</strong></span>
                </div>
              </div>
            </div>

            {/* Right Quick Actions */}
            <div className="flex flex-wrap items-center gap-2">
              {selectedServer.remote_panel_id ? (
                <span className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 px-3 py-2 rounded-xl">
                  Нода партнёра · {selectedServer.remote_panel_name}
                </span>
              ) : (
              <>
              <button
                onClick={() => onInstallServer(selectedServer)}
                className="flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-medium text-xs px-4 py-2.5 rounded-xl transition shadow-lg shadow-emerald-600/20 active:scale-[0.98]"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>
                  {selectedServer.status === 'uninstalled' ? 'Установить AmneziaWG' : 'Переустановить AWG'}
                </span>
              </button>

              <button
                onClick={() => onEditParams(selectedServer)}
                className="flex items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium px-3.5 py-2.5 rounded-xl border border-zinc-700/60 transition"
                title="Настроить заголовки и мусорные пакеты"
              >
                <Settings2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>Параметры AWG</span>
              </button>

              <button
                onClick={() => handleTestSsh(selectedServer.id)}
                disabled={testingSsh === selectedServer.id}
                className="flex items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium px-3.5 py-2.5 rounded-xl border border-zinc-700/60 transition"
                title="Проверить SSH-соединение"
              >
                <KeyRound className="w-3.5 h-3.5 text-cyan-400" />
                <span>{testingSsh === selectedServer.id ? 'Тест...' : 'Тест SSH'}</span>
              </button>
              </>
              )}

              {(selectedServer.status === 'uninstalled' || selectedServer.status === 'error') && (
                <button
                  onClick={() => handleScan(selectedServer)}
                  disabled={scanning === selectedServer.id}
                  className="flex items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium px-3.5 py-2.5 rounded-xl border border-zinc-700/60 transition"
                  title="Найти уже установленный AmneziaWG и подключить без переустановки"
                >
                  <ScanSearch className="w-3.5 h-3.5 text-cyan-400" />
                  <span>{scanning === selectedServer.id ? 'Сканирование...' : 'Сканировать'}</span>
                </button>
              )}

              <button
                onClick={() => onEditServer(selectedServer)}
                className="flex items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium px-3.5 py-2.5 rounded-xl border border-zinc-700/60 transition"
                title="Хост, SSH-доступ, порт"
              >
                <Pencil className="w-3.5 h-3.5 text-zinc-300" />
                <span>Настройки</span>
              </button>

              {selectedServer.status !== 'uninstalled' && selectedServer.status !== 'installing' && (
                <button
                  onClick={() => handleSync(selectedServer.id)}
                  disabled={syncing === selectedServer.id}
                  className="flex items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium px-3.5 py-2.5 rounded-xl border border-zinc-700/60 transition"
                  title="Синхронизировать конфигурацию на сервере"
                >
                  <RefreshCw className={`w-3.5 h-3.5 text-emerald-400 ${syncing === selectedServer.id ? 'animate-spin' : ''}`} />
                  <span>Синхронизация</span>
                </button>
              )}

              {!selectedServer.remote_panel_id && (
              <button
                onClick={() => handleDelete(selectedServer)}
                className="p-2.5 text-zinc-500 hover:text-red-400 hover:bg-zinc-800/80 rounded-xl transition"
                title="Удалить сервер"
              >
                <Trash2 className="w-4 h-4" />
              </button>
              )}
            </div>
          </div>

          {(selectedServer.needs_apply || selectedServer.needs_sync || selectedServer.last_error) && selectedServer.status !== 'uninstalled' && (
            <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-3.5 flex flex-wrap items-start justify-between gap-3 text-xs">
              <div className="flex items-start gap-2 text-amber-300">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <div className="space-y-1">
                  {selectedServer.needs_apply && <p>Параметры интерфейса изменены, но ещё не применены на сервере.</p>}
                  {selectedServer.needs_sync && !selectedServer.needs_apply && (
                    <p>Изменения клиентов ещё не доставлены на сервер — панель повторит попытку автоматически.</p>
                  )}
                  {selectedServer.last_error && <p className="text-amber-200/80 break-all">Последняя ошибка: {selectedServer.last_error}</p>}
                </div>
              </div>
              {selectedServer.needs_apply && (
                <button
                  onClick={() => handleApply(selectedServer.id)}
                  disabled={applying === selectedServer.id}
                  className="flex items-center gap-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 font-medium px-3 py-1.5 rounded-lg transition"
                >
                  <Zap className="w-3.5 h-3.5" />
                  <span>{applying === selectedServer.id ? 'Применение...' : 'Применить сейчас'}</span>
                </button>
              )}
            </div>
          )}

          {selectedServer.remote_panel_id && (
            <div className="bg-zinc-950/70 border border-zinc-800 rounded-xl p-3.5 text-xs text-zinc-400">
              Нода предоставлена панелью партнёра «{selectedServer.remote_panel_name}». Параметры, установку и обновления выполняет владелец;
              вы можете создавать на ней клиентов и выдавать её своим пользователям. Владелец видит ваших клиентов и может их заблокировать.
              {selectedServer.status === 'uninstalled' && selectedServer.last_error && (
                <span className="block text-amber-300 mt-1">{selectedServer.last_error}</span>
              )}
            </div>
          )}

          {!selectedServer.remote_panel_id && selectedServer.awg_version < selectedServer.latest_awg_version && (
            <div className="bg-cyan-500/5 border border-cyan-500/20 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs">
              <span className="text-cyan-200">
                Используются параметры обфускации устаревшего AmneziaWG 1.x. Актуальная версия — {selectedServer.latest_awg_version}.x
                (S3/S4, диапазоны заголовков, защита заголовков).
              </span>
              <button
                onClick={() => handleUpgrade(selectedServer)}
                disabled={upgrading === selectedServer.id}
                className="flex items-center gap-1.5 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-100 font-medium px-3 py-1.5 rounded-lg transition"
              >
                <ArrowUpCircle className="w-3.5 h-3.5" />
                <span>{upgrading === selectedServer.id ? 'Обновление...' : `Перейти на ${selectedServer.latest_awg_version}.x`}</span>
              </button>
            </div>
          )}

          {selectedServer.managed_by === 'amnezia' && (
            <div className="bg-zinc-950/70 border border-zinc-800 rounded-xl p-3.5 text-xs text-zinc-400">
              Подключён контейнер приложения Amnezia (<span className="font-mono">{selectedServer.container_name}</span>).
              Управляйте клиентами только из панели: изменения в приложении Amnezia будут перезаписаны при синхронизации.
              Смена порта или «Переустановить AWG» заменит его контейнером панели с теми же ключами и клиентами.
            </div>
          )}

          {/* Obfuscation Badges Banner */}
          <div className="bg-zinc-950/70 border border-zinc-800/80 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 text-zinc-400">
              <Shield className="w-4 h-4 text-emerald-400" />
              <span className="font-medium text-zinc-300">Активная маскировка (DPI Bypass):</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
              <span className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300">
                Jc: <strong className="text-emerald-400">{selectedServer.jc}</strong>
              </span>
              <span className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300">
                Junk: <strong className="text-emerald-400">{selectedServer.jmin}-{selectedServer.jmax}B</strong>
              </span>
              <span className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300">
                AWG: <strong className="text-emerald-400">{selectedServer.awg_version >= 3 ? '3.x' : '1.x'}</strong>
              </span>
              <span className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300">
                S1–S{selectedServer.s3 !== null ? 4 : 2}:{' '}
                <strong className="text-cyan-400">
                  {[selectedServer.s1, selectedServer.s2, selectedServer.s3, selectedServer.s4].filter((v) => v !== null).join('/')}B
                </strong>
              </span>
              <span className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300">
                H1-H4: <strong className="text-purple-400">{selectedServer.h1.includes('-') ? 'диапазоны' : 'значения'}</strong>
              </span>
              {selectedServer.header_protection_key && (
                <span className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300">
                  <strong className="text-amber-400">Защита заголовков</strong>
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
