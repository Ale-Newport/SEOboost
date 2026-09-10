'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChartContainer, seriesColor, useChartColors, withAlpha, type ChartColors } from './chart-container';
import { cn, colorIndex as hashColorIndex, formatNumber, shortenUrl } from '@/lib/utils';

/** Hard cap on rendered nodes. Above this the browser starts dropping frames on the O(n²) pass. */
const DEFAULT_MAX_NODES = 400;
/** Simulation is considered converged below this alpha and the rAF loop stops. */
const ALPHA_MIN = 0.005;
const ALPHA_DECAY = 0.022;
/** d3-force calls this velocityDecay; velocities keep this fraction each tick. */
const VELOCITY_DAMPING = 0.62;
const REPULSION = -260;
const LINK_DISTANCE = 46;
const LINK_STRENGTH = 0.42;
const CENTER_STRENGTH = 0.022;
const MIN_SCALE = 0.15;
const MAX_SCALE = 6;
/** Golden-angle spiral seeding — deterministic, so the layout is identical on every mount. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export interface SiteGraphNode {
  id: string;
  url: string;
  /** Falls back to a shortened URL. */
  label?: string;
  inboundLinks: number;
  outboundLinks?: number;
  /** Click depth from the homepage; used when `colorBy` is `depth`. */
  depth?: number;
  /** Topic cluster / section name; used when `colorBy` is `cluster`. */
  cluster?: string | null;
  isOrphan?: boolean;
}

export interface SiteGraphEdge {
  source: string;
  target: string;
}

interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** Link count inside the rendered subgraph — drives the link-force bias. */
  degree: number;
  data: SiteGraphNode;
}

interface SimEdge {
  s: number;
  t: number;
}

interface SimState {
  nodes: SimNode[];
  edges: SimEdge[];
  alpha: number;
}

interface View {
  scale: number;
  tx: number;
  ty: number;
}

export interface SiteGraphProps {
  nodes: readonly SiteGraphNode[];
  edges: readonly SiteGraphEdge[];
  /** Nodes above this cap are dropped, lowest inbound-link count first. */
  maxNodes?: number;
  height?: number;
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  loading?: boolean;
  emptyMessage?: string;
  colorBy?: 'cluster' | 'depth';
  onNodeClick?: (node: SiteGraphNode) => void;
  bare?: boolean;
  className?: string;
}

function nodeLabel(node: SiteGraphNode): string {
  return node.label ?? shortenUrl(node.url, 40);
}

/** Depth ramp: shallow pages take the accent, deep pages fade toward the muted token. */
function depthColor(colors: ChartColors, depth: number, maxDepth: number): string {
  if (maxDepth <= 0) return seriesColor(colors, 0);
  const step = Math.min(depth, 5);
  return seriesColor(colors, step);
}

