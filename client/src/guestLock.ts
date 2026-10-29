import { useEffect, type RefObject } from 'react';

/** Элементы с этим атрибутом (и всё внутри них) остаются доступными гостю: выбор вкладки, поиск, страницы списка */
export const GUEST_OK_ATTR = 'data-guest-ok';

const CONTROLS = 'button, input, select, textarea';

/**
 * Блокирует все кнопки и поля внутри `root`, кроме помеченных `data-guest-ok`. Это интерфейсная подсказка:
 * запись гостю закрывает сервер (белый список в auth.middleware.ts), заблокированные кнопки лишь не дают нажать зря.
 */
export function lockControls(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(CONTROLS).forEach((el) => {
    if (el.dataset.guestLocked || el.closest(`[${GUEST_OK_ATTR}]`)) return;
    el.dataset.guestLocked = '1';
    el.setAttribute('disabled', '');
    if (!el.title) el.title = 'Недоступно в гостевом режиме';
  });
}

/** Держит контролы внутри элемента заблокированными, в том числе для вкладок, которые подгружаются позже */
export function useGuestLock(active: boolean, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    lockControls(root);
    const observer = new MutationObserver(() => lockControls(root));
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [active, ref]);
}
