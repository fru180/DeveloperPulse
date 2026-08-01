"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyLiveAttackSignals,
  aggregateLiveBands,
  aggregateTimelineBands,
  bandsToColumn,
  createEmptyGrid,
  decayLiveAttacks,
  energyToLiveIntensity,
  liveAttackSignals,
  liveBandEnergies,
  liveCellCount,
  pushColumn,
  smoothBands,
} from "./audio/analysis";
import { BrowserTabSource } from "./audio/browser-source";
import { isTauriRuntime, MacSystemAudioSource } from "./audio/tauri-source";
import { createIdlePreviewGrid } from "./idle-preview";
import {
  calculateCellGridLayout,
  LIVE_CELL_COLUMNS,
  LIVE_CELL_ROWS,
} from "./live-cell-layout";
import {
  BAND_LABELS,
  TIMELINE_INTERVAL_MS,
  TIMELINE_WINDOW_SECONDS,
  type AnalysisSource,
  type BandDb,
  type CaptureState,
  type IntensityColumn,
  type VisualizerMode,
} from "./audio/types";
import {
  DEFAULT_THEME,
  isTheme,
  THEME_META_COLORS,
  THEME_STORAGE_KEY,
  type Theme,
  VISUALIZER_PALETTES,
} from "./theme";

const LIVE_FREQUENCY_TICKS = [
  { label: "40Hz", minor: false },
  { label: "100", minor: true },
  { label: "250", minor: false },
  { label: "630", minor: true },
  { label: "1.6k", minor: false },
  { label: "4k", minor: true },
  { label: "10k", minor: true },
  { label: "16k", minor: false },
] as const;
const ATTACK_LABELS = ["Strong", "", "", "Medium", "", "", "Soft"] as const;

function LevelLegend() {
  return (
    <div className="level-legend" aria-label="Volume from quiet to loud">
      <span>Quiet</span>
      <span className="legend-swatches" aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => (
          <span className={`legend-level-${index}`} key={index} />
        ))}
      </span>
      <span>Loud</span>
    </div>
  );
}

function prepareCanvas(canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { context: canvas.getContext("2d"), width, height, ratio };
}

function roundedCell(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  color: string,
) {
  context.fillStyle = color;
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fill();
}

function renderTimeline(
  canvas: HTMLCanvasElement,
  grid: IntensityColumn[],
  colors: readonly string[],
) {
  const { context, width, height, ratio } = prepareCanvas(canvas);
  if (!context) return;
  context.clearRect(0, 0, width, height);
  const { gap, cellSize, gridWidth, gridHeight } = calculateCellGridLayout(
    width,
    ratio,
  );
  const offsetX = (width - gridWidth) / 2;
  const offsetY = (height - gridHeight) / 2;
  const radius = Math.min(2.4 * ratio, cellSize * 0.24);

  grid.forEach((column, columnIndex) => {
    column.forEach((level, bandIndex) => {
      roundedCell(
        context,
        offsetX + columnIndex * (cellSize + gap),
        offsetY + (LIVE_CELL_ROWS - 1 - bandIndex) * (cellSize + gap),
        cellSize,
        cellSize,
        radius,
        colors[level],
      );
    });
  });
}

function renderLiveCells(
  canvas: HTMLCanvasElement,
  energies: Float32Array,
  attacks: Float32Array,
  colors: readonly string[],
) {
  const { context, width, height, ratio } = prepareCanvas(canvas);
  if (!context) return;
  context.clearRect(0, 0, width, height);
  const { gap, cellSize, gridWidth, gridHeight } = calculateCellGridLayout(
    width,
    ratio,
  );
  const offsetX = (width - gridWidth) / 2;
  const offsetY = (height - gridHeight) / 2;
  const radius = Math.min(2.4 * ratio, cellSize * 0.24);

  energies.forEach((energy, column) => {
    const cellCount = liveCellCount(energy, attacks[column]);
    const intensity = energyToLiveIntensity(energy);
    for (let row = 0; row < LIVE_CELL_ROWS; row += 1) {
      const x = offsetX + column * (cellSize + gap);
      const y = offsetY + row * (cellSize + gap);
      const active = row >= LIVE_CELL_ROWS - cellCount;
      roundedCell(
        context,
        x,
        y,
        cellSize,
        cellSize,
        radius,
        colors[active ? intensity : 0],
      );
    }
  });
}