export function SiteGraph({
  nodes,
  edges,
  maxNodes = DEFAULT_MAX_NODES,
  height = 520,
  title,
  description,
  actions,
  loading = false,
  emptyMessage = 'No internal links discovered yet — run a crawl first.',
  colorBy = 'cluster',
  onNodeClick,
  bare = false,
  className,
}: SiteGraphProps) {
  const colors = useChartColors();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<SimState | null>(null);
  const viewRef = useRef<View>({ scale: 1, tx: 0, ty: 0 });
  const sizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
  const rafRef = useRef<number | null>(null);
  const colorsRef = useRef<ChartColors>(colors);
  const hoverIdRef = useRef<string | null>(null);
  const clusterRef = useRef<string | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; moved: number } | null>(null);

  const [hover, setHover] = useState<{ node: SiteGraphNode; x: number; y: number } | null>(null);
  const [activeCluster, setActiveCluster] = useState<string | null>(null);
  const [interacted, setInteracted] = useState(false);

  /** Decimate by inbound links, then keep only edges whose endpoints both survived. */
  const { visibleNodes, visibleEdges, totalNodes } = useMemo(() => {
    const sorted = [...nodes].sort(
      (a, b) =>
        b.inboundLinks - a.inboundLinks ||
        (b.outboundLinks ?? 0) - (a.outboundLinks ?? 0) ||
        a.id.localeCompare(b.id),
    );
    const kept = sorted.slice(0, Math.max(1, maxNodes));
    const keptIds = new Set(kept.map((n) => n.id));
    const kEdges = edges.filter(
      (e) => e.source !== e.target && keptIds.has(e.source) && keptIds.has(e.target),
    );
    return { visibleNodes: kept, visibleEdges: kEdges, totalNodes: nodes.length };
  }, [nodes, edges, maxNodes]);

  const clusters = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of visibleNodes) {
      const key = n.cluster ?? 'Unclustered';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [visibleNodes]);

  const maxDepth = useMemo(
    () => visibleNodes.reduce((acc, n) => Math.max(acc, n.depth ?? 0), 0),
    [visibleNodes],
  );

  const colorForNode = useCallback(
    (node: SiteGraphNode, palette: ChartColors): string => {
      if (colorBy === 'depth') return depthColor(palette, node.depth ?? 0, maxDepth);
      const cluster = node.cluster;
      if (!cluster) return palette.mutedForeground;
      return seriesColor(palette, hashColorIndex(cluster));
    },
    [colorBy, maxDepth],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const sim = simRef.current;
    if (!canvas || !sim) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const palette = colorsRef.current;
    const { width, height: h } = sizeRef.current;
    if (width === 0 || h === 0) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, h);

    const view = viewRef.current;
    ctx.translate(view.tx, view.ty);
    ctx.scale(view.scale, view.scale);

    const filter = clusterRef.current;
    const isDimmed = (n: SimNode): boolean =>
      filter !== null && (n.data.cluster ?? 'Unclustered') !== filter;

    // Edges first, in one pass per opacity bucket to keep state changes down.
    ctx.lineWidth = 1 / view.scale;
    for (const bucket of [true, false]) {
      ctx.beginPath();
      for (const e of sim.edges) {
        const a = sim.nodes[e.s];
        const b = sim.nodes[e.t];
        if (!a || !b) continue;
        const dim = isDimmed(a) || isDimmed(b);
        if (dim !== bucket) continue;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.strokeStyle = withAlpha(palette.mutedForeground, bucket ? 0.06 : 0.28);
      ctx.stroke();
    }

    const hoveredId = hoverIdRef.current;
    for (const n of sim.nodes) {
      const dim = isDimmed(n);
      const fill = colorForNode(n.data, palette);
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = dim ? withAlpha(fill, 0.15) : withAlpha(fill, 0.9);
      ctx.fill();

      if (n.data.isOrphan && !dim) {
        // Orphans get a dashed warning ring — they are the whole point of this view.
        ctx.lineWidth = 1.5 / view.scale;
        ctx.strokeStyle = palette.destructive;
        ctx.setLineDash([3 / view.scale, 2 / view.scale]);
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 2.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (n.id === hoveredId) {
        ctx.lineWidth = 2 / view.scale;
        ctx.strokeStyle = palette.foreground;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 3.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Labels only for hubs, and only once zoomed in enough to read them.
    if (view.scale > 0.85) {
      ctx.font = `${11 / view.scale}px var(--font-sans, system-ui), system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = palette.mutedForeground;
      const threshold = view.scale > 1.8 ? 0 : 6;
      for (const n of sim.nodes) {
        if (isDimmed(n) || n.r < threshold) continue;
        ctx.fillText(nodeLabel(n.data), n.x, n.y + n.r + 3 / view.scale);
      }
    }
  }, [colorForNode]);

  const tick = useCallback((sim: SimState) => {
    const { nodes: sn, edges: se } = sim;
    const alpha = sim.alpha;

    // Repulsion — O(n²) but capped at `maxNodes`, which keeps a tick well inside a frame budget.
    for (let i = 0; i < sn.length; i++) {
      const a = sn[i];
      if (!a) continue;
      for (let j = i + 1; j < sn.length; j++) {
        const b = sn[j];
        if (!b) continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          // Perfectly coincident nodes would divide by zero; nudge them apart deterministically.
          dx = ((i % 7) - 3) * 0.5 + 0.1;
          dy = ((j % 7) - 3) * 0.5 + 0.1;
          d2 = dx * dx + dy * dy;
        }
        const strength = REPULSION * (1 + (a.r + b.r) / 12);
        const w = (strength * alpha) / d2;
        a.vx += dx * w;
        a.vy += dy * w;
        b.vx -= dx * w;
        b.vy -= dy * w;
      }
    }

    // Link springs, biased by degree so hubs stay put and leaves swing.
    for (const e of se) {
      const a = sn[e.s];
      const b = sn[e.t];
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      const target = LINK_DISTANCE + a.r + b.r;
      const f = ((dist - target) / dist) * alpha * LINK_STRENGTH;
      const total = a.degree + b.degree || 2;
      const biasA = b.degree / total;
      const biasB = a.degree / total;
      a.vx += dx * f * biasA;
      a.vy += dy * f * biasA;
      b.vx -= dx * f * biasB;
      b.vy -= dy * f * biasB;
    }

    // Weak pull to the origin keeps disconnected components from drifting off-screen.
    for (const n of sn) {
      n.vx -= n.x * CENTER_STRENGTH * alpha;
      n.vy -= n.y * CENTER_STRENGTH * alpha;
      n.vx *= VELOCITY_DAMPING;
      n.vy *= VELOCITY_DAMPING;
      n.x += n.vx;
      n.y += n.vy;
    }

    sim.alpha *= 1 - ALPHA_DECAY;
  }, []);

  const ensureLoop = useCallback(() => {
    if (rafRef.current !== null) return;
    const step = (): void => {
      rafRef.current = null;
      const sim = simRef.current;
      if (!sim) return;
      if (sim.alpha > ALPHA_MIN) {
        tick(sim);
        draw();
        rafRef.current = requestAnimationFrame(step);
      } else {
        // Converged: draw one last frame and let the loop die so the tab goes idle.
        draw();
      }
    };
    rafRef.current = requestAnimationFrame(step);
  }, [draw, tick]);

  // Keep refs the draw loop reads in sync with React state / props.
  useEffect(() => {
    colorsRef.current = colors;
    ensureLoop();
  }, [colors, ensureLoop]);

  useEffect(() => {
    clusterRef.current = activeCluster;
    ensureLoop();
  }, [activeCluster, ensureLoop]);

  /** Build (or rebuild) the simulation whenever the rendered subgraph changes. */
  useEffect(() => {
    const index = new Map<string, number>();
    visibleNodes.forEach((n, i) => index.set(n.id, i));

    const degree = new Array<number>(visibleNodes.length).fill(0);
    const simEdges: SimEdge[] = [];
    for (const e of visibleEdges) {
      const s = index.get(e.source);
      const t = index.get(e.target);
      if (s === undefined || t === undefined) continue;
      simEdges.push({ s, t });
      degree[s] = (degree[s] ?? 0) + 1;
      degree[t] = (degree[t] ?? 0) + 1;
    }

    const maxInbound = visibleNodes.reduce((acc, n) => Math.max(acc, n.inboundLinks), 0);
    const simNodes: SimNode[] = visibleNodes.map((n, i) => {
      const radius = 10 * Math.sqrt(0.5 + i);
      const angle = i * GOLDEN_ANGLE;
      return {
        id: n.id,
        x: radius * Math.cos(angle),
        y: radius * Math.sin(angle),
        vx: 0,
        vy: 0,
        r: 3 + 10 * Math.sqrt(maxInbound > 0 ? n.inboundLinks / maxInbound : 0),
        degree: degree[i] ?? 0,
        data: n,
      };
    });

    simRef.current = { nodes: simNodes, edges: simEdges, alpha: 1 };
    if (!interacted) {
      const { width, height: h } = sizeRef.current;
      viewRef.current = { scale: 1, tx: width / 2, ty: h / 2 };
    }
    ensureLoop();
    // `interacted` is intentionally excluded: re-centring on user interaction would be jarring.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleNodes, visibleEdges, ensureLoop]);

  /** Size the backing store to the device pixel ratio so the canvas is not blurry. */
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const apply = (): void => {
      const rect = container.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      const dpr = window.devicePixelRatio || 1;
      const first = sizeRef.current.width === 0;
      sizeRef.current = { width: w, height: h };
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      if (first) viewRef.current = { scale: 1, tx: w / 2, ty: h / 2 };
      ensureLoop();
    };

    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(container);
    return () => observer.disconnect();
  }, [ensureLoop]);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const nodeAt = useCallback((clientX: number, clientY: number): SimNode | null => {
    const canvas = canvasRef.current;
    const sim = simRef.current;
    if (!canvas || !sim) return null;
    const rect = canvas.getBoundingClientRect();
    const view = viewRef.current;
    const wx = (clientX - rect.left - view.tx) / view.scale;
    const wy = (clientY - rect.top - view.ty) / view.scale;
    const filter = clusterRef.current;

    let best: SimNode | null = null;
    let bestDist = Infinity;
    for (const n of sim.nodes) {
      if (filter !== null && (n.data.cluster ?? 'Unclustered') !== filter) continue;
      const dx = n.x - wx;
      const dy = n.y - wy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= n.r + 4 / view.scale && d < bestDist) {
        best = n;
        bestDist = d;
      }
    }
    return best;
  }, []);

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (drag && drag.pointerId === event.pointerId) {
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        drag.x = event.clientX;
        drag.y = event.clientY;
        drag.moved += Math.abs(dx) + Math.abs(dy);
        viewRef.current = {
          ...viewRef.current,
          tx: viewRef.current.tx + dx,
          ty: viewRef.current.ty + dy,
        };
        ensureLoop();
        return;
      }

      const found = nodeAt(event.clientX, event.clientY);
      const id = found?.id ?? null;
      if (id !== hoverIdRef.current) {
        hoverIdRef.current = id;
        ensureLoop();
      }
      const container = containerRef.current;
      if (!found || !container) {
        if (hover !== null) setHover(null);
        return;
      }
      const rect = container.getBoundingClientRect();
      setHover({ node: found.data, x: event.clientX - rect.left, y: event.clientY - rect.top });
    },
    [nodeAt, ensureLoop, hover],
  );

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: 0 };
  }, []);

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag && drag.moved > 4) {
        setInteracted(true);
        return;
      }
      if (!onNodeClick) return;
      const found = nodeAt(event.clientX, event.clientY);
      if (found) onNodeClick(found.data);
    },
    [nodeAt, onNodeClick],
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const view = viewRef.current;
      const factor = Math.exp(-event.deltaY * 0.0015);
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
      if (nextScale === view.scale) return;
      // Keep the point under the cursor fixed while zooming.
      const wx = (mx - view.tx) / view.scale;
      const wy = (my - view.ty) / view.scale;
      viewRef.current = { scale: nextScale, tx: mx - wx * nextScale, ty: my - wy * nextScale };
      setInteracted(true);
      ensureLoop();
    },
    [ensureLoop],
  );

  const zoomBy = useCallback(
    (factor: number) => {
      const { width, height: h } = sizeRef.current;
      const view = viewRef.current;
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
      const wx = (width / 2 - view.tx) / view.scale;
      const wy = (h / 2 - view.ty) / view.scale;
      viewRef.current = { scale: nextScale, tx: width / 2 - wx * nextScale, ty: h / 2 - wy * nextScale };
      setInteracted(true);
      ensureLoop();
    },
    [ensureLoop],
  );

  const resetView = useCallback(() => {
    const { width, height: h } = sizeRef.current;
    viewRef.current = { scale: 1, tx: width / 2, ty: h / 2 };
    setInteracted(false);
    ensureLoop();
  }, [ensureLoop]);

  const relayout = useCallback(() => {
    const sim = simRef.current;
    if (!sim) return;
    sim.alpha = 1;
    ensureLoop();
  }, [ensureLoop]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLCanvasElement>) => {
      const step = event.shiftKey ? 80 : 24;
      const pan = (dx: number, dy: number): void => {
        viewRef.current = { ...viewRef.current, tx: viewRef.current.tx + dx, ty: viewRef.current.ty + dy };
        setInteracted(true);
        ensureLoop();
      };
      switch (event.key) {
        case 'ArrowLeft':
          pan(step, 0);
          break;
        case 'ArrowRight':
          pan(-step, 0);
          break;
        case 'ArrowUp':
          pan(0, step);
          break;
        case 'ArrowDown':
          pan(0, -step);
          break;
        case '+':
        case '=':
          zoomBy(1.2);
          break;
        case '-':
        case '_':
          zoomBy(1 / 1.2);
          break;
        case '0':
          resetView();
          break;
        default:
          return;
      }
      event.preventDefault();
    },
    [ensureLoop, zoomBy, resetView],
  );

  const orphanCount = visibleNodes.filter((n) => n.isOrphan).length;
  const truncated = totalNodes > visibleNodes.length;

  const ariaLabel = useMemo(() => {
    if (visibleNodes.length === 0) return 'Internal link graph with no pages';
    return `Internal link graph: ${formatNumber(visibleNodes.length)} pages and ${formatNumber(
      visibleEdges.length,
    )} internal links${orphanCount > 0 ? `, including ${formatNumber(orphanCount)} orphan pages` : ''}. Drag to pan, scroll to zoom.`;
  }, [visibleNodes.length, visibleEdges.length, orphanCount]);

  const topNodes = useMemo(
    () => [...visibleNodes].sort((a, b) => b.inboundLinks - a.inboundLinks).slice(0, 10),
    [visibleNodes],
  );

  const controlClass =
    'inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <ChartContainer
      title={title}
      description={description}
      height={height}
      loading={loading}
      empty={visibleNodes.length === 0}
      emptyMessage={emptyMessage}
      bare={bare}
      className={className}
      bodyClassName={bare ? undefined : 'px-3 pb-3'}
      actions={
        <>
          {clusters.length > 1 ? (
            <select
              value={activeCluster ?? ''}
              onChange={(e) => setActiveCluster(e.target.value === '' ? null : e.target.value)}
              aria-label="Filter by cluster"
              className={cn(controlClass, 'max-w-[12rem]')}
            >
              <option value="">All clusters ({clusters.length})</option>
              {clusters.map(([name, count]) => (
                <option key={name} value={name}>
                  {name} ({count})
                </option>
              ))}
            </select>
          ) : null}
          <button type="button" className={controlClass} onClick={() => zoomBy(1.25)} aria-label="Zoom in">
            +
          </button>
          <button
            type="button"
            className={controlClass}
            onClick={() => zoomBy(1 / 1.25)}
            aria-label="Zoom out"
          >
            −
          </button>
          <button type="button" className={controlClass} onClick={resetView}>
            Reset
          </button>
          <button type="button" className={controlClass} onClick={relayout}>
            Re-layout
          </button>
          {actions}
        </>
      }
      footer={
        visibleNodes.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
            <span className="flex items-center gap-4">
              <span>
                {formatNumber(visibleNodes.length)} pages · {formatNumber(visibleEdges.length)} links
              </span>
              {orphanCount > 0 ? (
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 rounded-full ring-1 ring-destructive"
                    style={{ backgroundColor: 'transparent' }}
                  />
                  {formatNumber(orphanCount)} orphans
                </span>
              ) : null}
            </span>
            {truncated ? (
              <span>
                Showing top {formatNumber(visibleNodes.length)} of {formatNumber(totalNodes)} pages by
                inbound links
              </span>
            ) : null}
          </div>
        ) : undefined
      }
    >
      <div ref={containerRef} className="relative h-full w-full overflow-hidden rounded-md bg-muted/25">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          role="img"
          aria-label={ariaLabel}
          className={cn(
            'h-full w-full touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-ring',
            onNodeClick ? 'cursor-pointer' : 'cursor-grab',
          )}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => {
            dragRef.current = null;
          }}
          onPointerLeave={() => {
            hoverIdRef.current = null;
            setHover(null);
            ensureLoop();
          }}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
        />

        {hover ? (
          <div
            className="pointer-events-none absolute z-10 max-w-[18rem] rounded-md border border-border bg-popover px-2.5 py-2 text-popover-foreground shadow-popover"
            style={{
              left: Math.min(hover.x + 12, Math.max(0, sizeRef.current.width - 300)),
              top: Math.min(hover.y + 12, Math.max(0, sizeRef.current.height - 110)),
            }}
          >
            <p className="truncate text-xs font-medium">{nodeLabel(hover.node)}</p>
            <p className="truncate text-2xs text-muted-foreground">{hover.node.url}</p>
            <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-2xs">
              <dt className="text-muted-foreground">Inbound</dt>
              <dd className="tabular text-right">{formatNumber(hover.node.inboundLinks)}</dd>
              {hover.node.outboundLinks !== undefined ? (
                <>
                  <dt className="text-muted-foreground">Outbound</dt>
                  <dd className="tabular text-right">{formatNumber(hover.node.outboundLinks)}</dd>
                </>
              ) : null}
              {hover.node.depth !== undefined ? (
                <>
                  <dt className="text-muted-foreground">Depth</dt>
                  <dd className="tabular text-right">{hover.node.depth}</dd>
                </>
              ) : null}
              {hover.node.cluster ? (
                <>
                  <dt className="text-muted-foreground">Cluster</dt>
                  <dd className="truncate text-right">{hover.node.cluster}</dd>
                </>
              ) : null}
            </dl>
            {hover.node.isOrphan ? (
              <p className="mt-1.5 text-2xs font-medium text-destructive">Orphan — no internal links in</p>
            ) : null}
          </div>
        ) : null}

        {/* Canvas content is invisible to assistive tech; expose the hubs as real text. */}
        <ul className="sr-only">
          {topNodes.map((n) => (
            <li key={n.id}>
              {nodeLabel(n)} — {formatNumber(n.inboundLinks)} inbound links
              {n.isOrphan ? ', orphan page' : ''}
            </li>
          ))}
        </ul>
      </div>
    </ChartContainer>
  );
}
