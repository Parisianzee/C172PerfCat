// src/lib/perf.ts
import type { DataSchema, MaybeNum, WeightTable } from '@/types';

export function normalizePA(pa: number | 'SL'): number {
  return pa === 'SL' ? 0 : (pa as number);
}

function clampIndex(x: number, axis: number[]): number | null {
  if (x < axis[0] || x > axis[axis.length - 1]) return null;
  let i = 0;
  while (i + 1 < axis.length && x > axis[i + 1]) i++;
  return i;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function bilinear(
  x: number,
  y: number,
  xs: number[],
  ys: number[],
  grid: (MaybeNum)[][] // rows = xs, cols = ys
): number | null {
  const i = clampIndex(x, xs);
  const j = clampIndex(y, ys);
  if (i === null || j === null) return null;

  const x0 = xs[i], x1 = xs[i + 1];
  const y0 = ys[j], y1 = ys[j + 1];

  const q11 = grid[i][j];
  const q12 = grid[i][j + 1];
  const q21 = grid[i + 1][j];
  const q22 = grid[i + 1][j + 1];

  if (q11 == null || q12 == null || q21 == null || q22 == null) return null;

  const tx = (x - x0) / (x1 - x0);
  const ty = (y - y0) / (y1 - y0);

  const r1 = lerp(q11, q12, ty);
  const r2 = lerp(q21, q22, ty);
  return lerp(r1, r2, tx);
}

function weightInterp<T extends (MaybeNum)[][]>(
  w: number,
  lower: { w: number; grid: T },
  upper: { w: number; grid: T },
  pick: (g: T, i: number, j: number) => MaybeNum
): T {
  const rows = lower.grid.length;
  const cols = lower.grid[0].length;
  const out: (MaybeNum)[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => null)
  );
  const t = (w - lower.w) / (upper.w - lower.w || 1);

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const a = pick(lower.grid, i, j);
      const b = pick(upper.grid, i, j);
      out[i][j] = a == null || b == null ? null : lerp(a, b, t);
    }
  }
  return out as T;
}

export interface CalcInput {
  pressureAltitudeFt: number; // may be negative in real life; we clamp to 0 for POH fidelity
  oatC: number;               // °C
  weightLb: number;           // within table min/max
  windKtSigned: number;       // +headwind, -tailwind
  dryGrass: boolean;          // add +15% of ground roll
}

export interface CalcOutput {
  groundRollFt: number | null;
  toClear50Ft: number | null;
  liftoffKIAS: number | null;
  at50ftKIAS: number | null;
  notes: string[];
}

export function calculate(data: DataSchema, input: CalcInput): CalcOutput {
  const xs = data.grid.pressure_altitudes_ft.map(normalizePA) as number[];
  const ys = data.grid.temperatures_c;
  const weightsSorted = [...data.grid.weights].sort((a, b) => a.weight_lb - b.weight_lb);
  const wMin = weightsSorted[0].weight_lb;
  const wMax = weightsSorted[weightsSorted.length - 1].weight_lb;

  const notes: string[] = [];

  if (input.weightLb < wMin || input.weightLb > wMax) {
    return {
      groundRollFt: null,
      toClear50Ft: null,
      liftoffKIAS: null,
      at50ftKIAS: null,
      notes: [`Weight ${input.weightLb.toFixed(0)} lb outside table range ${wMin}-${wMax} lb.`],
    };
  }

  // Find bracketing weights
  let lower: WeightTable = weightsSorted[0];
  let upper: WeightTable = weightsSorted[weightsSorted.length - 1];
  for (let i = 0; i < weightsSorted.length - 1; i++) {
    const a = weightsSorted[i], b = weightsSorted[i + 1];
    if (input.weightLb >= a.weight_lb && input.weightLb <= b.weight_lb) {
      lower = a; upper = b; break;
    }
  }

  const w = input.weightLb;
  const tw = (w - lower.weight_lb) / (upper.weight_lb - lower.weight_lb || 1);

  // Interpolate speeds by weight (rounded to int KIAS)
  const liftoffKIAS = Math.round(lerp(lower.speeds_kias.liftoff, upper.speeds_kias.liftoff, tw));
  const at50ftKIAS = Math.round(lerp(lower.speeds_kias.at_50ft, upper.speeds_kias.at_50ft, tw));

  // Interpolate grids by weight
  const rollGrid = weightInterp(
    w,
    { w: lower.weight_lb, grid: lower.ground_roll_ft },
    { w: upper.weight_lb, grid: upper.ground_roll_ft },
    (g, i, j) => g[i][j]
  );
  const over50Grid = weightInterp(
    w,
    { w: lower.weight_lb, grid: lower.to_clear_50ft_ft },
    { w: upper.weight_lb, grid: upper.to_clear_50ft_ft },
    (g, i, j) => g[i][j]
  );

  // --- CLAMP: pressure altitude below 0 => use SL (0 ft) row ---
  const paRaw = input.pressureAltitudeFt;
  const paMin = xs[0];
  const pa = paRaw < paMin ? paMin : paRaw;
  if (paRaw < paMin) {
    notes.push(`Pressure altitude ${paRaw} ft below POH grid; clamped to sea level (0 ft).`);
  }

  // Bilinear interpolation by (PA, OAT)
  const oat = input.oatC;
  let roll = bilinear(pa, oat, xs, ys, rollGrid);
  let over50 = bilinear(pa, oat, xs, ys, over50Grid);

  if (roll == null || over50 == null) {
    return {
      groundRollFt: null,
      toClear50Ft: null,
      liftoffKIAS,
      at50ftKIAS,
      notes: ['Requested conditions require extrapolation beyond POH grid or hit a null cell.', ...notes],
    };
  }

  // Wind adjustments
  const wind = input.windKtSigned;
  if (wind > 0) {
    // Headwind: −10% per 9 kt (cap at 50% reduction)
    const factor = Math.max(1 - (wind / 9) * 0.10, 0.5);
    roll *= factor;
    over50 *= factor;
  } else if (wind < 0) {
    // Tailwind: +10% for up to 10 kt
    const twkt = Math.min(Math.abs(wind), 10);
    const factor = 1 + (twkt / 10) * 0.10;
    roll *= factor;
    over50 *= factor;
  }

  // Dry grass: +15% of ground roll added to both
  if (input.dryGrass) {
    const grassInc = roll * 0.15;
    roll += grassInc;
    over50 += grassInc;
  }

  return {
    groundRollFt: Math.round(roll),
    toClear50Ft: Math.round(over50),
    liftoffKIAS,
    at50ftKIAS,
    notes,
  };
}
