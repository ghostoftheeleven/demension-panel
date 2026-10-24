/** Максимальная длина имени клиента (панель владельца нод отклоняет более длинные имена) */
export const MAX_PEER_NAME_LENGTH = 64;

function trimBrokenSurrogate(value: string): string {
  const last = value.charCodeAt(value.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? value.slice(0, -1) : value;
}

/**
 * Имя клиента в том виде, в каком его сохраняет панель владельца нод (federation validateName):
 * без переводов строк, без пробелов по краям и не длиннее 64 символов.
 */
export function normalizePeerName(name: string): string {
  const clean = trimBrokenSurrogate(String(name ?? '').replace(/[\r\n]/g, ' ').trim().slice(0, MAX_PEER_NAME_LENGTH)).trim();
  return clean || 'client';
}

/**
 * Имя пира пользователя на сервере: «Пользователь (Сервер)». Имена пользователя и сервера допускают до 64 символов
 * каждое, поэтому итог сокращается до 64: длинная часть уменьшается первой, а короткая сохраняется целиком.
 */
export function subscriberPeerName(subscriberName: string, serverName: string): string {
  const full = `${subscriberName} (${serverName})`;
  if (full.length <= MAX_PEER_NAME_LENGTH) return full;

  let user = subscriberName;
  let server = serverName;
  const budget = MAX_PEER_NAME_LENGTH - 3; // " (" и ")"
  while (user.length + server.length > budget) {
    if (user.length >= server.length) user = user.slice(0, -1);
    else server = server.slice(0, -1);
  }
  return `${trimBrokenSurrogate(user).trimEnd()} (${trimBrokenSurrogate(server).trimEnd()})`;
}
