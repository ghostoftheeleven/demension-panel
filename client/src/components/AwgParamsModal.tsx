import React, { useState } from 'react';
import { X, Dna, Shuffle, Save, Info } from 'lucide-react';
import { api } from '../api';
import type { Server } from '../types';

interface AwgParamsModalProps {
  isOpen: boolean;
  server: Server | null;
  onClose: () => void;
  onUpdated: (server: Server) => void;
}

// Хуки живут во внутреннем компоненте: он монтируется только при открытии окна,
// а key пересоздаёт его при выборе другого сервера
export const AwgParamsModal: React.FC<AwgParamsModalProps> = ({ isOpen, server, onClose, onUpdated }) => {
  if (!isOpen || !server) return null;
  return <AwgParamsForm key={server.id} server={server} onClose={onClose} onUpdated={onUpdated} />;
};

const CHANGE_WARNING =
  'Сервер AmneziaWG будет перезапущен с новыми параметрами. Все текущие подключения оборвутся, ' +
  'а клиентам нужно будет обновить подписку или заново импортировать конфигурацию. Продолжить?';

const AwgParamsForm: React.FC<{ server: Server; onClose: () => void; onUpdated: (server: Server) => void }> = ({
  server,
  onClose,
  onUpdated,
}) => {
  const installed = server.status !== 'uninstalled';
  const [jc, setJc] = useState(server.jc);
  const [jmin, setJmin] = useState(server.jmin);
  const [jmax, setJmax] = useState(server.jmax);
  const [s1, setS1] = useState(server.s1);
  const [s2, setS2] = useState(server.s2);
  const [h1, setH1] = useState(server.h1);
  const [h2, setH2] = useState(server.h2);
  const [h3, setH3] = useState(server.h3);
  const [h4, setH4] = useState(server.h4);
  const [loading, setLoading] = useState(false);

  const handleRandomize = async () => {
    if (installed && !confirm(CHANGE_WARNING)) return;
    try {
      setLoading(true);
      const updated = await api.randomizeParams(server.id);
      setJc(updated.jc);
      setJmin(updated.jmin);
      setJmax(updated.jmax);
      setS1(updated.s1);
      setS2(updated.s2);
      setH1(updated.h1);
      setH2(updated.h2);
      setH3(updated.h3);
      setH4(updated.h4);
      onUpdated(updated);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (installed && !confirm(CHANGE_WARNING)) return;
    try {
      setLoading(true);
      const updated = await api.updateServer(server.id, {
        jc: Number(jc),
        jmin: Number(jmin),
        jmax: Number(jmax),
        s1: Number(s1),
        s2: Number(s2),
        h1: Number(h1),
        h2: Number(h2),
        h3: Number(h3),
        h4: Number(h4),
      });
      onUpdated(updated);
      onClose();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-900/50">
          <div className="flex items-center gap-2">
            <Dna className="w-5 h-5 text-emerald-400" />
            <div>
              <h2 className="text-base font-semibold text-white">Параметры обфускации AmneziaWG</h2>
              <p className="text-xs text-zinc-400">{server.name} ({server.host})</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-white transition p-1 rounded-lg hover:bg-zinc-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSave} className="p-6 space-y-5 overflow-y-auto">
          <div className="p-3 bg-zinc-950/60 border border-zinc-800 rounded-xl flex items-start gap-3 text-xs text-zinc-400">
            <Info className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
            <span>
              Эти параметры изменяют структуру пакетов WireGuard, маскируя протокол от систем глубокого анализа трафика (DPI/ТСПУ).
              {installed && ' После сохранения AmneziaWG на сервере будет перезапущен, а клиентам потребуется обновить конфигурацию.'}
            </span>
          </div>

          {/* Junk Packets (Jc, Jmin, Jmax) */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
              Мусорные пакеты (Junk Packets)
            </h3>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  Jc (Кол-во)
                </label>
                <input
                  type="number"
                  value={jc}
                  onChange={(e) => setJc(Number(e.target.value))}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-1.5 text-white text-sm focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  Jmin (Мин. байт)
                </label>
                <input
                  type="number"
                  value={jmin}
                  onChange={(e) => setJmin(Number(e.target.value))}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-1.5 text-white text-sm focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  Jmax (Макс. байт)
                </label>
                <input
                  type="number"
                  value={jmax}
                  onChange={(e) => setJmax(Number(e.target.value))}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-1.5 text-white text-sm focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>
            </div>
          </div>

          {/* Junk Padding Sizes (S1, S2) */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-cyan-400">
              Смещение размеров (Padding Sizes)
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  S1 (Init Padding, байт)
                </label>
                <input
                  type="number"
                  value={s1}
                  onChange={(e) => setS1(Number(e.target.value))}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-1.5 text-white text-sm focus:outline-none focus:border-cyan-500 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  S2 (Response Padding, байт)
                </label>
                <input
                  type="number"
                  value={s2}
                  onChange={(e) => setS2(Number(e.target.value))}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-1.5 text-white text-sm focus:outline-none focus:border-cyan-500 font-mono"
                />
              </div>
            </div>
          </div>

          {/* Magic Headers (H1, H2, H3, H4) */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-purple-400">
              Магические заголовки (Magic Headers)
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  H1 (Initiation)
                </label>
                <input
                  type="number"
                  value={h1}
                  onChange={(e) => setH1(Number(e.target.value))}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-1.5 text-white text-sm focus:outline-none focus:border-purple-500 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  H2 (Response)
                </label>
                <input
                  type="number"
                  value={h2}
                  onChange={(e) => setH2(Number(e.target.value))}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-1.5 text-white text-sm focus:outline-none focus:border-purple-500 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  H3 (Cookie Reply)
                </label>
                <input
                  type="number"
                  value={h3}
                  onChange={(e) => setH3(Number(e.target.value))}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-1.5 text-white text-sm focus:outline-none focus:border-purple-500 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  H4 (Transport Data)
                </label>
                <input
                  type="number"
                  value={h4}
                  onChange={(e) => setH4(Number(e.target.value))}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-1.5 text-white text-sm focus:outline-none focus:border-purple-500 font-mono"
                />
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center justify-between pt-4 border-t border-zinc-800">
            <button
              type="button"
              onClick={handleRandomize}
              disabled={loading}
              className="flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-zinc-300 hover:text-white bg-zinc-800 hover:bg-zinc-700 rounded-xl transition"
            >
              <Shuffle className="w-3.5 h-3.5 text-emerald-400" />
              <span>Случайные параметры</span>
            </button>

            <div className="flex items-center gap-2">
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
                className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium text-sm px-5 py-2 rounded-xl transition shadow-lg shadow-emerald-600/20"
              >
                <Save className="w-4 h-4" />
                <span>Сохранить</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
