/**
 * Копирование в буфер обмена. navigator.clipboard доступен только в защищённом контексте (HTTPS/localhost),
 * поэтому для панели по http://IP используется запасной вариант через execCommand.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // переходим к запасному варианту
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  textarea.remove();
  return ok;
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export const GIB = 1024 * 1024 * 1024;

/** Флаг страны из двухбуквенного кода (региональные индикаторы Unicode) */
export function countryFlag(code: string): string {
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

/** Название страны по-русски (запасной вариант — сам код) */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['ru'], { type: 'region' }).of(code.toUpperCase()) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

/**
 * Страны для выбора страны пользователя и моста: где чаще всего ограничивают доступ и где нужны мосты.
 * Любой другой код ISO можно ввести вручную.
 */
export const COMMON_COUNTRIES = [
  'ru', 'by', 'kz', 'uz', 'kg', 'tj', 'tm', 'az', 'am', 'ge', 'ua', 'md', 'tr', 'ir', 'cn', 'in', 'pk', 'ae', 'sa', 'eg', 'vn', 'id', 'mm',
];
