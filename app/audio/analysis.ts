import {
  BAND_RANGES,
  COLUMN_COUNT,
  ROW_COUNT,
  SPECTRUM_BAND_COUNT,
  type BandDb,
  type CellProfile,
  type Intensity,
  type IntensityColumn,
  type SpectrumDb,
} from "./types.ts";

const LEVEL_THRESHOLDS = [-72, -60, -48, -36] as const;
const EMA_ALPHA = 0.65;
const SPECTRUM_MIN_HZ = 40;
const SPECTRUM_MAX_HZ = 16_000;
const SPECTRUM_FLOOR_DB = -100;
const SPECTRUM_FLOOR_POWER = 10 ** (SPECTRUM_FLOOR_DB / 10);
const LIVE_MIN_DB = -72;
const LIVE_MAX_DB = -30;
export const LIVE_RESPONSE_MS = [80, 140, 240, 400, 650, 1_000, 1_600] as const;
export const PEAK_DECAY_MS = 180;
export const PEAK_TRIGGER = 0.82;
export const PEAK_REARM = 0.55;

export const SPECTRUM_RANGES: ReadonlyArray<readonly [number, number]> =
  Array.from({ length: SPECTRUM_BAND_COUNT }, (_, index) => {
    const low =
      SPECTRUM_MIN_HZ *
      (SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ) ** (index / SPECTRUM_BAND_COUNT);
    const high =
      SPECTRUM_MIN_HZ *
      (SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ) **
        ((index + 1) / SPECTRUM_BAND_COUNT);
    return [low, high] as const;
  });

function dbPower(db: number): number {
  if (!Number.isFinite(db) || db <= SPECTRUM_FLOOR_DB) return 0;
  return 10 ** (db / 10);
}

function powerDb(power: number): number {
  return Math.max(
    SPECTRUM_FLOOR_DB,
    10 * Math.log10(Math.max(power, SPECTRUM_FLOOR_POWER)),
  );
}

function energyDb(values: Iterable<number>): number {
  let totalPower = 0;
  for (const db of values) {
    totalPower += dbPower(db);
  }
  return powerDb(totalPower);
}

export function aggregateSpectrumData(
  frequencyDb: Float32Array,
  sampleRate: number,
  fftSize: number,
): SpectrumDb {
  const hzPerBin = sampleRate / fftSize;
  return SPECTRUM_RANGES.map(([low, high]) => {
    const start = Math.max(1, Math.floor(low / hzPerBin - 0.5));
    const end = Math.min(
      frequencyDb.length,
      Math.max(start + 1, Math.ceil(high / hzPerBin + 0.5)),
    );
    let power = 0;
    for (let index = start; index < end; index += 1) {
      const binLow = (index - 0.5) * hzPerBin;
      const binHigh = (index + 0.5) * hzPerBin;
      const overlap = Math.max(
        0,
        Math.min(high, binHigh) - Math.max(low, binLow),
      );
      power += dbPower(frequencyDb[index]) * (overlap / hzPerBin);
    }
    return powerDb(power);
  });
}

export function aggregateTimelineBands(spectrumDb: SpectrumDb): BandDb {
  return BAND_RANGES.map(([low, high]) => {
    const values = spectrumDb.filter((_, index) => {
      const [rangeLow, rangeHigh] = SPECTRUM_RANGES[index];
      const center = Math.sqrt(rangeLow * rangeHigh);
      return center >= low && center < high;
    });
    return energyDb(values);
  }) as BandDb;
}

export function aggregateLiveBands(spectrumDb: SpectrumDb): number[] {
  return Array.from({ length: COLUMN_COUNT }, (_, columnIndex) => {
    const start = Math.round(
      (columnIndex * SPECTRUM_BAND_COUNT) / COLUMN_COUNT,
    );
    const end = Math.round(
      ((columnIndex + 1) * SPECTRUM_BAND_COUNT) / COLUMN_COUNT,
    );
    return energyDb(spectrumDb.slice(start, end));
  });
}

export function smoothBands(previous: BandDb | null, next: BandDb): BandDb {
  if (!previous) return [...next] as BandDb;
  return next.map(
    (value, index) => EMA_ALPHA * value + (1 - EMA_ALPHA) * previous[index],
  ) as BandDb;
}

