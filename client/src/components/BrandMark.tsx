import React from 'react';

/** Логотип панели: лаймовое кольцо (оформление Bento) */
export const BrandMark: React.FC<{ className?: string }> = ({ className = 'w-9 h-9' }) => (
  <span className={`${className} shrink-0 rounded-full bg-mint relative inline-block`} aria-hidden="true">
    <span className="absolute inset-[27%] rounded-full bg-page" />
  </span>
);
