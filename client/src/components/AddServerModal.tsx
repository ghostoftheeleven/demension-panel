import React, { useEffect, useState } from 'react';
import { X, Server, Key, Lock, Shield } from 'lucide-react';
import { api } from '../api';
import { AmneziaImportPanel } from './AmneziaImportPanel';
import type { Server as ServerType, ServerUpdate } from '../types';

interface AddServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onServerAdded: (server: ServerType) => void;
  /** Если задан — окно работает в режиме редактирования */
  editingServer?: ServerType | null;
  onServerUpdated?: (server: ServerType) => void;
  /** Серверы импортированы из AmneziaVPN — список нужно перезагрузить */
  onImported?: () => void;
}

export const AddServerModal: React.FC<AddServerModalProps> = ({
  isOpen,
  onClose,
  onServerAdded,
  editingServer = null,
  onServerUpdated,
  onImported,
}) => {
  const [mode, setMode] = useState<'manual' | 'amnezia'>('manual');
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [sshUser, setSshUser] = useState('root');
  const [authType, setAuthType] = useState<'password' | 'key'>('password');
  const [sshPassword, setSshPassword] = useState('');
  const [sshKey, setSshKey] = useState('');
  const [awgPort, setAwgPort] = useState('51820');
  const [subnet, setSubnet] = useState('10.8.0.1/24');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetHostKey, setResetHostKey] = useState(false);

  const editing = Boolean(editingServer);
  const hasClients = (editingServer?.client_count || 0) > 0;

  // Заполнение формы при каждом открытии (без устаревших значений от прошлого раза)
  useEffect(() => {
    if (!isOpen) return;
    setName(editingServer?.name ?? '');
    setHost(editingServer?.host ?? '');
    setSshPort(String(editingServer?.ssh_port ?? 22));
    setSshUser(editingServer?.ssh_user ?? 'root');
    setAuthType(editingServer?.has_ssh_key ? 'key' : 'password');
    setSshPassword('');
    setSshKey('');
    setAwgPort(String(editingServer?.awg_port ?? 51820));
    setSubnet(editingServer?.subnet ?? '10.8.0.1/24');
    setResetHostKey(false);
    setError(null);
    setMode('manual');
  }, [isOpen, editingServer]);

  if (!isOpen) return null;

  const currentAuth = editingServer?.has_ssh_key ? 'key' : 'password';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (editingServer) {
        const update: ServerUpdate = {
          name,
          host,
          ssh_port: parseInt(sshPort, 10),
          ssh_user: sshUser,
          awg_port: parseInt(awgPort, 10),
          subnet,
        };
        // Пустое поле — оставить текущий секрет; смена способа требует нового значения
        const secret = authType === 'password' ? sshPassword : sshKey;
        if (secret || authType !== currentAuth) {
          update.auth_type = authType;
          if (authType === 'password') update.ssh_password = sshPassword;
          else update.ssh_key = sshKey;
        }
        if (resetHostKey) update.reset_host_key = true;
        if (update.awg_port !== editingServer.awg_port && editingServer.status !== 'uninstalled') {
          if (!confirm('Смена порта пересоздаст контейнер AmneziaWG на сервере, а клиентам потребуется обновить конфигурацию. Продолжить?')) {
            setLoading(false);
            return;
          }
        }
        const updated = await api.updateServer(editingServer.id, update);
        onServerUpdated?.(updated);
        onClose();
        return;
      }

      const server = await api.createServer({
        name,
        host,
        ssh_port: parseInt(sshPort, 10) || 22,
        ssh_user: sshUser,
        ssh_password: authType === 'password' ? sshPassword : undefined,
        ssh_key: authType === 'key' ? sshKey : undefined,
        awg_port: parseInt(awgPort, 10) || 51820,
        subnet,
      });

      onServerAdded(server);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Ошибка создания сервера');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-900/50">
          <div className="flex items-center gap-2">
            <Server className="w-5 h-5 text-emerald-400" />
            <h2 className="text-lg font-semibold text-white">{editing ? 'Настройки сервера' : 'Добавить сервер'}</h2>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-white transition p-1 rounded-lg hover:bg-zinc-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        {!editing && (
          <div className="px-6 pt-4">
            <div className="grid grid-cols-2 gap-2 p-1 bg-zinc-950 border border-zinc-800 rounded-xl">
              {(['manual', 'amnezia'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`py-1.5 text-xs font-medium rounded-lg transition ${mode === m ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-white'}`}
                >
                  {m === 'manual' ? 'Вручную (SSH)' : 'Из AmneziaVPN (ключ)'}
                </button>
              ))}
            </div>
          </div>
        )}

        {!editing && mode === 'amnezia' ? (
          <AmneziaImportPanel onImported={() => onImported?.()} onClose={onClose} />
        ) : (
        <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">
              Название сервера
            </label>
            <input
              type="text"
              required
              placeholder="например: Frankfurt-01"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2 text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500 transition text-sm"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="block text-xs font-medium text-zinc-400 mb-1">
                IP адрес / Хост
              </label>
              <input
                type="text"
                required
                placeholder="194.87.12.34"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2 text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500 transition text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">
                SSH Порт
              </label>
              <input
                type="number"
                value={sshPort}
                onChange={(e) => setSshPort(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2 text-white focus:outline-none focus:border-emerald-500 transition text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">
              Пользователь SSH
            </label>
            <input
              type="text"
              value={sshUser}
              onChange={(e) => setSshUser(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2 text-white focus:outline-none focus:border-emerald-500 transition text-sm"
            />
          </div>

          {/* Auth Type Tabs */}
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">
              Аутентификация SSH
            </label>
            <div className="grid grid-cols-2 gap-2 p-1 bg-zinc-950 border border-zinc-800 rounded-xl mb-3">
              <button
                type="button"
                onClick={() => setAuthType('password')}
                className={`flex items-center justify-center gap-2 py-1.5 text-xs font-medium rounded-lg transition ${
                  authType === 'password'
                    ? 'bg-zinc-800 text-white'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                <Lock className="w-3.5 h-3.5" />
                Пароль
              </button>
              <button
                type="button"
                onClick={() => setAuthType('key')}
                className={`flex items-center justify-center gap-2 py-1.5 text-xs font-medium rounded-lg transition ${
                  authType === 'key'
                    ? 'bg-zinc-800 text-white'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                <Key className="w-3.5 h-3.5" />
                SSH Ключ
              </button>
            </div>

            {authType === 'password' ? (
              <input
                type="password"
                placeholder={editing && editingServer?.has_ssh_password ? 'Оставьте пустым, чтобы не менять' : 'Введите пароль SSH'}
                value={sshPassword}
                onChange={(e) => setSshPassword(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2 text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500 transition text-sm"
              />
            ) : (
              <textarea
                rows={3}
                placeholder={editing && editingServer?.has_ssh_key ? 'Оставьте пустым, чтобы не менять ключ' : 'Вставьте приватный ключ (-----BEGIN OPENSSH PRIVATE KEY-----)'}
                value={sshKey}
                onChange={(e) => setSshKey(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2 text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500 transition font-mono text-xs"
              />
            )}
          </div>

          {/* AmneziaWG Network Settings */}
          <div className="pt-2 border-t border-zinc-800">
            <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-400 mb-2">
              <Shield className="w-3.5 h-3.5" />
              <span>Параметры AmneziaWG</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  Порт протокола (UDP)
                </label>
                <input
                  type="number"
                  value={awgPort}
                  onChange={(e) => setAwgPort(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2 text-white focus:outline-none focus:border-emerald-500 transition text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  Подсеть клиентов
                </label>
                <input
                  type="text"
                  value={subnet}
                  disabled={editing && hasClients}
                  title={editing && hasClients ? 'Подсеть нельзя менять, пока на сервере есть клиенты' : undefined}
                  onChange={(e) => setSubnet(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2 text-white focus:outline-none focus:border-emerald-500 transition text-sm"
                />
              </div>
            </div>
            {!editing && (
              <p className="text-[11px] text-zinc-500 mt-2">
                * Заголовки обфускации (H1-H4, Jc, S1, S2) будут сгенерированы автоматически случайным образом.
              </p>
            )}
            {sshUser !== 'root' && (
              <p className="text-[11px] text-amber-400/80 mt-2">
                * Для пользователя, отличного от root, нужен sudo без пароля (NOPASSWD).
              </p>
            )}
          </div>

          {editing && editingServer?.host_key && (
            <label className="flex items-start gap-2 text-xs text-zinc-400 cursor-pointer">
              <input
                type="checkbox"
                checked={resetHostKey}
                onChange={(e) => setResetHostKey(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Сбросить сохранённый ключ SSH-хоста (<span className="font-mono">{editingServer.host_key.slice(0, 24)}…</span>).
                Только если сервер был переустановлен — иначе это может быть атака «человек посередине».
              </span>
            </label>
          )}
          {/* Submit */}
          <div className="flex items-center justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={loading}
              className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium text-sm px-5 py-2 rounded-xl transition shadow-lg shadow-emerald-600/20"
            >
              {loading ? 'Сохранение...' : 'Сохранить сервер'}
            </button>
          </div>
        </form>
        )}
      </div>
    </div>
  );
};
