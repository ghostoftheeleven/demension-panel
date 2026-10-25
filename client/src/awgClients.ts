/**
 * Приложения с поддержкой AmneziaWG по платформам (проверено в октябре 2026, docs/subscriptions.md).
 * «subscription» — принимают ссылку подписки панели и обновляют список серверов сами; «manual» — только конфигурация
 * отдельного клиента (.conf или QR в списке клиентов ноды), без автообновления.
 */

export type AwgPlatform = 'windows' | 'macos' | 'linux' | 'ios' | 'android';

export const AWG_PLATFORMS: { id: AwgPlatform; label: string }[] = [
  { id: 'windows', label: 'Windows' },
  { id: 'macos', label: 'macOS' },
  { id: 'linux', label: 'Linux' },
  { id: 'ios', label: 'iPhone / iPad' },
  { id: 'android', label: 'Android' },
];

export interface AwgClient {
  name: string;
  url: string;
  platforms: AwgPlatform[];
  mode: 'subscription' | 'manual';
  /** Какую ссылку подписки давать (для mode = subscription) */
  link?: string;
  /** Поддержка AmneziaWG 3.x — новые ноды панели ставятся на 3.x */
  awg3: string;
  note?: string;
}

/** Клиенты на ядре mihomo понимают AmneziaWG 3.x с mihomo 1.19.30 (август 2026) — старые сборки подключаются только к нодам 1.x */
const MIHOMO_AWG3 = 'с ядром mihomo 1.19.30 и новее';

export const AWG_CLIENTS: AwgClient[] = [
  {
    name: 'Incy',
    url: 'https://incy.cc',
    platforms: ['ios', 'android'],
    mode: 'subscription',
    link: 'Основная ссылка (или JSON)',
    awg3: 'да (3.0 и 3.1)',
    note: 'Понимает название, описание, объявление и ссылки поддержки из оформления подписки. Настольная версия Incy AmneziaWG не поддерживает.',
  },
  {
    name: 'FlClash',
    url: 'https://github.com/chen08209/FlClash',
    platforms: ['android', 'windows', 'macos', 'linux'],
    mode: 'subscription',
    link: 'Основная ссылка (формат mihomo определяется сам) или ссылка mihomo',
    awg3: MIHOMO_AWG3,
  },
  {
    name: 'Clash Verge Rev',
    url: 'https://github.com/clash-verge-rev/clash-verge-rev',
    platforms: ['windows', 'macos', 'linux'],
    mode: 'subscription',
    link: 'Основная ссылка (формат mihomo определяется сам) или ссылка mihomo',
    awg3: MIHOMO_AWG3,
    note: 'Версию ядра можно сменить в настройках приложения.',
  },
  {
    name: 'Clash Party (Mihomo Party)',
    url: 'https://github.com/mihomo-party-org',
    platforms: ['windows', 'macos', 'linux'],
    mode: 'subscription',
    link: 'Основная ссылка (формат mihomo определяется сам) или ссылка mihomo',
    awg3: MIHOMO_AWG3,
  },
  {
    name: 'Clash Meta for Android',
    url: 'https://github.com/MetaCubeX/ClashMetaForAndroid',
    platforms: ['android'],
    mode: 'subscription',
    link: 'Ссылка mihomo',
    awg3: MIHOMO_AWG3,
  },
  {
    name: 'AmneziaVPN',
    url: 'https://amnezia.org',
    platforms: ['windows', 'macos', 'linux', 'ios', 'android'],
    mode: 'manual',
    awg3: 'да, с версии 5.0.1.5',
    note: 'Ссылки подписки не принимает: импорт .conf-файла или QR-кода клиента.',
  },
  {
    name: 'AmneziaWG',
    url: 'https://docs.amnezia.org/documentation/alternative-clients/',
    platforms: ['windows', 'macos', 'ios', 'android'],
    mode: 'manual',
    awg3: 'да (свежие версии)',
    note: 'Официальное лёгкое приложение: «Import tunnel(s) from file» или QR-код.',
  },
  {
    name: 'amneziawg-tools (awg-quick)',
    url: 'https://github.com/amnezia-vpn/amneziawg-tools',
    platforms: ['linux'],
    mode: 'manual',
    awg3: 'да (свежие версии)',
    note: 'Консольный клиент: awg-quick up ./клиент.conf.',
  },
  {
    name: 'WG Tunnel',
    url: 'https://wgtunnel.com',
    platforms: ['android'],
    mode: 'manual',
    awg3: 'да (2.0–3.1)',
    note: 'Свободный клиент WireGuard и AmneziaWG с автоподключением; импорт .conf или QR.',
  },
  {
    name: 'DefaultVPN',
    url: 'https://docs.amnezia.org/documentation/alternative-clients/',
    platforms: ['ios'],
    mode: 'manual',
    awg3: 'не указано',
    note: 'Бесплатный клиент для iOS 16+ с поддержкой AmneziaWG; импорт .conf.',
  },
];

/** Популярные приложения, с которыми подписки AmneziaWG не работают */
export const AWG_UNSUPPORTED: { name: string; reason: string }[] = [
  { name: 'Happ, v2rayN, v2rayNG', reason: 'только протоколы Xray (VLESS, VMess, Trojan…)' },
  { name: 'Karing', reason: 'нет AmneziaWG (запрос открыт у разработчиков)' },
  { name: 'Clash Mi', reason: 'ядро собрано без AmneziaWG — на iPhone и Mac не подключится' },
  { name: 'Hiddify', reason: 'AmneziaWG заявлен, но формат подписок панели не принимает' },
];
