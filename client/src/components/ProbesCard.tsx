import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Globe2, Loader2, Save, RefreshCw, ChevronDown, ChevronUp, AlertTriangle, Search } from 'lucide-react';
import type { ProbeCountry, ProbesOverview, ProbeSettings } from '../types';
import { api } from '../api';
import { countryFlag, countryName } from '../utils';
import { ProbeBadges } from './ProbeBadges';

const INTERVALS = [10, 15, 30, 60, 120, 360, 720, 1440];

const inputClass =
  'bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-1.5 text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500 transition text-xs';

function intervalLabel(minutes: number): string {
  return minutes < 60 ? `${minutes} мин` : minutes === 1440 ? 'сутки' : `${minutes / 60} ч`;
}

/**
 * Проверка доступности нод из стран, выбранных администратором (docs/probes.md): включение, выбор стран, способ проверки
 * каждой ноды и результаты. Саму проверку выполняют узлы check-host.net.
 */
export const ProbesCard: React.FC<{ onChanged?: () => void }> = ({ onChanged }) => {
  const [overview, setOverview] = useState<ProbesOverview | null>(null);
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<ProbeSettings | null>(null);
  const [ports, setPorts] = useState<Record<number, string>>({});
  const [countries, setCountries] = useState<ProbeCountry[] | null>(null);
  const [countriesError, setCountriesError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async (resetForm: boolean) => {
    try {
      const data = await api.getProbes();
      setOverview(data);
      // Форма инициализируется только при открытии/сохранении: фоновое обновление не должно затирать ввод
      if (resetForm) {
        setSettings(data.settings);
        setPorts(Object.fromEntries(data.servers.map((s) => [s.id, s.probe_port ? String(s.probe_port) : ''])));
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    }
  }, []);

  useEffect(() => {
    api
      .getProbes()
      .then((data) => {
        setOverview(data);
        setSettings(data.settings);
        setPorts(Object.fromEntries(data.servers.map((s) => [s.id, s.probe_port ? String(s.probe_port) : ''])));
      })
      .catch((err) => setMessage({ type: 'error', text: err.message }));
  }, []);

  // Пока идёт проверка или карточка открыта, подтягиваем результаты
  useEffect(() => {
    const timer = setInterval(() => load(false), overview?.status.running ? 3000 : 20000);
    return () => clearInterval(timer);
  }, [load, overview?.status.running]);

  useEffect(() => {
    if (!open || countries) return;
    api
      .getProbeCountries()
      .then(setCountries)
      .catch((err) => setCountriesError(err.message));
  }, [open, countries]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (countries ?? []).filter((c) => !query || c.code.includes(query) || countryName(c.code).toLowerCase().includes(query) || c.name.toLowerCase().includes(query));
  }, [countries, search]);

  if (!overview || !settings) return null;

  const update = <K extends keyof ProbeSettings>(key: K, value: ProbeSettings[K]) => setSettings({ ...settings, [key]: value });

  const toggleCountry = (code: string) => {
    if (settings.countries.includes(code)) {
      update('countries', settings.countries.filter((c) => c !== code));
    } else if (settings.countries.length < overview.max_countries) {
      update('countries', [...settings.countries, code]);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const portUpdates = overview.servers
        .filter((s) => (ports[s.id] ? Number(ports[s.id]) : null) !== s.probe_port)
        .map((s) => ({ id: s.id, probe_port: ports[s.id] ? Number(ports[s.id]) : null }));
      const data = await api.updateProbes({ settings, servers: portUpdates });
      setOverview(data);
      setSettings(data.settings);
      setPorts(Object.fromEntries(data.servers.map((s) => [s.id, s.probe_port ? String(s.probe_port) : ''])));
      setMessage({
        type: 'success',
        text: data.settings.enabled
          ? 'Сохранено. Первая проверка начнётся в течение минуты — результаты появятся на карточках нод и в подписках.'
          : 'Сохранено. Проверка выключена, адреса нод никуда не отправляются.',
      });
      onChanged?.();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleRun = async () => {
    setMessage(null);
    try {
      await api.runProbes();
      await load(false);
      setMessage({ type: 'success', text: 'Проверка запущена, результаты появятся через несколько секунд.' });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  const resultsFor = (serverId: number) => overview.results.filter((r) => r.server_id === serverId);

  return (
    <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl shadow-xl">
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          if (!open) load(true);
        }}
        className="w-full flex items-center justify-between gap-3 px-5 py-3.5 text-left"
      >
        <span className="flex items-center gap-2.5">
          <Globe2 className="w-4 h-4 text-cyan-400" />
          <span className="text-sm font-semibold text-white">Доступность нод из стран</span>
          <span className="text-[11px] text-zinc-500">
            {overview.settings.enabled
              ? `проверяется из: ${overview.settings.countries.map((c) => countryFlag(c)).join(' ')}`
              : 'выключено'}
          </span>
        </span>
        {open ? <ChevronUp className="w-4 h-4 text-zinc-500" /> : <ChevronDown className="w-4 h-4 text-zinc-500" />}
      </button>

      {open && (
        <form onSubmit={handleSave} className="px-5 pb-5 space-y-5 border-t border-zinc-800/70 pt-4">
          <div className="p-3 rounded-xl border bg-amber-500/10 border-amber-500/20 text-amber-200 text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>
              Проверку выполняют узлы сервиса <b>check-host.net</b> в выбранных странах: ему передаются адреса ваших нод. Проверяется
              доступность адреса (ping или TCP-порт) — это показывает блокировку IP ноды, но не блокировку самого протокола VPN на UDP-порту.
            </span>
          </div>

          {message && (
            <div
              className={`p-3 rounded-xl border text-xs ${
                message.type === 'success'
                  ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
                  : 'bg-red-500/10 border-red-500/20 text-red-300'
              }`}
            >
              {message.text}
            </div>
          )}

          <label className="flex items-center gap-2 text-sm text-white cursor-pointer">
            <input type="checkbox" checked={settings.enabled} onChange={(e) => update('enabled', e.target.checked)} />
            <span>Проверять доступность нод</span>
          </label>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-xs font-semibold text-zinc-300">
                Страны проверки <span className="text-zinc-500 font-normal">({settings.countries.length} из {overview.max_countries})</span>
              </h4>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск страны" className={`${inputClass} pl-8 w-44`} />
              </div>
            </div>

            {settings.countries.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {settings.countries.map((code) => (
                  <button
                    type="button"
                    key={code}
                    onClick={() => toggleCountry(code)}
                    className="text-[11px] bg-cyan-500/10 border border-cyan-500/30 text-cyan-200 rounded-lg px-2 py-1 hover:bg-cyan-500/20"
                    title="Убрать"
                  >
                    {countryFlag(code)} {countryName(code)} ✕
                  </button>
                ))}
              </div>
            )}

            {countriesError ? (
              <p className="text-xs text-red-300">{countriesError}</p>
            ) : !countries ? (
              <p className="text-xs text-zinc-500 flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Загрузка списка стран...
              </p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5 max-h-48 overflow-y-auto pr-1">
                {filtered.map((c) => {
                  const selected = settings.countries.includes(c.code);
                  const disabled = !selected && settings.countries.length >= overview.max_countries;
                  return (
                    <label
                      key={c.code}
                      title={c.cities.join(', ')}
                      className={`flex items-center gap-2 text-xs rounded-lg px-2 py-1.5 border cursor-pointer ${
                        selected ? 'bg-cyan-500/10 border-cyan-500/30 text-white' : 'bg-zinc-950/50 border-zinc-800 text-zinc-300'
                      } ${disabled ? 'opacity-40 cursor-not-allowed' : 'hover:border-zinc-600'}`}
                    >
                      <input type="checkbox" checked={selected} disabled={disabled} onChange={() => toggleCountry(c.code)} />
                      <span>{countryFlag(c.code)}</span>
                      <span className="truncate">{countryName(c.code)}</span>
                      <span className="ml-auto text-[10px] text-zinc-500">{c.nodes.length}</span>
                    </label>
                  );
                })}
                {filtered.length === 0 && <p className="text-xs text-zinc-500 col-span-full">Ничего не найдено</p>}
              </div>
            )}
            <p className="text-[11px] text-zinc-600">Число справа — сколько узлов check-host.net в стране. Из каждой страны привлекаются до двух узлов.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">Проверять каждые</label>
              <select
                value={settings.interval_minutes}
                onChange={(e) => update('interval_minutes', Number(e.target.value))}
                className={`${inputClass} w-full`}
              >
                {INTERVALS.map((m) => (
                  <option key={m} value={m}>
                    {intervalLabel(m)}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer pb-1.5">
              <input type="checkbox" checked={settings.show_in_name} onChange={(e) => update('show_in_name', e.target.checked)} />
              <span>Показывать в названии ноды в подписке</span>
            </label>
            <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer pb-1.5">
              <input type="checkbox" checked={settings.show_in_description} onChange={(e) => update('show_in_description', e.target.checked)} />
              <span>Пояснение в описании подписки</span>
            </label>
          </div>
          <p className="text-[11px] text-zinc-500">
            В подписке название ноды получит вид «Frankfurt · 🇷🇺✅ 🇰🇿❌»: ✅ доступна, ⚠️ доступна не со всех узлов страны, ❌ недоступна.
            Пометки меняются вместе с результатами — в приложениях на ядре mihomo выбранный вручную сервер при смене пометки придётся выбрать заново
            (отключите «в названии», если это мешает: пояснение в описании останется).
          </p>

          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-zinc-300">Ноды и результаты</h4>
            {overview.servers.length === 0 ? (
              <p className="text-xs text-zinc-500">Установленных нод пока нет.</p>
            ) : (
              <div className="border border-zinc-800 rounded-xl overflow-hidden">
                <table className="w-full text-xs text-left">
                  <thead className="bg-zinc-950/80 text-zinc-400">
                    <tr>
                      <th className="p-2.5 font-medium">Нода</th>
                      <th className="p-2.5 font-medium">Способ проверки</th>
                      <th className="p-2.5 font-medium">Результат</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60 bg-zinc-950/30">
                    {overview.servers.map((s) => (
                      <tr key={s.id}>
                        <td className="p-2.5">
                          <div className="text-zinc-200 font-medium">{s.name}</div>
                          <div className="text-[10px] font-mono text-zinc-500">{s.host}</div>
                        </td>
                        <td className="p-2.5">
                          <div className="flex items-center gap-2">
                            <select
                              value={ports[s.id] ? 'tcp' : 'ping'}
                              onChange={(e) => setPorts({ ...ports, [s.id]: e.target.value === 'tcp' ? String(s.probe_port || 443) : '' })}
                              className={inputClass}
                            >
                              <option value="ping">ICMP ping</option>
                              <option value="tcp">TCP-порт</option>
                            </select>
                            {ports[s.id] !== '' && ports[s.id] !== undefined && (
                              <input
                                type="number"
                                min={1}
                                max={65535}
                                value={ports[s.id]}
                                onChange={(e) => setPorts({ ...ports, [s.id]: e.target.value })}
                                className={`${inputClass} w-20`}
                              />
                            )}
                          </div>
                        </td>
                        <td className="p-2.5">
                          {resultsFor(s.id).length > 0 ? <ProbeBadges probes={resultsFor(s.id)} showRtt /> : <span className="text-zinc-600">нет данных</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-[11px] text-zinc-600">
              Если нода не отвечает на ping, выберите TCP-порт, который на ней открыт для всех (например, порт SSH, если он не закрыт фаерволом).
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-[11px] text-zinc-500 space-y-0.5">
              {overview.status.running && <div className="text-cyan-300">Идёт проверка...</div>}
              {overview.status.last_run && <div>Последняя проверка: {new Date(overview.status.last_run).toLocaleString()}</div>}
              {overview.status.error && <div className="text-red-300">Ошибка: {overview.status.error}</div>}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleRun}
                disabled={!overview.settings.enabled || overview.status.running}
                className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-100 font-medium text-xs px-4 py-2 rounded-xl transition"
              >
                <RefreshCw className={`w-3.5 h-3.5 text-cyan-400 ${overview.status.running ? 'animate-spin' : ''}`} />
                <span>Проверить сейчас</span>
              </button>
              <button
                type="submit"
                disabled={saving}
                className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium text-xs px-5 py-2 rounded-xl transition"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                <span>Сохранить</span>
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
};
