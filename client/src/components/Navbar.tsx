import React from 'react';
import { Plus, Server as ServerIcon, Users, Activity, LogOut, KeyRound, Lock, Palette, Handshake, Waypoints, ScrollText, Eye } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Server, AdminUser } from '../types';
import { PanelVersion } from './PanelVersion';
import { BrandMark } from './BrandMark';

export type AppTab = 'servers' | 'bridges' | 'subscribers' | 'subscription' | 'partners' | 'events' | 'security';

interface NavbarProps {
  servers: Server[];
  user: AdminUser | null;
  /** Гостевой режим: без кнопок добавления, учётной записи и разделов настройки */
  readOnly?: boolean;
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

export const Navbar: React.FC<NavbarProps> = ({
  servers,
  user,
  readOnly = false,
  activeTab,
  onSelectTab,
  onAddServer,
  onAddSubscriber,
  onOpenAccount,
  onLogout,
}) => {
  const onlineCount = servers.filter((s) => s.status === 'online').length;
  const activeClients = servers.reduce((acc, s) => acc + (s.active_client_count || 0), 0);

  return (
    <header className="bg-page/90 backdrop-blur-md sticky top-0 z-30 border-b border-line">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4 flex items-center gap-4">
        {/* Логотип и версия */}
        <div className="flex items-center gap-3 min-w-0">
          <BrandMark />
          <div className="min-w-0">
            <div className="font-display font-extrabold text-xl text-ink tracking-tight leading-none">dementia</div>
            {user && <PanelVersion canUpdate={!readOnly} />}
          </div>
        </div>

        <div className="flex-1" />

        {/* Сводка */}
        <div className="hidden lg:flex items-center gap-2 text-xs">
          <div className="flex items-center gap-2 px-3.5 py-2 rounded-full bg-card">
            <span className={`w-2 h-2 rounded-full ${onlineCount > 0 ? 'bg-mint' : 'bg-faint'}`} />
            <span className="text-muted">Онлайн</span>
            <strong className="text-ink">
              {onlineCount}/{servers.length}
            </strong>
          </div>
          <div className="flex items-center gap-2 px-3.5 py-2 rounded-full bg-card">
            <Activity className="w-3.5 h-3.5 text-info" />
            <span className="text-muted">Активных пиров</span>
            <strong className="text-ink">{activeClients}</strong>
          </div>
        </div>

        {/* Действия и учётная запись */}
        <div className="flex items-center gap-2 shrink-0">
          {!readOnly && activeTab === 'servers' && (
            <button
              onClick={onAddServer}
              className="flex items-center gap-1.5 bg-mint text-on-accent font-bold text-sm px-4 py-2 rounded-full btn-press"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Нода</span>
            </button>
          )}

          {!readOnly && activeTab === 'subscribers' && (
            <button
              onClick={onAddSubscriber}
              className="flex items-center gap-1.5 bg-mint text-on-accent font-bold text-sm px-4 py-2 rounded-full btn-press"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Пользователь</span>
            </button>
          )}

          {user && (
            <>
              {readOnly ? (
                <span title="Гостевой доступ: только просмотр" className="flex items-center gap-1.5 px-3 py-2 text-info bg-info-soft rounded-full text-xs font-semibold">
                  <Eye className="w-4 h-4" />
                  <span className="hidden md:inline">Гость</span>
                </span>
              ) : (
              <button
                onClick={onOpenAccount}
                title={`Учётная запись «${user.username}»: сменить логин или пароль`}
                className="flex items-center gap-1.5 px-3 py-2 text-ink bg-card rounded-full hover:bg-soft transition"
              >
                <KeyRound className="w-4 h-4" />
                <span className="hidden md:inline max-w-28 truncate text-xs font-mono">{user.username}</span>
              </button>
              )}

              <button
                onClick={onLogout}
                title="Выйти из панели"
                className="p-2 text-ink bg-card rounded-full hover:bg-pink hover:text-on-accent transition"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Разделы: на узком экране прокручиваются по горизонтали */}
      <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center gap-1.5 overflow-x-auto">
        {TABS.filter(({ id }) => !readOnly || GUEST_TABS.includes(id)).map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              onClick={() => onSelectTab(id)}
              aria-current={active ? 'page' : undefined}
              className={`shrink-0 flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold transition whitespace-nowrap ${
                active ? 'bg-yellow text-on-accent' : 'bg-card text-muted hover:text-ink hover:bg-soft'
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
