import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Minus, Plus, RotateCcw } from 'lucide-react';
import type { Bridge, Server, Subscriber } from '../types';
import { countryName } from '../utils';
import {
  buildTopology,
  computeBounds,
  neighbours,
  nodeKey,
  UNKNOWN_COUNTRY,
  stretchFor,
  type Orientation,
  type Health,
  type Selection,
  type TopoEdge,
  type TopoNode,
} from '../topology/model';

interface TopologyMapProps {
  servers: Server[];
  bridges: Bridge[];
  subscribers: Subscriber[];
  selected: Selection | null;
  onSelect: (selection: Selection | null) => void;
  className?: string;
}

interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}

const LAYOUT_KEY = 'dementia.topology.layout.v1';
const LAYERS_KEY = 'dementia.topology.layers.v1';

const HEALTH_COLOR: Record<Health, string> = {
  ok: 'var(--color-ok)',
  warn: 'var(--color-orange)',
  fail: 'var(--color-pink)',
  idle: 'var(--color-faint)',
};

const STATUS_TEXT: Record<Health, string> = { ok: 'в сети', warn: 'внимание', fail: 'нет связи', idle: 'не активна' };

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // хранилище недоступно (приватный режим) — карта работает и без запоминания
  }
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/** Подгоняет область под соотношение сторон контейнера, чтобы карта не обрезалась и не «плавала» при перемещении */
function fitView(bounds: View, aspect: number): View {
  const w = Math.max(bounds.w, bounds.h * aspect);
  const h = w / aspect;
  return { x: bounds.x + bounds.w / 2 - w / 2, y: bounds.y + bounds.h / 2 - h / 2, w, h };
}

interface Geometry {
  d: string;
  /** Середина линии: сюда подвешивается подпись при подсветке */
  mx: number;
  my: number;
}

