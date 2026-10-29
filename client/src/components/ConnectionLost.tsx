import React, { useEffect, useState } from 'react';
import { WifiOff, RefreshCw } from 'lucide-react';

/**
 * Экран «Нет связи с панелью»: показывается вместо формы входа, когда проверка сессии не удалась из-за сети (в приложении на телефоне это
 * обычное дело: метро, лифт, спящий режим). Токен при этом не стирается. Повторная попытка — по кнопке, при возврате сети и раз в 10 секунд.
 */
export const ConnectionLost: React.FC<{ onRetry: () => Promise<void> | void }> = ({ onRetry }) => {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const retry = () => {
      void onRetry();
    };
    window.addEventListener('online', retry);
    const timer = setInterval(retry, 10000);
    return () => {
      window.removeEventListener('online', retry);
      clearInterval(timer);
    };
  }, [onRetry]);

  const handleClick = async () => {
    setBusy(true);
    try {
      await onRetry();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-dvh flex items-center justify-center px-6 pt-safe pb-safe" role="alert">
      <div className="max-w-sm w-full text-center space-y-5">
        <div className="w-16 h-16 mx-auto rounded-2xl bg-card border border-line flex items-center justify-center">
          <WifiOff className="w-8 h-8 text-warn" />
        </div>
        <div className="space-y-2">
          <h1 className="text-xl font-bold text-ink">Нет связи с панелью</h1>
          <p className="text-sm text-muted">
            Не удалось связаться с сервером. Вы остаётесь в системе — как только связь появится, панель откроется сама.
          </p>
        </div>
        <button
          onClick={handleClick}
          disabled={busy}
          className="inline-flex items-center gap-2 bg-brand text-on-accent font-bold text-sm px-5 py-2.5 rounded-lg btn-press disabled:opacity-60"
        >
          <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
          Повторить
        </button>
      </div>
    </div>
  );
};
