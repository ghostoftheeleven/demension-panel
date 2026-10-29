import { createContext, useContext } from 'react';

/**
 * Замена alert()/confirm(): тосты для коротких сообщений, окно подтверждения (Promise<boolean>) и окно с длинным текстом.
 * Нативные диалоги блокируют страницу, не совпадают с оформлением и неудобны на телефоне.
 */
export type ToastKind = 'success' | 'error' | 'info';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Необратимое действие: кнопка подтверждения красная */
  danger?: boolean;
}

export interface Feedback {
  toast: (message: string, kind?: ToastKind) => void;
  confirm: (options: ConfirmOptions | string) => Promise<boolean>;
  /** Окно с текстом и кнопкой «Понятно» — для длинных сообщений (результат сканирования, инструкции) */
  alert: (message: string, title?: string) => Promise<void>;
}

/** Запасной вариант без провайдера (тесты отдельных компонентов): нативные диалоги */
const fallback: Feedback = {
  toast: (message) => console.warn(message),
  confirm: async (options) => window.confirm(typeof options === 'string' ? options : options.message),
  alert: async (message) => window.alert(message),
};

export const FeedbackContext = createContext<Feedback>(fallback);

export const useFeedback = (): Feedback => useContext(FeedbackContext);
