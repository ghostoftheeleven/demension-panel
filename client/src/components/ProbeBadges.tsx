import React from 'react';
import type { ProbeResult } from '../types';
import { countryFlag, countryName } from '../utils';

const MARK: Record<ProbeResult['status'], { symbol: string; label: string; className: string }> = {
  ok: { symbol: '✓', label: 'доступна', className: 'text-ok' },
  partial: { symbol: '!', label: 'доступна не со всех узлов страны', className: 'text-warn' },
  fail: { symbol: '✕', label: 'недоступна', className: 'text-bad' },
};

/**
 * Доступность ноды из выбранных стран: флаг и отметка. Подсказка — страна, число узлов и задержка.
 */
export const ProbeBadges: React.FC<{ probes?: ProbeResult[]; showRtt?: boolean }> = ({ probes, showRtt }) => {
  if (!probes || probes.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {probes.map((p) => {
        const mark = MARK[p.status];
        return (
          <span
            key={p.country}
            title={`${countryName(p.country)}: ${mark.label} (${p.ok_nodes} из ${p.total_nodes} узлов${p.rtt_ms !== null ? `, ${p.rtt_ms} мс` : ''}); проверено ${new Date(p.checked_at).toLocaleString()}`}
            className="inline-flex items-center gap-0.5 text-[11px] bg-paper border border-line rounded-md px-1.5 py-0.5"
          >
            <span>{countryFlag(p.country)}</span>
            <span className={`font-bold ${mark.className}`}>{mark.symbol}</span>
            {showRtt && p.rtt_ms !== null && <span className="text-faint font-mono">{p.rtt_ms} мс</span>}
          </span>
        );
      })}
    </span>
  );
};
