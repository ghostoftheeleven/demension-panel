import React from 'react';
import { Plus, Server as ServerIcon, Users, LogOut, KeyRound, Lock, Palette, Handshake, Waypoints, ScrollText, Eye } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Server, Bridge, Subscriber, AdminUser } from '../types';
import { PanelVersion } from './PanelVersion';
import { BrandMark } from './BrandMark';
import { formatBytes } from '../utils';
import { InstallAppButton } from './InstallAppButton';

export type AppTab = 'servers' | 'bridges' | 'subscribers' | 'subscription' | 'partners' | 'events' | 'security';

/** ws — статусы приходят по WebSocket, poll — панель опрашивает сервер раз в 15 секунд */
export type LiveMode = 'ws' | 'poll';

interface NavbarProps {
  servers: Server[];
  bridges: Bridge[];
  subscribers: Subscriber[];
  user: AdminUser | null;
  /** Гостевой режим: без кнопок добавления, учётной записи и разделов настройки */
  readOnly?: boolean;
  live: LiveMode;
  activeTab: AppTab;
  onSelectTab: (tab: AppTab) => void;
  onAddServer: () => void;
  onAddSubscriber: () => void;
  onOpenAccount: () => void;
  onLogout: () => void;
}

const TABS: { id: AppTab; label: string; icon: LucideIcon }[] = [
  { id: 'servers', label: 'Серверы', icon: ServerIcon },
  { id: 'bridges', label: 'Мосты', icon: Waypoints },
  { id: 'subscribers', label: 'Пользователи и подписки', icon: Users },
  { id: 'subscription', label: 'Оформление подписки', icon: Palette },
  { id: 'partners', label: 'Партнёры', icon: Handshake },
  { id: 'events', label: 'События', icon: ScrollText },
  { id: 'security', label: 'Безопасность', icon: Lock },
];

/** Разделы, доступные гостю (настройки подписки и безопасности скрыты) */
const GUEST_TABS: AppTab[] = ['servers', 'bridges', 'subscribers', 'partners', 'events'];

const Kpi: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="text-right">
    <div className="text-xs font-mono uppercase tracking-wide text-faint">{label}</div>
    <div className="font-mono font-semibold text-lg leading-tight text-ink">{value}</div>
  </div>
);

export const Navbar: React.FC<NavbarProps> = ({
  servers,
  bridges,
  subscribers,
  user,
  readOnly = false,
  live,
  activeTab,
  onSelectTab,
  onAddServer,
  onAddSubscriber,
  onOpenAccount,
  onLogout,
}) => {
  const onlineCount = servers.filter((s) => s.status === 'online').length;
  const activeClients = servers.reduce((acc, s) => acc + (s.active_client_count || 0), 0);
  const bridgesOnline = bridges.filter((b) => b.status === 'online').length;
  const traffic = subscribers.reduce((acc, s) => acc + (s.traffic_used || 0), 0);

  return (
    <header className="bg-page/85 backdrop-blur-md sticky top-0 z-30 border-b border-line pt-safe">
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 pt-3 flex items-center gap-4">
        {/* Логотип и версия */}
        <div className="flex items-center gap-3 min-w-0">
          <BrandMark className="w-8 h-8" />
          <div className="min-w-0">
            <div className="font-bold text-lg text-ink tracking-tight leading-none">
              dementia<span className="text-brand">/</span>
            </div>
            {user && <PanelVersion canUpdate={!readOnly} />}
          </div>
        </div>

        <div
          className="hidden sm:flex items-center gap-1.5 text-xs font-mono text-ok"
          title={live === 'ws' ? 'Статусы приходят по WebSocket мгновенно' : 'Статусы обновляются опросом раз в 15 секунд'}
        >
          <span className="w-2 h-2 rounded-full bg-ok animate-pulse" />
          {live === 'ws' ? 'LIVE' : 'LIVE · 15 с'}
        </div>

        <div className="flex-1" />

        {/* Сводка */}
        <div className="hidden xl:flex items-center gap-6">
          <Kpi label="Ноды" value={`${onlineCount}/${servers.length}`} />
          <Kpi label="Пиры онлайн" value={activeClients} />
          <Kpi label="Мосты" value={`${bridgesOnline}/${bridges.length}`} />
          <Kpi label="Трафик" value={formatBytes(traffic)} />
        </div>

        {/* Действия и учётная запись */}
        <div className="flex items-center gap-2 shrink-0">
          {!readOnly && activeTab === 'servers' && (
            <button
              onClick={onAddServer}
              className="flex items-center gap-1.5 bg-brand text-on-accent font-bold text-sm px-4 py-2 rounded-lg btn-press"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Нода</span>
            </button>
          )}

          {!readOnly && activeTab === 'subscribers' && (
            <button
              onClick={onAddSubscriber}
              className="flex items-center gap-1.5 bg-brand text-on-accent font-bold text-sm px-4 py-2 rounded-lg btn-press"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Пользователь</span>
            </button>
          )}

          {user && <InstallAppButton />}

          {user && (
            <>
              {readOnly ? (
                <span title="Гостевой доступ: только просмотр" className="flex items-center gap-1.5 px-3 py-2 text-info bg-info-soft rounded-lg text-xs font-semibold">
                  <Eye className="w-4 h-4" />
                  <span className="hidden md:inline">Гость</span>
                </span>
              ) : (
                <button
                  onClick={onOpenAccount}
                  title={`Учётная запись «${user.username}»: сменить логин или пароль`}
                  className="flex items-center gap-1.5 px-3 py-2 text-ink bg-card border border-line rounded-lg hover:bg-soft transition"
                >
                  <KeyRound className="w-4 h-4" />
                  <span className="hidden md:inline max-w-28 truncate text-xs font-mono">{user.username}</span>
                </button>
              )}

              <button
                onClick={onLogout}
                aria-label="Выйти из панели"
                title="Выйти из панели"
                className="p-2 text-ink bg-card border border-line rounded-lg hover:bg-pink hover:text-on-accent transition"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Разделы: на узком экране прокручиваются по горизонтали */}
      <nav aria-label="Разделы панели" className="max-w-[1600px] mx-auto px-4 sm:px-6 py-2.5 flex items-center gap-1 overflow-x-auto">
        {TABS.filter(({ id }) => !readOnly || GUEST_TABS.includes(id)).map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              onClick={() => onSelectTab(id)}
              aria-current={active ? 'page' : undefined}
              className={`shrink-0 flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-sm font-medium transition whitespace-nowrap ${
                active ? 'bg-soft-2 text-brand' : 'text-muted hover:text-ink hover:bg-soft'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>
    </header>
  );
};