function edgeGeometry(a: TopoNode, b: TopoNode, curve: boolean): Geometry {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const x1 = a.x + ux * (a.r + 3);
  const y1 = a.y + uy * (a.r + 3);
  const x2 = b.x - ux * (b.r + 3);
  const y2 = b.y - uy * (b.r + 3);
  if (!curve) return { d: `M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
  const bend = len * 0.07;
  const cx = (x1 + x2) / 2 - uy * bend;
  const cy = (y1 + y2) / 2 + ux * bend;
  return { d: `M${x1.toFixed(1)} ${y1.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`, mx: (x1 + 2 * cx + x2) / 4, my: (y1 + 2 * cy + y2) / 4 };
}

function edgeStroke(edge: TopoEdge): string {
  if (edge.health === 'fail') return 'var(--color-pink)';
  if (edge.health === 'warn') return 'var(--color-orange)';
  if (edge.kind === 'bridge-server' || edge.kind === 'country-bridge') return edge.health === 'ok' ? 'var(--color-violet)' : 'var(--color-faint)';
  if (edge.kind === 'panel-server') return edge.health === 'ok' ? 'var(--color-brand)' : 'var(--color-faint)';
  return edge.health === 'ok' ? 'var(--color-info)' : 'var(--color-faint)';
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export const TopologyMap: React.FC<TopologyMapProps> = ({ servers, bridges, subscribers, selected, onSelect, className = '' }) => {
  const reducedMotion = usePrefersReducedMotion();

  const [layers, setLayers] = useState<{ bridges: boolean; countries: boolean }>(() => readStorage(LAYERS_KEY, { bridges: true, countries: true }));
  const [overrides, setOverrides] = useState<Record<string, { x: number; y: number }>>(() => readStorage(LAYOUT_KEY, {}));
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null);
  const [size, setSize] = useState({ w: 1000, h: 640 });
  const [view, setView] = useState<View | null>(null);
  const [orientation, setOrientation] = useState<Orientation>('wide');
  const [dragging, setDragging] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const viewRef = useRef<View | null>(null);
  const fitSignature = useRef('');

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const topology = useMemo(() => buildTopology(servers, bridges, subscribers, orientation), [servers, bridges, subscribers, orientation]);

  // Узлы с учётом перетащенных вручную позиций и скрытых слоёв
  const nodes = useMemo(() => {
    return topology.nodes
      .filter((n) => (n.kind !== 'bridge' || layers.bridges) && (n.kind !== 'country' || layers.countries))
      .map((n) => (overrides[n.key] ? { ...n, ...overrides[n.key] } : n));
  }, [topology.nodes, overrides, layers]);
  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.key, n])), [nodes]);
  const edges = useMemo(() => topology.edges.filter((e) => nodeMap.has(e.from) && nodeMap.has(e.to)), [topology.edges, nodeMap]);

  const aspect = size.w / Math.max(1, size.h);
  const bounds = useMemo(() => computeBounds(nodes), [nodes]);

  // Размер контейнера
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth || 1000;
      const h = el.clientHeight || 640;
      setSize({ w, h });
      // С гистерезисом, чтобы раскладка не мигала при небольших изменениях размера
      setOrientation((current) => (current === 'wide' ? (w / h < 0.8 ? 'tall' : 'wide') : w / h > 1 ? 'wide' : 'tall'));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Подгонка при первом показе, смене состава карты и слоёв; при изменении размера сохраняем центр и масштаб
  const signature = `${orientation}:${nodes.map((n) => n.key).join('|')}`;
  useEffect(() => {
    if (fitSignature.current !== signature) {
      fitSignature.current = signature;
      setView(fitView(bounds, aspect));
      return;
    }
    setView((current) => {
      if (!current) return fitView(bounds, aspect);
      const cx = current.x + current.w / 2;
      const cy = current.y + current.h / 2;
      const w = current.w;
      const h = w / aspect;
      return { x: cx - w / 2, y: cy - h / 2, w, h };
    });
  }, [signature, bounds, aspect]);

  const fit = useCallback(() => setView(fitView(bounds, aspect)), [bounds, aspect]);

  const zoomAt = useCallback(
    (factor: number, focus?: { x: number; y: number }) => {
      setView((current) => {
        if (!current) return current;
        const base = fitView(bounds, aspect);
        const w = Math.min(base.w * 3, Math.max(base.w * 0.12, current.w * factor));
        const k = w / current.w;
        const fx = focus?.x ?? current.x + current.w / 2;
        const fy = focus?.y ?? current.y + current.h / 2;
        return { x: fx - (fx - current.x) * k, y: fy - (fy - current.y) * k, w, h: w / aspect };
      });
    },
    [bounds, aspect]
  );

  /** Экранные координаты → координаты карты */
  const toMap = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    const v = viewRef.current;
    if (!svg || !v) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return { x: v.x + ((clientX - rect.left) / rect.width) * v.w, y: v.y + ((clientY - rect.top) / rect.height) * v.h };
  }, []);

  // Колесо мыши: масштаб к курсору (слушатель не пассивный, чтобы страница не прокручивалась)
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(Math.exp(e.deltaY * 0.0015), toMap(e.clientX, e.clientY));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [zoomAt, toMap]);

  // --- Указатели: перетаскивание узла, панорама фона, щипок двумя пальцами
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    | { type: 'node'; key: string; startX: number; startY: number; nodeX: number; nodeY: number; moved: boolean }
    | { type: 'pan'; startX: number; startY: number; view: View; moved: boolean }
    | { type: 'pinch'; distance: number; view: View }
    | null
  >(null);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const current = viewRef.current;
    if (!current) return;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { type: 'pinch', distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, view: current };
      return;
    }
    const target = (e.target as Element).closest<SVGElement>('[data-node]');
    const key = target?.dataset.node;
    const node = key ? nodeMap.get(key) : undefined;
    svgRef.current?.setPointerCapture?.(e.pointerId);
    gesture.current = node && key
      ? { type: 'node', key, startX: e.clientX, startY: e.clientY, nodeX: node.x, nodeY: node.y, moved: false }
      : { type: 'pan', startX: e.clientX, startY: e.clientY, view: current, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const svg = svgRef.current;
    if (!g || !svg) return;
    const rect = svg.getBoundingClientRect();
    if (g.type === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const k = g.distance / distance;
      const w = g.view.w * k;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const fx = g.view.x + ((mid.x - rect.left) / rect.width) * g.view.w;
      const fy = g.view.y + ((mid.y - rect.top) / rect.height) * g.view.h;
      setView({ x: fx - (fx - g.view.x) * k, y: fy - (fy - g.view.y) * k, w, h: w / aspect });
      return;
    }
    if (g.type === 'pinch') return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (g.type === 'pan') {
      if (!g.moved && Math.hypot(dx, dy) < 4) return;
      g.moved = true;
      setDragging(true);
      setView({ ...g.view, x: g.view.x - (dx / rect.width) * g.view.w, y: g.view.y - (dy / rect.height) * g.view.h });
    } else if (g.type === 'node') {
      if (!g.moved && Math.hypot(dx, dy) < 4) return;
      g.moved = true;
      setDragging(true);
      const v = viewRef.current!;
      const x = g.nodeX + (dx / rect.width) * v.w;
      const y = g.nodeY + (dy / rect.height) * v.h;
      setOverrides((prev) => ({ ...prev, [g.key]: { x, y } }));
    }
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (pointers.current.size > 0) {
      gesture.current = null;
      return;
    }
    gesture.current = null;
    setDragging(false);
    if (!g) return;
    if (g.type === 'node') {
      if (g.moved) {
        setOverrides((prev) => {
          writeStorage(LAYOUT_KEY, prev);
          return prev;
        });
      } else {
        const node = nodeMap.get(g.key);
        if (node) onSelect(node.kind === 'panel' ? null : { kind: node.kind, id: node.id });
      }
    } else if (g.type === 'pan' && !g.moved) {
      onSelect(null);
    }
  };

  const onPointerCancel = (e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    gesture.current = null;
    setDragging(false);
  };

  const toggleLayer = (layer: 'bridges' | 'countries') => {
    setLayers((prev) => {
      const next = { ...prev, [layer]: !prev[layer] };
      writeStorage(LAYERS_KEY, next);
      return next;
    });
  };

  const resetLayout = () => {
    setOverrides({});
    writeStorage(LAYOUT_KEY, {});
  };

  const selectedKey = selected ? nodeKey(selected.kind, selected.id) : null;
  const focusKey = hover?.key ?? null;
  const related = useMemo(() => (focusKey ? neighbours(edges, focusKey) : null), [edges, focusKey]);
  const selectedRelated = useMemo(() => (selectedKey ? neighbours(edges, selectedKey) : null), [edges, selectedKey]);

  const showHover = (node: TopoNode, e: React.PointerEvent | React.FocusEvent) => {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return;
    if ('clientX' in e) setHover({ key: node.key, x: e.clientX - box.left, y: e.clientY - box.top });
    else {
      const rect = (e.currentTarget as Element).getBoundingClientRect();
      setHover({ key: node.key, x: rect.left - box.left + rect.width / 2, y: rect.top - box.top });
    }
  };

  const hoverNode = hover ? nodeMap.get(hover.key) : undefined;
  const hasOverrides = Object.keys(overrides).length > 0;
  const animate = !reducedMotion;
  // Подписи не должны мельчать вместе с картой: их размер держится около 13 пикселей экрана при любом масштабе
  const pxPerUnit = view ? size.w / view.w : 1;
  const labelSize = Math.min(18, Math.max(11, 13 / pxPerUnit));

  const describe = (node: TopoNode): string[] => {
    if (node.kind === 'server') {
      const s = servers.find((x) => x.id === node.id);
      if (!s) return [];
      const lines = [`${s.host}:${s.awg_port}/udp`, `Пиры онлайн: ${node.sub}`, `AmneziaWG ${s.awg_version}.x`];
      if (s.remote_panel_name) lines.push(`Нода партнёра «${s.remote_panel_name}»`);
      if (node.flags.sync) lines.push('Есть неприменённые изменения');
      if (node.flags.outdated) lines.push(`Доступна версия ${s.latest_awg_version}.x`);
      return lines;
    }
    if (node.kind === 'bridge') {
      const b = bridges.find((x) => x.id === node.id);
      if (!b) return [];
      const active = b.links.filter((l) => l.active).length;
      return [`${b.host}`, `Привязано нод: ${b.links.length}, включено для пользователей: ${active}`];
    }
    if (node.kind === 'country') {
      const probes = servers.flatMap((s) => (s.probes ?? []).filter((p) => p.country.toUpperCase() === node.id).map((p) => `${s.name}: ${p.status === 'ok' ? 'доступна' : p.status === 'partial' ? 'частично' : 'недоступна'}`));
      return [node.id === UNKNOWN_COUNTRY ? 'Страна у подписчиков не задана' : countryName(String(node.id)), node.sub, ...probes.slice(0, 5)];
    }
    return ['Центр управления: SSH к нодам и мостам'];
  };

  return (
    <div ref={containerRef} className={`relative overflow-hidden select-none ${className}`} onKeyDown={(e) => e.key === 'Escape' && onSelect(null)}>
      <svg
        ref={svgRef}
        className={`w-full h-full block touch-none ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        viewBox={view ? `${view.x} ${view.y} ${view.w} ${view.h}` : '-500 -320 1000 640'}
        role="group"
        aria-label="Карта сети: панель, ноды, мосты и страны пользователей"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <defs>
          <radialGradient id="topo-glow">
            <stop offset="0" stopColor="var(--color-brand)" stopOpacity="0.35" />
            <stop offset="1" stopColor="var(--color-brand)" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Кольца: ноды, мосты, страны */}
        {[...new Set(topology.nodes.filter((n) => n.kind !== 'panel' && (layers.bridges || n.kind !== 'bridge') && (layers.countries || n.kind !== 'country')).map((n) => Math.round(Math.hypot(n.x / stretchFor(orientation).sx, n.y / stretchFor(orientation).sy) / 10) * 10))].map((r) => (
          <ellipse key={r} cx={0} cy={0} rx={r * stretchFor(orientation).sx} ry={r * stretchFor(orientation).sy} fill="none" stroke="var(--color-line)" strokeDasharray="2 7" opacity={0.7} />
        ))}

        {/* Линии */}
        <g>
          {edges.map((edge) => {
            const a = nodeMap.get(edge.from)!;
            const b = nodeMap.get(edge.to)!;
            const geo = edgeGeometry(a, b, edge.kind !== 'panel-server');
            const emphasised = related?.edges.has(edge.key) || selectedRelated?.edges.has(edge.key);
            const dimmed = related && !related.edges.has(edge.key);
            const width = (edge.dashed ? 1.1 : 1.5) + (emphasised ? 1 : 0) + Math.min(1.2, edge.weight * 0.9);
            return (
              <path
                key={edge.key}
                d={geo.d}
                fill="none"
                stroke={edgeStroke(edge)}
                strokeWidth={width}
                strokeLinecap="round"
                strokeDasharray={edge.flow ? undefined : edge.dashed ? '3 6' : undefined}
                className={edge.flow && animate ? 'topology-flow' : undefined}
                style={{ opacity: dimmed ? 0.1 : emphasised ? 1 : edge.flow ? 0.75 : edge.kind === 'country-server' ? 0.35 : 0.55, transition: 'opacity .2s' }}
              >
                <title>{edge.title}</title>
              </path>
            );
          })}
        </g>

        {/* Пакеты: бегут по активным линиям, их число растёт с нагрузкой */}
        {animate && (
          <g aria-hidden="true" pointerEvents="none">
            {edges
              .filter((e) => e.flow)
              .map((edge) => {
                const a = nodeMap.get(edge.from)!;
                const b = nodeMap.get(edge.to)!;
                const geo = edgeGeometry(a, b, edge.kind !== 'panel-server');
                const count = edge.weight > 0.6 ? 3 : edge.weight > 0.25 ? 2 : 1;
                const length = Math.hypot(b.x - a.x, b.y - a.y);
                const duration = Math.max(1.6, length / 90);
                const dimmed = related && !related.edges.has(edge.key);
                return Array.from({ length: count }, (_, i) => (
                  <circle key={`${edge.key}#${i}`} r={2.6} fill={edgeStroke(edge)} opacity={dimmed ? 0.1 : 0.95}>
                    <animateMotion dur={`${duration}s`} begin={`${(-duration * i) / count}s`} repeatCount="indefinite" path={geo.d} />
                  </circle>
                ));
              })}
          </g>
        )}

        {/* Узлы */}
        <g>
          {nodes.map((node) => {
            const isSelected = node.key === selectedKey;
            const dimmed = related && !related.nodes.has(node.key);
            const color = node.kind === 'panel' ? 'var(--color-brand)' : node.kind === 'bridge' && node.health === 'ok' ? 'var(--color-violet)' : HEALTH_COLOR[node.health];
            const label =
              node.kind === 'panel' ? 'Панель' : `${node.kind === 'server' ? 'Нода' : node.kind === 'bridge' ? 'Мост' : 'Страна'} ${node.label}: ${STATUS_TEXT[node.health]}, ${node.sub}`;
            return (
              <g
                key={node.key}
                data-node={node.key}
                transform={`translate(${node.x} ${node.y})`}
                tabIndex={0}
                role="button"
                aria-label={label}
                aria-pressed={isSelected}
                className="topology-node cursor-pointer outline-none"
                style={{ opacity: dimmed ? 0.3 : 1, transition: 'opacity .2s' }}
                onPointerEnter={(e) => showHover(node, e)}
                onPointerMove={(e) => hover?.key === node.key && showHover(node, e)}
                onPointerLeave={() => setHover(null)}
                onFocus={(e) => showHover(node, e)}
                onBlur={() => setHover(null)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(node.kind === 'panel' ? null : { kind: node.kind, id: node.id });
                  }
                }}
              >
                {node.kind === 'panel' && <circle r={92} fill="url(#topo-glow)" className={animate ? 'topology-breathe' : undefined} />}

                {/* Вспышка при появлении и смене состояния: ключ меняется вместе со здоровьем, анимация проигрывается заново */}
                {animate && node.kind !== 'panel' && (
                  <circle key={`ping-${node.health}`} r={node.r} fill="none" stroke={color} strokeWidth={2} className="topology-ping" />
                )}
                {isSelected && animate && (
                  <circle r={node.r + 8} fill="none" stroke={color} strokeOpacity={0.45} strokeWidth={2}>
                    <animate attributeName="r" values={`${node.r + 5};${node.r + 14};${node.r + 5}`} dur="2.4s" repeatCount="indefinite" />
                  </circle>
                )}
                <circle r={node.r + 10} fill="transparent" />

                {node.kind === 'bridge' ? (
                  <rect
                    x={-node.r * 0.82}
                    y={-node.r * 0.82}
                    width={node.r * 1.64}
                    height={node.r * 1.64}
                    rx={9}
                    transform="rotate(45)"
                    fill="var(--color-card)"
                    stroke={color}
                    strokeWidth={isSelected ? 3 : 1.8}
                  />
                ) : (
                  <circle
                    r={node.r}
                    fill="var(--color-card)"
                    stroke={color}
                    strokeWidth={isSelected ? 3 : node.kind === 'panel' ? 2.2 : 1.8}
                    strokeDasharray={node.flags.partner ? '5 4' : undefined}
                  />
                )}

                {node.kind === 'server' && (
                  <>
                    <text y={-1} textAnchor="middle" fill="var(--color-ink)" fontSize={17} fontWeight={700}>
                      {node.sub.split('/')[0]}
                    </text>
                    <text y={14} textAnchor="middle" fill={color} fontSize={12} fontFamily="var(--font-mono)">
                      /{node.sub.split('/')[1]}
                    </text>
                  </>
                )}
                {node.kind === 'panel' && (
                  <text y={4} textAnchor="middle" fill="var(--color-brand)" fontSize={13} fontWeight={700}>
                    PANEL
                  </text>
                )}
                {node.kind === 'bridge' && (
                  <text y={4} textAnchor="middle" fill={color} fontSize={12} fontWeight={700}>
                    {node.sub.split(' ')[0]}
                  </text>
                )}
                {node.kind === 'country' && (
                  <text y={4} textAnchor="middle" fill="var(--color-ink)" fontSize={11} fontWeight={700}>
                    {node.id === UNKNOWN_COUNTRY ? '?' : String(node.id)}
                  </text>
                )}

                {/* Метки: ожидает синхронизации, устаревший протокол */}
                {node.flags.sync && <circle cx={-node.r * 0.72} cy={-node.r * 0.72} r={5} fill="var(--color-orange)" stroke="var(--color-card)" strokeWidth={2} />}
                {node.flags.outdated && (
                  <path d={`M${node.r * 0.72} ${-node.r * 0.95} l6 10 h-12 z`} fill="var(--color-violet)" stroke="var(--color-card)" strokeWidth={1.5} />
                )}

                <text y={node.r + labelSize * 1.35} textAnchor="middle" fill="var(--color-ink)" fontSize={labelSize} fontWeight={600} stroke="var(--color-page)" strokeWidth={4} paintOrder="stroke" strokeLinejoin="round">
                  {truncate(node.kind === 'country' || node.kind === 'panel' ? (node.kind === 'country' ? node.sub : 'dementia · панель') : node.label, 18)}
                </text>
                {node.kind === 'country' && node.id !== UNKNOWN_COUNTRY ? null : node.kind === 'country' ? (
                  <text y={node.r + labelSize * 2.5} textAnchor="middle" fill="var(--color-muted)" fontSize={labelSize * 0.85} fontFamily="var(--font-mono)" stroke="var(--color-page)" strokeWidth={3.5} paintOrder="stroke" strokeLinejoin="round">
                    {node.label}
                  </text>
                ) : node.kind === 'bridge' ? (
                  <text y={node.r + labelSize * 2.5} textAnchor="middle" fill="var(--color-muted)" fontSize={labelSize * 0.85} fontFamily="var(--font-mono)" stroke="var(--color-page)" strokeWidth={3.5} paintOrder="stroke" strokeLinejoin="round">
                    {node.sub}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>

      {/* Подсказка при наведении */}
      {hoverNode && hover && !dragging && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 max-w-64 rounded-lg border border-line bg-card/95 px-3 py-2 shadow-pop text-xs"
          style={{ left: Math.min(hover.x + 14, size.w - 270), top: Math.max(8, hover.y - 12) }}
        >
          <div className="flex items-center gap-2 font-semibold text-ink">
            <span className="w-2 h-2 rounded-full" style={{ background: HEALTH_COLOR[hoverNode.health] }} />
            {hoverNode.kind === 'country' && hoverNode.id !== UNKNOWN_COUNTRY ? countryName(String(hoverNode.id)) : hoverNode.label}
            <span className="ml-auto font-mono font-normal text-faint">{STATUS_TEXT[hoverNode.health]}</span>
          </div>
          {describe(hoverNode).map((line) => (
            <div key={line} className="font-mono text-muted mt-0.5 break-words">{line}</div>
          ))}
        </div>
      )}

      {/* Управление масштабом */}
      <div className="absolute right-3 top-3 flex flex-col gap-1.5" data-guest-ok>
        {[
          { label: 'Приблизить', icon: Plus, action: () => zoomAt(0.75) },
          { label: 'Отдалить', icon: Minus, action: () => zoomAt(1.33) },
          { label: 'Показать всю карту', icon: Maximize2, action: fit },
        ].map(({ label, icon: Icon, action }) => (
          <button key={label} onClick={action} aria-label={label} title={label} className="p-2 rounded-lg bg-card/90 border border-line text-muted hover:text-brand hover:border-brand transition">
            <Icon className="w-4 h-4" />
          </button>
        ))}
        {hasOverrides && (
          <button onClick={resetLayout} aria-label="Сбросить расположение узлов" title="Вернуть узлы на места" className="p-2 rounded-lg bg-card/90 border border-line text-muted hover:text-brand hover:border-brand transition">
            <RotateCcw className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Слои и легенда */}
      <div className="absolute left-3 bottom-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-mono text-muted bg-page/80 border border-line rounded-lg px-3 py-2" data-guest-ok>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={layers.bridges} onChange={() => toggleLayer('bridges')} />
          мосты
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={layers.countries} onChange={() => toggleLayer('countries')} />
          страны
        </label>
        <span className="hidden sm:flex items-center gap-3">
          <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-full bg-ok" />в сети</span>
          <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-full bg-pink" />нет связи</span>
          <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-full bg-orange" />внимание</span>
          <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-full bg-violet" />мост</span>
        </span>
      </div>
    </div>
  );
};
