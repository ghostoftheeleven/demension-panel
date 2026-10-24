import React from 'react';
import { ShieldCheck, Plus, Server as ServerIcon, Users, Activity, LogOut, KeyRound, Lock, Palette, Handshake } from 'lucide-react';
import type { Server, AdminUser } from '../types';

export type AppTab = 'servers' | 'subscribers' | 'subscription' | 'partners' | 'security';

interface NavbarProps {
  servers: Server[];
  user: AdminUser | null;
  activeTab: AppTab;
  onSelectTab: (tab: AppTab) => void;
  onAddServer: () => void;
  onAddSubscriber: () => void;
  onChangePassword: () => void;
  onLogout: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  servers,
  user,
  activeTab,
  onSelectTab,
  onAddServer,
  onAddSubscriber,
  onChangePassword,
  onLogout,
}) => {
  const onlineCount = servers.filter((s) => s.status === 'online').length;
  const activeClients = servers.reduce((acc, s) => acc + (s.active_client_count || 0), 0);

  return (
    <header className="border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur-md sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Brand & Tabs */}
        <div className="flex items-center gap-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <ShieldCheck className="w-6 h-6 text-zinc-950 stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-lg text-white tracking-wide">DEMENSION</span>
                <span className="text-[10px] uppercase font-semibold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  AmneziaWG
                </span>
              </div>
              <p className="text-[11px] text-zinc-400">Панель управления нодами</p>
            </div>
          </div>

          {/* Navigation Tabs */}
          <nav className="hidden sm:flex items-center gap-1 bg-zinc-900/60 p-1 rounded-xl border border-zinc-800/80">
            <button
              onClick={() => onSelectTab('servers')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                activeTab === 'servers'
                  ? 'bg-zinc-800 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              <ServerIcon className="w-3.5 h-3.5 text-emerald-400" />
              <span>Серверы (Ноды)</span>
            </button>

            <button
              onClick={() => onSelectTab('subscribers')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                activeTab === 'subscribers'
                  ? 'bg-zinc-800 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              <Users className="w-3.5 h-3.5 text-cyan-400" />
              <span>Пользователи & Подписки</span>
            </button>

            <button
              onClick={() => onSelectTab('subscription')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                activeTab === 'subscription'
                  ? 'bg-zinc-800 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              <Palette className="w-3.5 h-3.5 text-purple-400" />
              <span>Оформление подписки</span>
            </button>

            <button
              onClick={() => onSelectTab('partners')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                activeTab === 'partners'
                  ? 'bg-zinc-800 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              <Handshake className="w-3.5 h-3.5 text-amber-400" />
              <span>Партнёры</span>
            </button>

            <button
              onClick={() => onSelectTab('security')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                activeTab === 'security'
                  ? 'bg-zinc-800 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              <Lock className="w-3.5 h-3.5 text-amber-400" />
              <span>Безопасность (HTTPS & SSH)</span>
            </button>
          </nav>
        </div>

        {/* Global Stats */}
        <div className="hidden lg:flex items-center gap-6 text-xs text-zinc-400">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span>Серверы:</span>
            <strong className="text-zinc-200">{onlineCount} / {servers.length} онлайн</strong>
          </div>
          <div className="flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-cyan-400" />
            <span>Активных пиров:</span>
            <strong className="text-emerald-400">{activeClients}</strong>
          </div>
        </div>

        {/* Actions & User Menu */}
        <div className="flex items-center gap-3">
          {activeTab === 'servers' && (
            <button
              onClick={onAddServer}
              className="flex items-center gap-1.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-medium text-xs px-3.5 py-2 rounded-xl transition shadow-lg shadow-emerald-600/20 active:scale-[0.98]"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Добавить сервер</span>
            </button>
          )}

          {activeTab === 'subscribers' && (
            <button
              onClick={onAddSubscriber}
              className="flex items-center gap-1.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-medium text-xs px-3.5 py-2 rounded-xl transition shadow-lg shadow-emerald-600/20 active:scale-[0.98]"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Новый пользователь</span>
            </button>
          )}

          {/* User Controls */}
          {user && (
            <div className="flex items-center gap-1 pl-2 border-l border-zinc-800">
              <button
                onClick={onChangePassword}
                title="Сменить пароль администратора"
                className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-xl transition"
              >
                <KeyRound className="w-4 h-4" />
              </button>

              <button
                onClick={onLogout}
                title="Выйти из панели"
                className="p-2 text-zinc-400 hover:text-red-400 hover:bg-zinc-800 rounded-xl transition"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
