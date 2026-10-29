import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { ModalShell } from './Modal';
import { FeedbackContext, type Feedback, type ConfirmOptions, type ToastKind } from './feedback-context';

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

interface DialogState {
  kind: 'confirm' | 'alert';
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
  resolve: (value: boolean) => void;
}

const TOAST_ICON = { success: CheckCircle2, error: XCircle, info: Info } as const;
const TOAST_STYLE: Record<ToastKind, string> = {
  success: 'border-ok/40 text-ok',
  error: 'border-pink/50 text-bad',
  info: 'border-brand/40 text-brand',
};

const ToastView: React.FC<{ item: ToastItem; onDismiss: (id: number) => void }> = ({ item, onDismiss }) => {
  const Icon = TOAST_ICON[item.kind];
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(item.id), item.kind === 'error' ? 8000 : 4000);
    return () => clearTimeout(timer);
  }, [item, onDismiss]);
  return (
    <div
      role={item.kind === 'error' ? 'alert' : 'status'}
      className={`pointer-events-auto flex items-start gap-3 bg-card border rounded-xl px-4 py-3 shadow-pop animate-in fade-in ${TOAST_STYLE[item.kind]}`}
    >
      <Icon className="w-5 h-5 shrink-0 mt-0.5" />
      <p className="text-sm text-ink whitespace-pre-line break-words flex-1 min-w-0">{item.message}</p>
      <button onClick={() => onDismiss(item.id)} aria-label="Закрыть уведомление" className="text-faint hover:text-ink transition shrink-0">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
};

export const FeedbackProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const value = useMemo<Feedback>(
    () => ({
      toast: (message, kind = 'info') => {
        const id = nextId.current++;
        setToasts((list) => [...list.slice(-3), { id, message, kind }]);
      },
      confirm: (options) =>
        new Promise<boolean>((resolve) => {
          const o: ConfirmOptions = typeof options === 'string' ? { message: options } : options;
          setDialog({
            kind: 'confirm',
            title: o.title ?? 'Подтвердите действие',
            message: o.message,
            confirmLabel: o.confirmLabel ?? 'Подтвердить',
            cancelLabel: o.cancelLabel ?? 'Отмена',
            danger: o.danger ?? false,
            resolve,
          });
        }),
      alert: (message, title = 'Сообщение панели') =>
        new Promise<void>((resolve) => {
          setDialog({ kind: 'alert', title, message, confirmLabel: 'Понятно', cancelLabel: '', danger: false, resolve: () => resolve() });
        }),
    }),
    []
  );

  const close = (result: boolean) => {
    dialog?.resolve(result);
    setDialog(null);
  };

  return (
    <FeedbackContext.Provider value={value}>
      {children}

      <div className="fixed z-[70] bottom-4 right-4 left-4 sm:left-auto sm:w-96 flex flex-col gap-2 pointer-events-none" aria-live="polite">
        {toasts.map((t) => (
          <ToastView key={t.id} item={t} onDismiss={dismiss} />
        ))}
      </div>

      {dialog && (
        <ModalShell label={dialog.title} onClose={() => close(false)} elevated>
          <div className="bg-card border border-line rounded-2xl w-full max-w-md shadow-pop overflow-hidden">
            <div className="flex items-start gap-3 px-6 pt-5">
              <AlertTriangle className={`w-5 h-5 mt-0.5 shrink-0 ${dialog.danger ? 'text-bad' : 'text-brand'}`} />
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-ink">{dialog.title}</h2>
                <p className="text-sm text-muted mt-2 whitespace-pre-line break-words max-h-[50vh] overflow-y-auto">{dialog.message}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4">
              {dialog.kind === 'confirm' && (
                <button onClick={() => close(false)} className="px-4 py-2 rounded-lg text-sm font-medium text-muted bg-soft hover:bg-soft-2 hover:text-ink transition">
                  {dialog.cancelLabel}
                </button>
              )}
              <button
                data-autofocus
                onClick={() => close(true)}
                className={`px-4 py-2 rounded-lg text-sm font-bold text-on-accent btn-press ${dialog.danger ? 'bg-pink' : 'bg-brand'}`}
              >
                {dialog.confirmLabel}
              </button>
            </div>
          </div>
        </ModalShell>
      )}
    </FeedbackContext.Provider>
  );
};
