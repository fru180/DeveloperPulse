import assert from "node:assert/strict";
import test from "node:test";
import {
  activationToLiveIntensity,
  applyCellPeakSignals,
  aggregateLiveBands,
  aggregateSpectrumData,
  aggregateTimelineBands,
  bandsToColumn,
  cellPeakSignals,
  cellTargets,
  createCellProfiles,
  createEmptyGrid,
  decayCellPeaks,
  dbToIntensity,
  LIVE_RESPONSE_MS,
  pushColumn,
  smoothBands,
} from "../app/audio/analysis.ts";

test("keeps timeline levels unchanged and reserves the brightest live level for peaks", () => {
  assert.equal(dbToIntensity(-90, 0), 0);
  assert.equal(dbToIntensity(-72, 0), 1);
  assert.equal(dbToIntensity(-36, 0), 4);
  assert.equal(activationToLiveIntensity(0), 0);
  assert.equal(activationToLiveIntensity(0.51), 2);
  assert.equal(activationToLiveIntensity(1), 3);
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
  const expected = Math.floor(Math.log(frequency / 40) / Math.log(16_000 / 40) * 64);
  assert.equal(spectrum.length, 64);
  assert.ok(Math.abs(peak - expected) <= 1, `peak ${peak}, expected ${expected}`);
  assert.equal(aggregateTimelineBands(spectrum).length, 7);
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

test("generates 53 frequency columns by 7 ordered response rows", () => {
  const first = createCellProfiles();
  const second = createCellProfiles();
  assert.deepEqual(first, second);
  assert.equal(first.length, 371);
  for (let row = 0; row < 7; row += 1) {
    const profiles = first.slice(row * 53, (row + 1) * 53);
    assert.deepEqual(profiles.map((profile) => profile.columnIndex), Array.from({ length: 53 }, (_, index) => index));
    assert.ok(profiles.every((profile) => profile.responseMs === LIVE_RESPONSE_MS[row]));
  }
});

test("uses the same level target across response rows in one frequency column", () => {
  const profiles = [
    { id: 0, columnIndex: 0, responseMs: 80 },
    { id: 53, columnIndex: 0, responseMs: 140 },
  ];
  const liveBands = Array(53).fill(-100);
  liveBands[0] = -40;
  const targets = cellTargets(profiles, liveBands, 0);
  assert.ok(targets[0] > 0.7);
  assert.equal(targets[0], targets[1]);
});

test("detects local peaks only in the assigned frequency column", () => {
  const profiles = [
    { id: 0, columnIndex: 0, responseMs: 80 },
    { id: 1, columnIndex: 1, responseMs: 80 },
    { id: 53, columnIndex: 0, responseMs: 140 },
  ];
  const current = Array(53).fill(-100);
  const previous = Array(53).fill(-100);
  current[0] = -30;
  previous[0] = -55;

  const signals = cellPeakSignals(profiles, current, previous, 0);
  assert.ok(signals[0] >= 0.9);
  assert.equal(signals[1], 0);
  assert.ok(signals[2] >= 0.9);
});

test("applies sensitivity to local peak audibility", () => {
  const profiles = [
    { id: 0, columnIndex: 0, responseMs: 80 },
  ];
  const current = Array(53).fill(-100);
  current[0] = -45;

  assert.equal(cellPeakSignals(profiles, current, current, -12)[0], 0);
  assert.ok(cellPeakSignals(profiles, current, current, 12)[0] >= 0.9);
});

test("fires once, rearms after the signal drops, and fades in 180ms", () => {
  const peaks = new Float32Array(1);
  const armed = new Uint8Array([1]);
  const loud = new Float32Array([1]);
  const quiet = new Float32Array([0]);

  applyCellPeakSignals(peaks, armed, loud);
  assert.equal(peaks[0], 1);
  decayCellPeaks(peaks, 90);
  assert.ok(Math.abs(peaks[0] - 0.5) < 0.0001);

  applyCellPeakSignals(peaks, armed, loud);
  assert.ok(Math.abs(peaks[0] - 0.5) < 0.0001);
  applyCellPeakSignals(peaks, armed, quiet);
  applyCellPeakSignals(peaks, armed, loud);
  assert.equal(peaks[0], 1);
  assert.equal(decayCellPeaks(peaks, 180), false);
  assert.equal(peaks[0], 0);
});

test("smooths and quantizes the seven timeline bands", () => {
  const previous = [-80, -70, -60, -50, -40, -30, -20];
  const next = [-60, -50, -40, -30, -20, -10, 0];
  const smoothed = smoothBands(previous, next);
  assert.equal(smoothed.length, 7);
  assert.ok(smoothed[0] > previous[0] && smoothed[0] < next[0]);
  assert.equal(bandsToColumn(smoothed, 6).length, 7);
});
