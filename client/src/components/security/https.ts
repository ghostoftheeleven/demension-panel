/**
 * HTTPS включается сразу (без перезапуска). Открытая по HTTP панель после этого
 * перестаёт принимать API-запросы, поэтому переходим на HTTPS-адрес.
 */
export function switchToHttps(domain?: string | null) {
  if (window.location.protocol === 'https:') return;
  const isIp = !domain || /^[\d.]+$/.test(domain) || domain.includes(':');
  const host = isIp ? window.location.hostname : domain;
  const port = window.location.port ? `:${window.location.port}` : '';
  setTimeout(() => {
    window.location.href = `https://${host}${port}${window.location.pathname}`;
  }, 2500);
}

export const HTTPS_SWITCH_NOTE = ' Через пару секунд панель откроется по HTTPS. Старые http-ссылки подписок продолжат работать.';
