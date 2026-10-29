import React from 'react';

export interface BannerMessage {
  type: 'success' | 'error';
  text: string;
}

/** Постоянное сообщение под заголовком карточки безопасности (длинные тексты вроде перехода на HTTPS в тост не помещаются) */
export const SecurityBanner: React.FC<{ message: BannerMessage | null; onClose: () => void }> = ({ message, onClose }) => {
  if (!message) return null;
  return (
    <div
      role={message.type === 'error' ? 'alert' : 'status'}
      className={`p-4 rounded-2xl border text-xs flex items-center justify-between ${
        message.type === 'success' ? 'bg-ok-soft border-line text-ok' : 'bg-bad-soft border-line text-bad'
      }`}
    >
      <span>{message.text}</span>
      <button onClick={onClose} aria-label="Закрыть сообщение" className="text-muted hover:text-ink">
        &times;
      </button>
    </div>
  );
};
