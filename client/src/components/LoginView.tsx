import React, { useState } from 'react';
import { ShieldCheck, Lock, User, ArrowRight, Loader2 } from 'lucide-react';
import { api } from '../api';
import type { AdminUser } from '../types';

interface LoginViewProps {
  onLoginSuccess: (user: AdminUser) => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ onLoginSuccess }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await api.login(username.trim(), password);
      onLoginSuccess(res.user);
    } catch (err: any) {
      setError(err.message || 'Неверный логин или пароль');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-paper flex items-center justify-center p-4 selection:bg-ok-soft selection:text-ok">
      <div className="w-full max-w-md bg-card border-2 border-ink rounded-2xl p-8 shadow-brutal relative overflow-hidden">
        {/* Glow accent */}

        {/* Brand */}
        <div className="flex flex-col items-center text-center space-y-3 mb-8">
          <div className="w-16 h-16 rounded-2xl bg-mint flex items-center justify-center shadow-brutal">
            <ShieldCheck className="w-9 h-9 text-ink stroke-[2.5]" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-ink tracking-wide">DEMENSION</h1>
            <p className="text-xs text-muted mt-1">Авторизация в панели управления AmneziaWG</p>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="p-3 bg-bad-soft border-2 border-ink rounded-xl text-bad text-xs text-center animate-in fade-in">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">
              Имя пользователя
            </label>
            <div className="relative">
              <input
                type="text"
                required
                autoFocus
                placeholder="admin"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-paper border-2 border-ink rounded-xl pl-10 pr-4 py-2.5 text-ink placeholder-faint focus:outline-none focus:border-ink transition text-sm font-sans"
              />
              <User className="w-4 h-4 text-faint absolute left-3.5 top-3" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">
              Пароль администратора
            </label>
            <div className="relative">
              <input
                type="password"
                required
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-paper border-2 border-ink rounded-xl pl-10 pr-4 py-2.5 text-ink placeholder-faint focus:outline-none focus:border-ink transition text-sm font-sans"
              />
              <Lock className="w-4 h-4 text-faint absolute left-3.5 top-3" />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full mt-2 flex items-center justify-center gap-2 bg-mint disabled:opacity-50 text-ink font-bold text-sm py-2.5 rounded-xl transition shadow-brutal-sm border-2 border-ink btn-press"
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <>
                <span>Войти в панель</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        <p className="text-[11px] text-faint text-center mt-6">
          Demension Panel &bull; Изолированное управление AmneziaWG
        </p>
      </div>
    </div>
  );
};