function updateLiveEnergies(
  energies: Float32Array,
  targets: Float32Array,
  deltaMs: number,
  running: boolean,
) {
  let hasVisibleCell = false;
  for (let index = 0; index < energies.length; index += 1) {
    const current = energies[index];
    const target = running ? targets[index] : 0;
    const duration = target > current ? 35 : 180;
    const blend = 1 - Math.exp(-deltaMs / duration);
    const next = current + (target - current) * blend;
    energies[index] = next < 0.002 ? 0 : next;
    if (energies[index] >= 0.05) hasVisibleCell = true;
  }
  return hasVisibleCell;
}

export function DeveloperPulse() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const timelineSmoothRef = useRef<BandDb | null>(null);
  const previousLiveBandsRef = useRef<number[] | null>(null);
  const lastTimelineUpdateRef = useRef(0);
  const gridRef = useRef<IntensityColumn[]>(createEmptyGrid());
  const modeRef = useRef<VisualizerMode>("live-cells");
  const liveEnergiesRef = useRef(new Float32Array(LIVE_CELL_COLUMNS));
  const liveTargetsRef = useRef(new Float32Array(LIVE_CELL_COLUMNS));
  const liveAttacksRef = useRef(new Float32Array(LIVE_CELL_COLUMNS));
  const liveAttackHoldsRef = useRef(new Float32Array(LIVE_CELL_COLUMNS));
  const [state, setState] = useState<CaptureState>("idle");
  const [grid, setGrid] = useState<IntensityColumn[]>(() => createEmptyGrid());
  const [idlePreview, setIdlePreview] = useState<IntensityColumn[]>(() =>
    createIdlePreviewGrid(),
  );
  const [mode, setMode] = useState<VisualizerMode>("live-cells");
  const [sensitivity, setSensitivity] = useState(0);
  const sensitivityRef = useRef(sensitivity);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState("00:00");
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof document === "undefined") return DEFAULT_THEME;
    const documentTheme = document.documentElement.dataset.theme;
    return isTheme(documentTheme) ? documentTheme : DEFAULT_THEME;
  });
  const paletteRef = useRef<(typeof VISUALIZER_PALETTES)[Theme]>(
    VISUALIZER_PALETTES[theme],
  );
  const desktop = isTauriRuntime();
  const source = useMemo<AnalysisSource>(
    () => (desktop ? new MacSystemAudioSource() : new BrowserTabSource()),
    [desktop],
  );

  useEffect(
    () => () => {
      void source.stop();
    },
    [source],
  );
  useEffect(() => {
    sensitivityRef.current = sensitivity;
  }, [sensitivity]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    gridRef.current = grid;
  }, [grid]);

  const drawCurrent = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const palette = paletteRef.current;
    if (modeRef.current === "timeline")
      renderTimeline(canvas, gridRef.current, palette.levels);
    else if (state === "idle" || state === "error")
      renderTimeline(canvas, idlePreview, palette.levels);
    else
      renderLiveCells(
        canvas,
        liveEnergiesRef.current,
        liveAttacksRef.current,
        palette.levels,
      );
  }, [idlePreview, state]);

  const syncCellGridHeight = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const stage = canvas.closest<HTMLElement>(".canvas-stage");
    if (!stage) return;
    const { gridHeight } = calculateCellGridLayout(
      canvas.getBoundingClientRect().width,
    );
    stage.style.setProperty("--cell-grid-height", `${gridHeight}px`);
  }, []);

  useEffect(() => {
    syncCellGridHeight();
    drawCurrent();
    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        syncCellGridHeight();
        drawCurrent();
      });
    });
    if (canvasRef.current) observer.observe(canvasRef.current);
    return () => {
      cancelAnimationFrame(resizeFrame);
      observer.disconnect();
    };
  }, [drawCurrent, grid, mode, syncCellGridHeight, theme]);

  useEffect(() => {
    let animationFrame = 0;
    let previousTime = performance.now();
    const tick = (time: number) => {
      const delta = Math.min(100, time - previousTime);
      previousTime = time;
      const active = updateLiveEnergies(
        liveEnergiesRef.current,
        liveTargetsRef.current,
        delta,
        state === "running",
      );
      const attackActive = decayLiveAttacks(
        liveAttacksRef.current,
        liveAttackHoldsRef.current,
        delta,
      );
      if (modeRef.current === "live-cells" && canvasRef.current) {
        const palette = paletteRef.current;
        if (state === "idle" || state === "error")
          renderTimeline(canvasRef.current, idlePreview, palette.levels);
        else
          renderLiveCells(
            canvasRef.current,
            liveEnergiesRef.current,
            liveAttacksRef.current,
            palette.levels,
          );
      }
      if (state === "running" || active || attackActive)
        animationFrame = requestAnimationFrame(tick);
    };
    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, [idlePreview, state]);

  useEffect(() => {
    if (!startedAt || state !== "running") return;
    const update = () => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      setElapsed(
        `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`,
      );
    };
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt, state]);

  const stop = useCallback(
    async (endedMessage?: string) => {
      await source.stop().catch(() => undefined);
      timelineSmoothRef.current = null;
      previousLiveBandsRef.current = null;
      liveTargetsRef.current.fill(0);
      setIdlePreview(createIdlePreviewGrid());
      setState("idle");
      setStartedAt(null);
      setElapsed("00:00");
      if (endedMessage) setError(endedMessage);
    },
    [source],
  );

  const start = useCallback(async () => {
    setState("requesting");
    setError(null);
    timelineSmoothRef.current = null;
    previousLiveBandsRef.current = null;
    lastTimelineUpdateRef.current = 0;
    liveEnergiesRef.current.fill(0);
    liveTargetsRef.current.fill(0);
    liveAttacksRef.current.fill(0);
    liveAttackHoldsRef.current.fill(0);
    const emptyGrid = createEmptyGrid();
    gridRef.current = emptyGrid;
    setGrid(emptyGrid);
    try {
      await source.start(
        (frame) => {
          const liveBands = aggregateLiveBands(frame.spectrumDb);
          liveTargetsRef.current.set(
            liveBandEnergies(liveBands, sensitivityRef.current),
          );
          const attackSignals = liveAttackSignals(
            liveBands,
            previousLiveBandsRef.current,
            sensitivityRef.current,
          );
          applyLiveAttackSignals(
            liveAttacksRef.current,
            liveAttackHoldsRef.current,
            attackSignals,
          );
          previousLiveBandsRef.current = liveBands;

          const timelineBands = smoothBands(
            timelineSmoothRef.current,
            aggregateTimelineBands(frame.spectrumDb),
          );
          timelineSmoothRef.current = timelineBands;
          if (
            frame.capturedAtMs - lastTimelineUpdateRef.current >=
            TIMELINE_INTERVAL_MS
          ) {
            lastTimelineUpdateRef.current = frame.capturedAtMs;
            setGrid((current) =>
              pushColumn(
                current,
                bandsToColumn(timelineBands, sensitivityRef.current),
              ),
            );
          }
        },
        (message) => {
          void stop(message ?? "Capture ended.");
        },
      );
      setStartedAt(Date.now());
      setState("running");
    } catch (captureError) {
      setIdlePreview(createIdlePreviewGrid());
      setState("error");
      setError(
        captureError instanceof Error
          ? captureError.message
          : "Could not start audio capture.",
      );
    }
  }, [source, stop]);

  const status = useMemo(() => {
    if (state === "requesting")
      return [
        "Waiting for permission",
        desktop ? "Allow system audio capture" : "Choose a tab with audio",
      ];
    if (state === "running") return ["Listening", source.label];
    if (state === "error")
      return ["Capture unavailable", "Check the message below and retry"];
    return ["Ready", desktop ? "Mac system audio" : "Chrome tab audio"];
  }, [desktop, source.label, state]);

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await panelRef.current?.requestFullscreen();
  };

  const toggleTheme = () => {
    const nextTheme: Theme = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = nextTheme;
    document.documentElement.style.colorScheme = nextTheme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", THEME_META_COLORS[nextTheme]);
    paletteRef.current = VISUALIZER_PALETTES[nextTheme];
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // The active theme still changes when storage is unavailable.
    }
    setTheme(nextTheme);
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="DeveloperPulse">
          <span className="brand-mark" aria-hidden="true">
            {Array.from({ length: 9 }, (_, index) => (
              <span key={index} />
            ))}
          </span>
          DeveloperPulse
        </div>
        <div className="topbar-actions">
          <div className="privacy-note">
            <span className="privacy-dot" />
            Local processing only
          </div>
          <button className="theme-toggle" type="button" onClick={toggleTheme}>
            <svg
              className="theme-icon theme-icon-moon"
              viewBox="0 0 16 16"
              aria-hidden="true"
            >
              <path d="M14 10.45A6.5 6.5 0 0 1 5.55 2 6.5 6.5 0 1 0 14 10.45Z" />
            </svg>
            <svg
              className="theme-icon theme-icon-sun"
              viewBox="0 0 16 16"
              aria-hidden="true"
            >
              <circle cx="8" cy="8" r="3" />
              <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M12.95 3.05l-1.06 1.06M4.11 11.89l-1.06 1.06" />
            </svg>
            <span className="visually-hidden theme-label-dark">
              Switch to dark mode
            </span>
            <span className="visually-hidden theme-label-light">
              Switch to light mode
            </span>
          </button>
        </div>
      </header>

      <section className="workspace">
        <section
          className="visualizer-panel"
          ref={panelRef}
          aria-label="Audio frequency visualizer"
        >
          <div className="panel-head">
            <div className="capture-state" role="status" aria-live="polite">
              <span
                className={`state-light ${state === "running" ? "running" : ""}`}
              />
              <span className="state-copy">
                <span className="state-title">{status[0]}</span>
                <span className="state-detail">{status[1]}</span>
              </span>
            </div>
            <span className="live-clock">{elapsed}</span>
          </div>

          <div className="canvas-wrap">
            <div className={`canvas-stage ${mode}`}>
              <div
                className={
                  mode === "live-cells" ? "attack-labels" : "frequency-labels"
                }
                aria-hidden="true"
              >
                {(mode === "live-cells" ? ATTACK_LABELS : BAND_LABELS).map(
                  (label, index) => (
                    <span key={`${label}-${index}`}>{label}</span>
                  ),
                )}
              </div>
              <div className="canvas-column">
                {mode === "live-cells" && (
                  <div className="live-frequency-axis" aria-hidden="true">
                    {LIVE_FREQUENCY_TICKS.map(({ label, minor }) => (
                      <span className={minor ? "minor" : undefined} key={label}>
                        {label}
                      </span>
                    ))}
                  </div>
                )}
                <canvas
                  ref={canvasRef}
                  className="spectrum-canvas"
                  aria-label={
                    mode === "live-cells"
                      ? "53 frequency columns; brighter cells indicate louder audio and taller columns indicate stronger attacks"
                      : "53 columns of time by 7 frequency bands; brighter cells indicate louder audio"
                  }
                />
                <div className={`graph-footer ${mode}`}>
                  {mode === "timeline" ? (
                    <div className="timeline-range" aria-hidden="true">
                      <span>−{TIMELINE_WINDOW_SECONDS} sec</span>
                      <span>Now</span>
                    </div>
                  ) : (
                    <span className="axis-name">Frequency</span>
                  )}
                  <LevelLegend />
                </div>
              </div>
            </div>
            {state !== "running" && state !== "requesting" && (
              <div className="idle-overlay">
                <span className="idle-message">Start to visualize</span>
              </div>
            )}
          </div>

          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}

          <div className="controls">
            <button
              className={`primary-button ${state === "running" ? "stop" : ""}`}
              type="button"
              disabled={state === "requesting"}
              onClick={
                state === "running" ? () => void stop() : () => void start()
              }
            >
              {state === "requesting"
                ? "Connecting…"
                : state === "running"
                  ? "Stop visualizing"
                  : "Start visualizing"}
            </button>
            <span className="control-divider" />
            <label className="range-control">
              <span className="control-label">Sensitivity</span>
              <input
                type="range"
                min="-18"
                max="18"
                step="1"
                value={sensitivity}
                onChange={(event) => setSensitivity(Number(event.target.value))}
              />
              <span className="range-value">
                {sensitivity > 0 ? "+" : ""}
                {sensitivity}dB
              </span>
            </label>
            <label>
              <span className="control-label visually-hidden">
                Visualizer mode
              </span>
              <select
                className="select-control"
                value={mode}
                onChange={(event) =>
                  setMode(event.target.value as VisualizerMode)
                }
              >
                <option value="live-cells">Live Cells</option>
                <option value="timeline">Timeline</option>
              </select>
            </label>
            <button
              className="icon-button"
              type="button"
              aria-label="Toggle fullscreen"
              onClick={() => void toggleFullscreen()}
            >
              <span className="fullscreen-glyph" aria-hidden="true" />
            </button>
          </div>
        </section>
        <p className="panel-footnote">
          {desktop
            ? "Allow Screen & System Audio Recording. Processed locally."
            : "Share a Chrome tab with audio. Processed locally."}
        </p>
      </section>
    </main>
  );
}
