import React from 'react';
import type { Server } from '../types';

interface ServersOverviewProps {
  servers: Server[];
}

const plural = (n: number, one: string, few: string, many: string) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
};

/**
 * Сводка над списком нод — плитки Bento: состояние сети, клиенты онлайн, ноды, требующие внимания, версии AmneziaWG.
 * Только данные, которые уже пришли со списком серверов.
 */
export const ServersOverview: React.FC<ServersOverviewProps> = ({ servers }) => {
  const online = servers.filter((s) => s.status === 'online');
  const problems = servers.filter((s) => s.status === 'offline' || s.status === 'error');
  const installing = servers.filter((s) => s.installing || s.status === 'installing');
  const outdated = servers.filter((s) => s.remote_panel_id === null && s.status !== 'uninstalled' && s.awg_version < s.latest_awg_version);
  const activeClients = servers.reduce((acc, s) => acc + (s.active_client_count || 0), 0);
  const totalClients = servers.reduce((acc, s) => acc + (s.client_count || 0), 0);
  const attention = problems.length + servers.filter((s) => s.needs_sync || s.needs_apply).length;

  const headline =
    online.length === servers.length
      ? ['Сеть работает.', 'Вся.']
      : online.length === 0
        ? ['Сеть молчит.', 'Ни одной ноды.']
        : ['Сеть работает.', 'Почти вся.'];

  return (
    <section className="grid grid-cols-2 lg:grid-cols-12 gap-3 sm:gap-4">
      <div className="col-span-2 lg:col-span-5 lg:row-span-2 rounded-2xl bg-mint text-on-accent p-6 flex flex-col min-h-52">
        <div className="text-sm font-semibold opacity-70">Состояние сети</div>
        <div className="font-display font-extrabold text-3xl sm:text-4xl leading-[1.05] tracking-tight mt-3 mb-5">
          {headline[0]}
          <br />
          {headline[1]}
        </div>
        <div className="mt-auto flex flex-wrap gap-2 text-sm font-semibold">
          <span className="px-3 py-1.5 rounded-full bg-on-accent text-mint">
            {online.length} из {servers.length} {plural(servers.length, 'ноды', 'нод', 'нод')} в сети
          </span>
          {problems.map((s) => (
            <span key={s.id} className="px-3 py-1.5 rounded-full bg-on-accent/10">
              {s.name} — нет связи
            </span>
          ))}
          {installing.map((s) => (
            <span key={s.id} className="px-3 py-1.5 rounded-full bg-on-accent/10">
              {s.name} ставится
            </span>
          ))}
        </div>
      </div>

      <div className="lg:col-span-3 lg:row-span-2 rounded-2xl bg-card border border-line p-6 flex flex-col">
        <div className="text-sm font-semibold text-muted">Клиенты онлайн</div>
        <div className="font-display font-extrabold text-5xl tracking-tight mt-3">{activeClients}</div>
        <div className="mt-auto pt-4 text-sm text-faint">
          из {totalClients} {plural(totalClients, 'клиента', 'клиентов', 'клиентов')} на нодах
        </div>
      </div>

      <div
        className={`lg:col-span-4 rounded-2xl p-6 ${attention > 0 ? 'bg-orange text-on-accent' : 'bg-card border border-line'}`}
      >
        <div className={`text-sm font-semibold ${attention > 0 ? 'opacity-70' : 'text-muted'}`}>Требуют внимания</div>
        <div className="flex items-baseline gap-3 mt-2">
          <span className="font-display font-extrabold text-4xl tracking-tight">{attention}</span>
          <span className={`text-sm ${attention > 0 ? 'opacity-75' : 'text-faint'}`}>
            {attention > 0 ? 'нет связи или ждут синхронизации' : 'всё в порядке'}
          </span>
        </div>
      </div>

      <div className="col-span-2 lg:col-span-4 rounded-2xl bg-blue text-on-accent p-6">
        <div className="text-sm font-semibold opacity-70">AmneziaWG</div>
        <div className="flex items-baseline gap-3 mt-2">
          <span className="font-display font-extrabold text-4xl tracking-tight">{servers.length - outdated.length}</span>
          <span className="text-sm opacity-75">
            {outdated.length > 0
              ? `на актуальной версии, ${outdated.length} можно обновить`
              : 'все ноды на актуальной версии'}
          </span>
        </div>
      </div>
    </section>
  );
};
