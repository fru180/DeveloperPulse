import assert from "node:assert/strict";
import test from "node:test";
import {
  applyLiveAttackSignals,
  aggregateLiveBands,
  aggregateSpectrumData,
  aggregateTimelineBands,
  bandsToColumn,
  createEmptyGrid,
  decayLiveAttacks,
  dbToIntensity,
  energyToLiveIntensity,
  liveAttackSignals,
  liveBandEnergies,
  liveCellCount,
  LIVE_ATTACK_DECAY_MS,
  LIVE_ATTACK_HOLD_MS,
  pushColumn,
  smoothBands,
} from "../app/audio/analysis.ts";
import {
  calculateCellGridLayout,
  LIVE_CELL_COLUMNS,
  LIVE_CELL_ROWS,
} from "../app/live-cell-layout.ts";
import { createIdlePreviewGrid } from "../app/idle-preview.ts";

test("creates a weighted 53 by 7 idle preview from the supplied random values", () => {
  const values = [0, 0.549, 0.55, 0.769, 0.77, 0.899, 0.9, 0.969, 0.97, 0.999];
  let index = 0;
  const grid = createIdlePreviewGrid(
    () => values[Math.min(index++, values.length - 1)],
  );

  assert.equal(grid.length, 53);
  assert.ok(grid.every((column) => column.length === 7));
  assert.deepEqual(grid.flat().slice(0, 10), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  assert.ok(grid.flat().every((level) => level >= 0 && level <= 4));
});

test("can generate distinct dark and bright idle previews", () => {
  assert.ok(
    createIdlePreviewGrid(() => 0)
      .flat()
      .every((level) => level === 0),
  );
  assert.ok(
    createIdlePreviewGrid(() => 0.999)
      .flat()
      .every((level) => level === 4),
  );
});

test("sizes both canvas modes to the exact height of their square-cell grid", () => {
  const layout = calculateCellGridLayout(1_000);
  assert.ok(Math.abs(layout.gridWidth - 1_000) < 0.0001);
  assert.equal(
    layout.gridHeight,
    layout.cellSize * LIVE_CELL_ROWS + layout.gap * (LIVE_CELL_ROWS - 1),
  );
  assert.equal(
    layout.gridWidth,
    layout.cellSize * LIVE_CELL_COLUMNS + layout.gap * (LIVE_CELL_COLUMNS - 1),
  );
});

test("keeps the shared cell-grid layout stable across device pixel ratios", () => {
  const cssLayout = calculateCellGridLayout(720);
  const retinaLayout = calculateCellGridLayout(1_440, 2);
  assert.ok(Math.abs(retinaLayout.cellSize / 2 - cssLayout.cellSize) < 0.0001);
  assert.ok(
    Math.abs(retinaLayout.gridHeight / 2 - cssLayout.gridHeight) < 0.0001,
  );
});

test("maps timeline and live audio levels across all five colors", () => {
  assert.equal(dbToIntensity(-90, 0), 0);
  assert.equal(dbToIntensity(-72, 0), 1);
  assert.equal(dbToIntensity(-36, 0), 4);
  assert.equal(energyToLiveIntensity(0), 0);
  assert.equal(energyToLiveIntensity(0.51), 2);
  assert.equal(energyToLiveIntensity(0.8), 3);
  assert.equal(energyToLiveIntensity(1), 4);
});

test("keeps the existing timeline at exactly 53 columns", () => {
  const grid = createEmptyGrid();
  const next = pushColumn(grid, [1, 2, 3, 4, 3, 2, 1]);
  assert.equal(next.length, 53);
  assert.deepEqual(next.at(-1), [1, 2, 3, 4, 3, 2, 1]);
});

test("aggregates FFT data into 64 logarithmic spectrum bands", () => {
  const fftSize = 4096;
  const sampleRate = 48_000;
  const frequency = 700;
  const bins = new Float32Array(fftSize / 2).fill(-100);
  bins[Math.round(frequency / (sampleRate / fftSize))] = -20;
  const spectrum = aggregateSpectrumData(bins, sampleRate, fftSize);
  const peak = spectrum.indexOf(Math.max(...spectrum));
  const expected = Math.floor(
    (Math.log(frequency / 40) / Math.log(16_000 / 40)) * 64,
  );
  assert.equal(spectrum.length, 64);
  assert.ok(
    Math.abs(peak - expected) <= 1,
    `peak ${peak}, expected ${expected}`,
  );
  assert.equal(aggregateTimelineBands(spectrum).length, 7);
});

test("keeps equal FFT components equally strong across the spectrum", () => {
  const fftSize = 4096;
  const sampleRate = 48_000;
  for (const frequency of [50, 630, 1_600, 10_000, 15_000]) {
    const bins = new Float32Array(fftSize / 2).fill(-100);
    bins[Math.round(frequency / (sampleRate / fftSize))] = -20;
    const spectrum = aggregateSpectrumData(bins, sampleRate, fftSize);
    const liveBands = aggregateLiveBands(spectrum);
    const spectrumEnergy = spectrum.reduce(
      (power, db) => power + (db > -100 ? 10 ** (db / 10) : 0),
      0,
    );
    const liveEnergy = liveBands.reduce(
      (power, db) => power + (db > -100 ? 10 ** (db / 10) : 0),
      0,
    );
    assert.ok(
      Math.abs(10 * Math.log10(spectrumEnergy) - -20) < 0.0001,
      `${frequency}Hz spectrum energy was ${10 * Math.log10(spectrumEnergy)}dB`,
    );
    assert.ok(
      Math.abs(10 * Math.log10(liveEnergy) - -20) < 0.0001,
      `${frequency}Hz live energy was ${10 * Math.log10(liveEnergy)}dB`,
    );
  }
});

test("sums energy when analysis bands are combined", () => {
  const spectrum = Array(64).fill(-100);
  spectrum[2] = -40;
  spectrum[3] = -40;
  const expected = -40 + 10 * Math.log10(2);

  assert.ok(Math.abs(aggregateLiveBands(spectrum)[2] - expected) < 0.0001);
  assert.ok(Math.abs(aggregateTimelineBands(spectrum)[0] - expected) < 0.0001);
});

test("does not accumulate the analysis floor as band energy", () => {
  const fftSize = 4096;
  const bins = new Float32Array(fftSize / 2).fill(-100);
  const spectrum = aggregateSpectrumData(bins, 48_000, fftSize);

  assert.ok(spectrum.every((db) => db === -100));
  assert.ok(aggregateLiveBands(spectrum).every((db) => db === -100));
  assert.ok(aggregateTimelineBands(spectrum).every((db) => db === -100));
});

test("maps all 64 analysis bands into 53 ordered live columns", () => {
  const reachedColumns = new Set();
  for (let spectrumIndex = 0; spectrumIndex < 64; spectrumIndex += 1) {
    const spectrum = Array(64).fill(-100);
    spectrum[spectrumIndex] = -20;
    const liveBands = aggregateLiveBands(spectrum);
    const activeColumns = liveBands
      .map((db, columnIndex) => ({ db, columnIndex }))
      .filter(({ db }) => db > -90);
    assert.equal(activeColumns.length, 1);
    reachedColumns.add(activeColumns[0].columnIndex);
  }
  assert.equal(reachedColumns.size, 53);
});

test("maps each live frequency column to an independent color energy", () => {
  const liveBands = Array(53).fill(-100);
  liveBands[0] = -40;
  const energies = liveBandEnergies(liveBands, 0);
  assert.equal(energies.length, 53);
  assert.ok(energies[0] > 0.7);
  assert.equal(energies[1], 0);
});

test("detects attack strength only in the frequency column that rises", () => {
  const current = Array(53).fill(-100);
  const previous = Array(53).fill(-100);
  current[0] = -30;
  previous[0] = -55;

  const signals = liveAttackSignals(current, previous, 0);
  assert.equal(signals.length, 53);
  assert.equal(signals[0], 1);
  assert.equal(signals[1], 0);
});

test("uses sensitivity to gate the visibility of quiet attacks", () => {
  const current = Array(53).fill(-100);
  const previous = Array(53).fill(-100);
  current[0] = -45;

  assert.ok(liveAttackSignals(current, previous, -30)[0] < 0.01);
  assert.ok(liveAttackSignals(current, previous, 12)[0] > 0.9);
});

test("holds attack height before decaying to a single sustained cell", () => {
  const attacks = new Float32Array(1);
  const holds = new Float32Array(1);

  applyLiveAttackSignals(attacks, holds, new Float32Array([1]));
  assert.equal(attacks[0], 1);
  assert.equal(holds[0], LIVE_ATTACK_HOLD_MS);
  assert.equal(liveCellCount(1, attacks[0]), 7);

  decayLiveAttacks(attacks, holds, LIVE_ATTACK_HOLD_MS);
  assert.equal(attacks[0], 1);
  decayLiveAttacks(attacks, holds, LIVE_ATTACK_DECAY_MS / 2);
  assert.ok(Math.abs(attacks[0] - 0.5) < 0.0001);
  assert.equal(liveCellCount(1, attacks[0]), 4);
  decayLiveAttacks(attacks, holds, LIVE_ATTACK_DECAY_MS / 2);
  assert.equal(attacks[0], 0);
  assert.equal(liveCellCount(1, attacks[0]), 1);
});

test("keeps inaudible bands dark regardless of attack strength", () => {
  assert.equal(liveCellCount(0.09, 1), 0);
  assert.equal(liveCellCount(0.1, 0), 1);
  assert.equal(liveCellCount(0.1, 1), 7);
});

test("smooths and quantizes the seven timeline bands", () => {
  const previous = [-80, -70, -60, -50, -40, -30, -20];
  const next = [-60, -50, -40, -30, -20, -10, 0];
  const smoothed = smoothBands(previous, next);
  assert.equal(smoothed.length, 7);
  assert.ok(smoothed[0] > previous[0] && smoothed[0] < next[0]);
  assert.equal(bandsToColumn(smoothed, 6).length, 7);
});
