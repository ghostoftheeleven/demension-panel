import { describe, expect, it } from 'vitest';
import { MAX_PEER_NAME_LENGTH, normalizePeerName, subscriberPeerName } from '../src/utils/names.js';
import { httpsRedirectLocation } from '../src/utils/net.js';

describe('subscriberPeerName', () => {
  it('короткие имена не меняются', () => {
    expect(subscriberPeerName('Иван', 'Германия')).toBe('Иван (Германия)');
  });

  it('итог не длиннее 64 символов, а короткая часть сохраняется целиком', () => {
    const name = subscriberPeerName('Пользователь Иван Сергеевич', 'Германия Франкфурт AmneziaWG #1 (резервная нода)');
    expect(name.length).toBeLessThanOrEqual(MAX_PEER_NAME_LENGTH);
    expect(name.startsWith('Пользователь Иван Сергеевич (')).toBe(true);
    expect(name.endsWith(')')).toBe(true);

    const long = subscriberPeerName('а'.repeat(64), 'б'.repeat(64));
    expect(long.length).toBeLessThanOrEqual(MAX_PEER_NAME_LENGTH);
    expect(long).toMatch(/^а+ \(б+\)$/);
  });

  it('не оставляет половину суррогатной пары', () => {
    const name = subscriberPeerName('😀'.repeat(40), 'сервер');
    expect(name.length).toBeLessThanOrEqual(MAX_PEER_NAME_LENGTH);
    expect(name).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

describe('normalizePeerName', () => {
  it('приводит имя к виду, который принимает панель владельца', () => {
    expect(normalizePeerName('  имя\nс переводом  ')).toBe('имя с переводом');
    expect(normalizePeerName('x'.repeat(100))).toHaveLength(64);
    expect(normalizePeerName('   ')).toBe('client');
  });
});

describe('httpsRedirectLocation (GHSA-xj6r)', () => {
  it('ведёт на домен сертификата, а не на значение заголовка Host', () => {
    expect(httpsRedirectLocation('attacker.example', '/path?q=1', 'panel.example.com')).toBe('https://panel.example.com/path?q=1');
    expect(httpsRedirectLocation('evil.example:8443', '/', 'panel.example.com')).toBe('https://panel.example.com:8443/');
  });

  it('сохраняет порт из Host и поддерживает IP-сертификаты', () => {
    expect(httpsRedirectLocation('203.0.113.5:3001', '/', '203.0.113.5')).toBe('https://203.0.113.5:3001/');
    expect(httpsRedirectLocation('[2001:db8::1]:3001', '/', '2001:db8::1')).toBe('https://[2001:db8::1]:3001/');
    expect(httpsRedirectLocation('panel.example.com', '/', 'Panel.Example.com')).toBe('https://panel.example.com/');
  });

  it('не принимает некорректный порт и адрес без ведущего слэша', () => {
    expect(httpsRedirectLocation('panel.example.com:99999', '/', 'panel.example.com')).toBe('https://panel.example.com/');
    expect(httpsRedirectLocation('panel.example.com', '//evil.example/x', 'panel.example.com')).toBe('https://panel.example.com//evil.example/x');
    expect(httpsRedirectLocation('panel.example.com', 'evil.example', 'panel.example.com')).toBe('https://panel.example.com/');
  });

  it('для сертификата на поддомены подставляет только покрытое им имя', () => {
    expect(httpsRedirectLocation('vpn.example.com:3001', '/', '*.example.com')).toBe('https://vpn.example.com:3001/');
    expect(httpsRedirectLocation('attacker.example', '/', '*.example.com')).toBeNull();
  });

  it('без пригодного домена сертификата редиректа нет', () => {
    expect(httpsRedirectLocation('panel.example.com', '/', null)).toBeNull();
    expect(httpsRedirectLocation('panel.example.com', '/', 'bad domain/')).toBeNull();
  });
});
