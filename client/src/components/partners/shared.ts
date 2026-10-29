export const cardClass = 'bg-card border border-line rounded-2xl p-6 shadow-pop space-y-4';
export const inputClass =
  'w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink placeholder-faint focus:outline-none focus:border-brand transition text-sm';
export const iconButton = 'p-1.5 text-muted hover:bg-soft rounded-lg transition border border-line';

export const AUDIT_LABELS: Record<string, string> = {
  created: 'Доступ создан',
  updated: 'Доступ изменён',
  token_regenerated: 'Токен перевыпущен',
  suspended: 'Доступ приостановлен',
  resumed: 'Доступ возобновлён',
  peer_created: 'Партнёр создал клиента',
  peer_deleted: 'Партнёр удалил клиента',
  peer_enabled: 'Партнёр включил клиента',
  peer_disabled: 'Партнёр выключил клиента',
  owner_blocked: 'Вы заблокировали клиента',
  owner_unblocked: 'Вы разблокировали клиента',
};

export function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function toDateInput(iso: string | null): string {
  return iso ? new Date(iso).toISOString().slice(0, 10) : '';
}