export function dbToIntensity(db: number, sensitivityDb: number): Intensity {
  const adjusted = db + sensitivityDb;
  if (adjusted < LEVEL_THRESHOLDS[0]) return 0;
  if (adjusted < LEVEL_THRESHOLDS[1]) return 1;
  if (adjusted < LEVEL_THRESHOLDS[2]) return 2;
  if (adjusted < LEVEL_THRESHOLDS[3]) return 3;
  return 4;
}

export function bandsToColumn(
  bands: BandDb,
  sensitivityDb: number,
): IntensityColumn {
  return bands.map((value) =>
    dbToIntensity(value, sensitivityDb),
  ) as IntensityColumn;
}

export function createEmptyGrid(): IntensityColumn[] {
  return Array.from({ length: COLUMN_COUNT }, () => [0, 0, 0, 0, 0, 0, 0]);
}

export function pushColumn(
  grid: IntensityColumn[],
  column: IntensityColumn,
): IntensityColumn[] {
  return [...grid.slice(-(COLUMN_COUNT - 1)), column];
}

export function createCellProfiles(): CellProfile[] {
  return Array.from({ length: COLUMN_COUNT * ROW_COUNT }, (_, id) => {
    const rowIndex = Math.floor(id / COLUMN_COUNT);
    return {
      id,
      columnIndex: id % COLUMN_COUNT,
      responseMs: LIVE_RESPONSE_MS[rowIndex],
    };
  });
}

export function cellTargets(
  profiles: CellProfile[],
  liveBandsDb: number[],
  sensitivityDb: number,
): Float32Array {
  const targets = new Float32Array(profiles.length);
  profiles.forEach((profile, index) => {
    const db = liveBandsDb[profile.columnIndex] ?? -100;
    const adjustedDb = db + sensitivityDb;
    targets[index] = Math.max(
      0,
      Math.min(1, (adjustedDb - LIVE_MIN_DB) / (LIVE_MAX_DB - LIVE_MIN_DB)),
    );
  });
  return targets;
}

export function cellPeakSignals(
  profiles: CellProfile[],
  liveBandsDb: number[],
  previousLiveBandsDb: number[] | null,
  sensitivityDb: number,
): Float32Array {
  const signals = new Float32Array(profiles.length);
  profiles.forEach((profile, index) => {
    const db = liveBandsDb[profile.columnIndex] ?? -100;
    const previous = previousLiveBandsDb?.[profile.columnIndex] ?? db;
    const adjustedDb = db + sensitivityDb;
    const energy = Math.max(
      0,
      Math.min(1, (adjustedDb - LIVE_MIN_DB) / (LIVE_MAX_DB - LIVE_MIN_DB)),
    );
    const rise = Math.max(0, Math.min(1, (db - previous - 4) / 8));
    const audible = Math.max(0, Math.min(1, (adjustedDb - LIVE_MIN_DB) / 18));
    const sustainedPeak = energy >= 0.9 ? energy : 0;
    signals[index] = Math.max(sustainedPeak, rise * audible);
  });
  return signals;
}

export function applyCellPeakSignals(
  peaks: Float32Array,
  armed: Uint8Array,
  signals: Float32Array,
) {
  signals.forEach((signal, index) => {
    if (signal >= PEAK_TRIGGER && armed[index]) {
      peaks[index] = 1;
      armed[index] = 0;
    } else if (signal <= PEAK_REARM) {
      armed[index] = 1;
    }
  });
}

export function decayCellPeaks(peaks: Float32Array, deltaMs: number) {
  let hasVisiblePeak = false;
  for (let index = 0; index < peaks.length; index += 1) {
    peaks[index] = Math.max(0, peaks[index] - deltaMs / PEAK_DECAY_MS);
    if (peaks[index] > 0) hasVisiblePeak = true;
  }
  return hasVisiblePeak;
}

export function activationToLiveIntensity(activation: number): Intensity {
  if (activation < 0.1) return 0;
  if (activation < 0.38) return 1;
  if (activation < 0.68) return 2;
  return 3;
}
