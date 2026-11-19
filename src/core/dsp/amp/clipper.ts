/**
 * Asymmetric soft clipper `y = tanh(x + bias) − tanh(bias)` (docs/monitoring.md) with first-order
 * antiderivative anti-aliasing (ADAA). Run at 4× oversampling, ADAA suppresses most of the remaining
 * aliasing at the cost of half a high-rate sample of delay.
 * @module
 */

/** ADAA falls back to the midpoint value when consecutive inputs are closer than this. */
const ADAA_EPS = 1e-6;

/** The static transfer curve: `tanh(x + bias) − tanh(bias)` (0 ↦ 0). */
export function clip(x: number, bias: number): number {
  return Math.tanh(x + bias) - Math.tanh(bias);
}

/** `ln cosh z`, overflow-safe for large |z|. */
function logCosh(z: number): number {
  const a = Math.abs(z);
  return a + Math.log1p(Math.exp(-2 * a)) - Math.LN2;
}

/** Antiderivative of {@link clip} in `x` (up to a constant): `ln cosh(x + bias) − x·tanh(bias)`. */
export function clipAntiderivative(x: number, bias: number): number {
  return logCosh(x + bias) - x * Math.tanh(bias);
}

/** Stateful ADAA clipper: `y[n] = (F(x[n]) − F(x[n−1])) / (x[n] − x[n−1])`. */
export class AdaaClipper {
  private bias = 0;
  private tb = 0;
  private x1 = 0;
  private f1 = 0;

  /** Change the asymmetry. Keeps continuity by re-evaluating the stored antiderivative. */
  setBias(bias: number): void {
    this.bias = bias;
    this.tb = Math.tanh(bias);
    this.f1 = clipAntiderivative(this.x1, bias);
  }

  /** Clip one (oversampled) sample. */
  tick(x: number): number {
    const f = logCosh(x + this.bias) - x * this.tb;
    const dx = x - this.x1;
    const y = dx > ADAA_EPS || dx < -ADAA_EPS ? (f - this.f1) / dx : Math.tanh((x + this.x1) / 2 + this.bias) - this.tb;
    this.x1 = x;
    this.f1 = f;
    return y;
  }

  /** Clear the state. */
  reset(): void {
    this.x1 = 0;
    this.f1 = clipAntiderivative(0, this.bias);
  }
}
