/**
 * Small SVG visuals shared by the home and song screens (T-034): a progress ring (daily goal), an
 * accuracy sparkline and the streak-freeze glyph. Static markup only; colours come from CSS tokens
 * through `currentColor` and custom properties, so the screens' stylesheets theme them.
 * @module
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** Options for {@link progressRing}. */
export interface RingOptions {
  /** 0–1 (values above 1 render as a full ring). */
  fraction: number;
  /** Outer size in px (default 132). */
  size?: number;
  /** Stroke width in px (default 12). */
  stroke?: number;
  /** Accessible name, e.g. "Daily goal: 9 of 15 minutes". */
  label: string;
  /** Centre content (big number + caption). */
  value: string;
  caption?: string;
}

/**
 * A circular progress ring with centred text (`role="img"`). The arc is a dashed circle, so the
 * fill is one attribute; CSS animates `stroke-dashoffset` on first paint (`.hm-ring__arc`).
 */
export function progressRing(opts: RingOptions): HTMLElement {
  const size = opts.size ?? 132;
  const stroke = opts.stroke ?? 12;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const f = Math.min(1, Math.max(0, opts.fraction));
  const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, 'aria-hidden': 'true', focusable: 'false' });
  svg.append(
    svgEl('circle', { class: 'hm-ring__track', cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': stroke }),
    svgEl('circle', {
      class: 'hm-ring__arc',
      cx: size / 2,
      cy: size / 2,
      r,
      fill: 'none',
      'stroke-width': stroke,
      'stroke-linecap': 'round',
      'stroke-dasharray': c.toFixed(2),
      'stroke-dashoffset': (c * (1 - f)).toFixed(2),
      transform: `rotate(-90 ${size / 2} ${size / 2})`,
      style: `--ring-c: ${c.toFixed(2)}`,
    }),
  );
  const wrap = document.createElement('div');
  wrap.className = f >= 1 ? 'hm-ring is-complete' : 'hm-ring';
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', opts.label);
  wrap.style.setProperty('--ring-size', `${size}px`);
  const centre = document.createElement('div');
  centre.className = 'hm-ring__centre';
  centre.setAttribute('aria-hidden', 'true');
  const value = document.createElement('span');
  value.className = 'hm-ring__value rw-num';
  value.textContent = opts.value;
  centre.append(value);
  if (opts.caption) {
    const cap = document.createElement('span');
    cap.className = 'hm-ring__caption';
    cap.textContent = opts.caption;
    centre.append(cap);
  }
  wrap.append(svg, centre);
  return wrap;
}

/** Options for {@link sparkline}. */
export interface SparklineOptions {
  /** Values oldest → newest. */
  values: readonly number[];
  /** Value range (default 0–100, accuracy %). */
  min?: number;
  max?: number;
  width?: number;
  height?: number;
  /** Accessible name, e.g. "Accuracy over your last 8 runs: 72% to 91%". */
  label: string;
  /** Draw a dashed reference line at this value (e.g. 90 = clean-run threshold). */
  reference?: number;
}

/**
 * Line + area sparkline with a dot on the newest value (`role="img"`). Fewer than two values draw
 * a single dot. Pure geometry is in {@link sparklinePoints} (tested in Node).
 */
export function sparkline(opts: SparklineOptions): SVGSVGElement {
  const width = opts.width ?? 240;
  const height = opts.height ?? 56;
  const min = opts.min ?? 0;
  const max = opts.max ?? 100;
  const pts = sparklinePoints(opts.values, { width, height, min, max, pad: 4 });
  const svg = svgEl('svg', { class: 'rw-spark', viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': opts.label, preserveAspectRatio: 'none' });
  if (opts.reference !== undefined) {
    const y = yFor(opts.reference, { height, min, max, pad: 4 });
    svg.append(svgEl('line', { class: 'rw-spark__ref', x1: 0, x2: width, y1: y, y2: y }));
  }
  if (pts.length > 1) {
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
    const first = pts[0] as [number, number];
    const last = pts[pts.length - 1] as [number, number];
    svg.append(
      svgEl('path', { class: 'rw-spark__area', d: `${line} L${last[0].toFixed(1)} ${height} L${first[0].toFixed(1)} ${height} Z` }),
      svgEl('path', { class: 'rw-spark__line', d: line, fill: 'none' }),
    );
  }
  const end = pts[pts.length - 1];
  if (end) svg.append(svgEl('circle', { class: 'rw-spark__dot', cx: end[0].toFixed(1), cy: end[1].toFixed(1), r: 3.5 }));
  return svg;
}

function yFor(v: number, g: { height: number; min: number; max: number; pad: number }): number {
  const f = (Math.min(g.max, Math.max(g.min, v)) - g.min) / (g.max - g.min || 1);
  return g.pad + (1 - f) * (g.height - 2 * g.pad);
}

/**
 * Sparkline geometry: one `[x, y]` per value, spread evenly across `width` (a single value sits at
 * the right edge), y inverted so higher values are higher up, clamped to `[min, max]`.
 */
export function sparklinePoints(
  values: readonly number[],
  g: { width: number; height: number; min: number; max: number; pad: number },
): [number, number][] {
  const n = values.length;
  return values.map((v, i) => {
    const x = n === 1 ? g.width - g.pad : g.pad + (i / (n - 1)) * (g.width - 2 * g.pad);
    return [x, yFor(v, g)];
  });
}

/** Snowflake glyph for streak freezes (decorative; the caller provides the text alternative). */
export function freezeGlyph(active: boolean): SVGSVGElement {
  const svg = svgEl('svg', {
    class: active ? 'hm-freeze is-held' : 'hm-freeze',
    viewBox: '0 0 24 24',
    width: 20,
    height: 20,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2,
    'stroke-linecap': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  for (const d of ['M12 2v20', 'M3.3 7l17.4 10', 'M3.3 17l17.4-10', 'M9 4l3 2 3-2', 'M9 20l3-2 3 2']) svg.append(svgEl('path', { d }));
  return svg;
}
