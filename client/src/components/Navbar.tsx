import React from 'react';
import { ShieldCheck, Plus, Server as ServerIcon, Users, Activity } from 'lucide-react';
import type { Server } from '../types';

interface NavbarProps {
  servers: Server[];
  onAddServer: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ servers, onAddServer }) => {
  const onlineCount = servers.filter((s) => s.status === 'online').length;
  const totalClients = servers.reduce((acc, s) => acc + (s.client_count || 0), 0);
  const activeClients = servers.reduce((acc, s) => acc + (s.active_client_count || 0), 0);

  return (
    <header className="border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur-md sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Brand */}
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
            <p className="text-xs text-zinc-400">Панель управления защищенными серверами</p>
          </div>
        </div>

        {/* Global Stats */}
        <div className="hidden md:flex items-center gap-6 text-sm">
          <div className="flex items-center gap-2 text-zinc-300">
            <ServerIcon className="w-4 h-4 text-emerald-400" />
            <span>Серверов:</span>
            <span className="font-semibold text-white">
              {onlineCount} / {servers.length} онлайн
            </span>
          </div>

          <div className="h-4 w-px bg-zinc-800" />

          <div className="flex items-center gap-2 text-zinc-300">
            <Users className="w-4 h-4 text-cyan-400" />
            <span>Клиентов:</span>
            <span className="font-semibold text-white">{totalClients}</span>
          </div>

          <div className="h-4 w-px bg-zinc-800" />

          <div className="flex items-center gap-2 text-zinc-300">
            <Activity className="w-4 h-4 text-emerald-400" />
            <span>Активных:</span>
            <span className="font-semibold text-emerald-400">{activeClients}</span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3">
          <button
            onClick={onAddServer}
            className="flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-medium text-sm px-4 py-2 rounded-xl transition shadow-lg shadow-emerald-600/20 active:scale-[0.98]"
          >
            <Plus className="w-4 h-4" />
            <span>Добавить сервер</span>
          </button>
        </div>
      </div>
    </header>
  );
};
