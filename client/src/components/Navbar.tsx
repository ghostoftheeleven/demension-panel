import React from 'react';
import { ShieldCheck, Plus, Server as ServerIcon, Users, Activity, LogOut, KeyRound, Lock, Palette, Handshake } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Server, AdminUser } from '../types';
import { PanelVersion } from './PanelVersion';

export type AppTab = 'servers' | 'subscribers' | 'subscription' | 'partners' | 'security';

interface NavbarProps {
  servers: Server[];
  user: AdminUser | null;
  activeTab: AppTab;
  onSelectTab: (tab: AppTab) => void;
  onAddServer: () => void;
  onAddSubscriber: () => void;
  onOpenAccount: () => void;
  onLogout: () => void;
}

const TABS: { id: AppTab; label: string; icon: LucideIcon; color: string }[] = [
  { id: 'servers', label: 'Серверы', icon: ServerIcon, color: 'bg-yellow' },
  { id: 'subscribers', label: 'Пользователи и подписки', icon: Users, color: 'bg-blue' },
  { id: 'subscription', label: 'Оформление подписки', icon: Palette, color: 'bg-pink' },
  { id: 'partners', label: 'Партнёры', icon: Handshake, color: 'bg-orange' },
  { id: 'security', label: 'Безопасность', icon: Lock, color: 'bg-violet' },
];

export const Navbar: React.FC<NavbarProps> = ({
  servers,
  user,
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
    <header className="border-b-2 border-ink bg-paper/95 sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-3 flex items-center gap-4">
        {/* Логотип и версия */}
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-11 h-11 shrink-0 rounded-xl bg-mint border-2 border-ink flex items-center justify-center shadow-brutal-sm -rotate-3">
            <ShieldCheck className="w-6 h-6 text-ink stroke-[2.5]" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-extrabold text-xl text-ink tracking-tight leading-none">DEMENSION</span>
              <span className="hidden sm:inline text-[10px] uppercase font-bold px-2 py-0.5 rounded-md bg-yellow text-ink border-2 border-ink">
                AmneziaWG
              </span>
            </div>
            {user && <PanelVersion />}
          </div>
        </div>

        <div className="flex-1" />

        {/* Сводка */}
        <div className="hidden lg:flex items-center gap-2 text-xs">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-card border-2 border-ink">
            <span className={`w-2.5 h-2.5 rounded-full border-2 border-ink ${onlineCount > 0 ? 'bg-mint' : 'bg-faint'}`} />
            <span className="text-muted">Онлайн</span>
            <strong className="text-ink">
              {onlineCount}/{servers.length}
            </strong>
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-card border-2 border-ink">
            <Activity className="w-3.5 h-3.5 text-info" />
            <span className="text-muted">Активных пиров</span>
            <strong className="text-ink">{activeClients}</strong>
          </div>
        </div>

        {/* Действия и учётная запись */}
        <div className="flex items-center gap-2 shrink-0">
          {activeTab === 'servers' && (
            <button
              onClick={onAddServer}
              className="flex items-center gap-1.5 bg-mint text-ink font-bold text-xs px-3 py-2 rounded-xl border-2 border-ink shadow-brutal-sm btn-press"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Добавить сервер</span>
            </button>
          )}

          {activeTab === 'subscribers' && (
            <button
              onClick={onAddSubscriber}
              className="flex items-center gap-1.5 bg-mint text-ink font-bold text-xs px-3 py-2 rounded-xl border-2 border-ink shadow-brutal-sm btn-press"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Новый пользователь</span>
            </button>
          )}

          {user && (
            <>
              <button
                onClick={onOpenAccount}
                title={`Учётная запись «${user.username}»: сменить логин или пароль`}
                className="flex items-center gap-1.5 p-2 text-ink bg-card border-2 border-ink rounded-xl hover:bg-soft transition"
              >
                <KeyRound className="w-4 h-4" />
                <span className="hidden md:inline max-w-28 truncate text-xs font-mono">{user.username}</span>
              </button>

              <button
                onClick={onLogout}
                title="Выйти из панели"
                className="p-2 text-ink bg-card border-2 border-ink rounded-xl hover:bg-danger transition"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Разделы: на узком экране прокручиваются по горизонтали */}
      <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-3 pb-3 flex items-center gap-2 overflow-x-auto">
        {TABS.map(({ id, label, icon: Icon, color }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              onClick={() => onSelectTab(id)}
              aria-current={active ? 'page' : undefined}
              className={`shrink-0 flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-sm font-bold border-2 transition whitespace-nowrap ${
                active
                  ? `${color} text-ink border-ink shadow-brutal-sm`
                  : 'border-transparent text-muted hover:text-ink hover:border-ink hover:bg-card'
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
