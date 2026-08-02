"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyLiveAttackSignals,
  aggregateLiveBands,
  aggregateTimelineBands,
  bandsToColumn,
  combineLiveEnergyTargets,
  createEmptyGrid,
  decayLiveAttacks,
  energyToLiveIntensity,
  liveAttackSignals,
  liveBandEnergies,
  liveCellCount,
  LIVE_ATTACK_REFERENCE_MS,
  pushColumn,
  smoothBands,
  updateLiveEnergies,
} from "./audio/analysis";
import { BrowserTabSource } from "./audio/browser-source";
import {
  clearCaptureRetryAfterRestart,
  consumeCaptureRetryAfterRestart,
  GENERIC_CAPTURE_ERROR_MESSAGE,
  markCaptureRetryAfterRestart,
  SYSTEM_AUDIO_PERMISSION_GUIDANCE,
  SYSTEM_AUDIO_SETTINGS_URL,
} from "./audio/capture-errors";
import { isTauriRuntime, MacSystemAudioSource } from "./audio/tauri-source";
import { createIdlePreviewGrid } from "./idle-preview";
import {
  calculateCellGridLayout,
  LIVE_CELL_COLUMNS,
  LIVE_CELL_ROWS,
} from "./live-cell-layout";
import {
  CaptureError,
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
const TIMELINE_INTERMEDIATE_TICKS = [20, 15, 10, 5] as const;
const TIMELINE_FREQUENCY_TICKS = [
  { label: "16k", row: 1 },
  { label: "1k", row: 4 },
  { label: "40", row: 7 },
] as const;
const ATTACK_LABELS = ["Sudden", "", "", "Rising", "", "", "Steady"] as const;
const DESKTOP_MIN_WIDTH = 720;
const DESKTOP_RESIZE_TOLERANCE = 1;
const DESKTOP_RESIZE_DEBOUNCE_MS = 100;

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

function VisualizeIcon() {
  return (
    <svg className="primary-button-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 2.75v10.5L13 8 4 2.75Z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg className="primary-button-icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.25" y="3.25" width="9.5" height="9.5" rx="1" />
    </svg>
  );
}

function ThemeToggle({ onToggle }: { onToggle: () => void }) {
  return (
    <button className="theme-toggle" type="button" onClick={onToggle}>
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

export function DeveloperPulse() {
  const appShellRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timelineSmoothRef = useRef<BandDb | null>(null);
  const previousTransientBandsRef = useRef<number[] | null>(null);
  const previousAnalysisAtRef = useRef<number | null>(null);
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
  const [error, setError] = useState<CaptureError | null>(null);
  const [permissionStep, setPermissionStep] = useState<
    "needs-settings" | "needs-restart"
  >("needs-settings");
  const [permissionActionError, setPermissionActionError] = useState<
    string | null
  >(null);
  const [permissionActionPending, setPermissionActionPending] = useState<
    "opening-settings" | "restarting" | null
  >(null);
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

  useEffect(() => {
    if (!desktop) return;
    const appShell = appShellRef.current;
    if (!appShell) return;

    let disposed = false;
    let firstFrame = 0;
    let secondFrame = 0;
    let resizeTimer = 0;
    let requestedHeight = 0;
    let resizeOperation = Promise.resolve();

    const scheduleWindowFit = () => {
      window.clearTimeout(resizeTimer);
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      resizeTimer = window.setTimeout(() => {
        firstFrame = requestAnimationFrame(() => {
          secondFrame = requestAnimationFrame(() => {
            const targetContentHeight =
              Math.ceil(
                Math.max(
                  appShell.scrollHeight,
                  appShell.getBoundingClientRect().height,
                ),
              ) + 1;
            if (targetContentHeight === requestedHeight) return;
            requestedHeight = targetContentHeight;

            resizeOperation = resizeOperation
              .then(async () => {
                if (disposed || targetContentHeight !== requestedHeight) return;
                const [{ LogicalSize }, { getCurrentWindow }] =
                  await Promise.all([
                    import("@tauri-apps/api/dpi"),
                    import("@tauri-apps/api/window"),
                  ]);
                if (disposed || targetContentHeight !== requestedHeight) return;

                const appWindow = getCurrentWindow();
                const [physicalSize, scaleFactor] = await Promise.all([
                  appWindow.innerSize(),
                  appWindow.scaleFactor(),
                ]);
                if (disposed || targetContentHeight !== requestedHeight) return;

                const currentSize = physicalSize.toLogical(scaleFactor);
                const windowChromeHeight = Math.max(
                  0,
                  currentSize.height - window.innerHeight,
                );
                const targetWindowHeight =
                  targetContentHeight + windowChromeHeight;
                const targetSize = new LogicalSize(
                  currentSize.width,
                  targetWindowHeight,
                );
                const targetMinSize = new LogicalSize(
                  DESKTOP_MIN_WIDTH,
                  targetWindowHeight,
                );
                const heightDifference =
                  targetWindowHeight - currentSize.height;

                if (heightDifference > DESKTOP_RESIZE_TOLERANCE) {
                  await appWindow.setSize(targetSize);
                  if (disposed || targetContentHeight !== requestedHeight)
                    return;
                  await appWindow.setMinSize(targetMinSize);
                } else if (heightDifference < -DESKTOP_RESIZE_TOLERANCE) {
                  await appWindow.setMinSize(targetMinSize);
                  if (disposed || targetContentHeight !== requestedHeight)
                    return;
                  await appWindow.setSize(targetSize);
                } else {
                  await appWindow.setMinSize(targetMinSize);
                }
              })
              .catch((windowResizeError) => {
                requestedHeight = 0;
                if (!disposed)
                  console.error(
                    "Could not fit the desktop window to its content:",
                    windowResizeError,
                  );
              });
          });
        });
      }, DESKTOP_RESIZE_DEBOUNCE_MS);
    };

    const observer = new ResizeObserver(scheduleWindowFit);
    observer.observe(appShell);
    scheduleWindowFit();

    return () => {
      disposed = true;
      window.clearTimeout(resizeTimer);
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      observer.disconnect();
    };
  }, [desktop]);

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
      previousTransientBandsRef.current = null;
      previousAnalysisAtRef.current = null;
      liveTargetsRef.current.fill(0);
      setIdlePreview(createIdlePreviewGrid());
      setState("idle");
      setStartedAt(null);
      setElapsed("00:00");
      setError(
        endedMessage ? new CaptureError("capture_ended", endedMessage) : null,
      );
    },
    [source],
  );

  const start = useCallback(async () => {
    setState("requesting");
    setError(null);
    setPermissionStep("needs-settings");
    setPermissionActionError(null);
    setPermissionActionPending(null);
    timelineSmoothRef.current = null;
    previousTransientBandsRef.current = null;
    previousAnalysisAtRef.current = null;
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
          const detailLiveBands = aggregateLiveBands(frame.spectrumDb);
          const transientLiveBands = aggregateLiveBands(
            frame.transientSpectrumDb ?? frame.spectrumDb,
          );
          const elapsedMs = previousAnalysisAtRef.current
            ? frame.capturedAtMs - previousAnalysisAtRef.current
            : LIVE_ATTACK_REFERENCE_MS;
          const attackSignals = liveAttackSignals(
            transientLiveBands,
            previousTransientBandsRef.current,
            sensitivityRef.current,
            elapsedMs,
          );
          liveTargetsRef.current.set(
            combineLiveEnergyTargets(
              liveBandEnergies(detailLiveBands, sensitivityRef.current),
              liveBandEnergies(transientLiveBands, sensitivityRef.current),
              attackSignals,
            ),
          );
          applyLiveAttackSignals(
            liveAttacksRef.current,
            liveAttackHoldsRef.current,
            attackSignals,
          );
          previousTransientBandsRef.current = transientLiveBands;
          previousAnalysisAtRef.current = frame.capturedAtMs;

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
        captureError instanceof CaptureError
          ? captureError
          : new CaptureError("capture_failed", GENERIC_CAPTURE_ERROR_MESSAGE),
      );
    }
  }, [source, stop]);

  useEffect(() => {
    if (!desktop) return;
    const retryTimer = window.setTimeout(() => {
      if (consumeCaptureRetryAfterRestart(window.localStorage)) {
        void start();
      }
    }, 0);
    return () => window.clearTimeout(retryTimer);
  }, [desktop, start]);

  const openSystemSettings = useCallback(async () => {
    setPermissionActionError(null);
    setPermissionActionPending("opening-settings");
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(SYSTEM_AUDIO_SETTINGS_URL);
      setPermissionStep("needs-restart");
    } catch {
      setPermissionActionError(SYSTEM_AUDIO_PERMISSION_GUIDANCE.openFailed);
    } finally {
      setPermissionActionPending(null);
    }
  }, []);

  const restartAndRetry = useCallback(async () => {
    setPermissionActionError(null);
    setPermissionActionPending("restarting");
    markCaptureRetryAfterRestart(window.localStorage);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("restart_app");
    } catch {
      clearCaptureRetryAfterRestart(window.localStorage);
      setPermissionActionError(SYSTEM_AUDIO_PERMISSION_GUIDANCE.restartFailed);
      setPermissionActionPending(null);
    }
  }, []);

  const permissionDenied = desktop && error?.code === "permission_denied";

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

  const captureErrorContent = permissionDenied ? (
    <section
      className="permission-card"
      role="alert"
      aria-labelledby="permission-card-title"
    >
      <div className="permission-card-copy">
        <h2 id="permission-card-title">
          {SYSTEM_AUDIO_PERMISSION_GUIDANCE.title}
        </h2>
        <p>{SYSTEM_AUDIO_PERMISSION_GUIDANCE.body}</p>
        <code className="permission-settings-path">
          {SYSTEM_AUDIO_PERMISSION_GUIDANCE.settingsPath}
        </code>
        {permissionStep === "needs-restart" && (
          <p className="permission-next-step">
            {SYSTEM_AUDIO_PERMISSION_GUIDANCE.nextStep}
          </p>
        )}
        {permissionActionError && (
          <p className="permission-action-error">{permissionActionError}</p>
        )}
      </div>
      <div className="permission-actions">
        {permissionStep === "needs-restart" ? (
          <>
            <button
              className="primary-button permission-primary-button"
              type="button"
              disabled={permissionActionPending !== null}
              onClick={() => void restartAndRetry()}
            >
              {permissionActionPending === "restarting"
                ? "Restarting…"
                : "Restart"}
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={permissionActionPending !== null}
              onClick={() => void openSystemSettings()}
            >
              {permissionActionPending === "opening-settings"
                ? "Opening…"
                : "Open System Settings"}
            </button>
          </>
        ) : (
          <button
            className="primary-button permission-primary-button"
            type="button"
            disabled={permissionActionPending !== null}
            onClick={() => void openSystemSettings()}
          >
            {permissionActionPending === "opening-settings"
              ? "Opening…"
              : "Open System Settings"}
          </button>
        )}
      </div>
    </section>
  ) : error ? (
    <div className="error-banner" role="alert">
      {error.message}
    </div>
  ) : null;

  return (
    <main
      ref={appShellRef}
      className={desktop ? "app-shell desktop-app-shell" : "app-shell"}
    >
      {!desktop && (
        <header className="topbar">
          <div className="brand" aria-label="DeveloperPulse">
            <span className="brand-mark" aria-hidden="true">
              {Array.from({ length: 9 }, (_, index) => (
                <span key={index} />
              ))}
            </span>
            DeveloperPulse
          </div>
        </header>
      )}

      <section className="workspace">
        <section
          className="visualizer-panel"
          aria-label="Audio frequency visualizer"
        >
          <div className="canvas-wrap">
            <div
              className={`canvas-stage ${mode}`}
              aria-hidden={desktop && error ? true : undefined}
            >
              <div
                className={
                  mode === "live-cells" ? "attack-labels" : "frequency-labels"
                }
                aria-hidden="true"
              >
                {mode === "live-cells"
                  ? ATTACK_LABELS.map((label, index) => (
                      <span key={`${label}-${index}`}>{label}</span>
                    ))
                  : TIMELINE_FREQUENCY_TICKS.map(({ label, row }) => (
                      <span key={label} style={{ gridRow: row }}>
                        {label}
                      </span>
                    ))}
              </div>
              <div className="canvas-column">
                <div className={`graph-value-axis ${mode}`} aria-hidden="true">
                  {mode === "live-cells" ? (
                    LIVE_FREQUENCY_TICKS.map(({ label, minor }) => (
                      <span className={minor ? "minor" : undefined} key={label}>
                        {label}
                      </span>
                    ))
                  ) : (
                    <>
                      <span className="timeline-tick" style={{ left: 0 }}>
                        −{TIMELINE_WINDOW_SECONDS} sec
                      </span>
                      {TIMELINE_INTERMEDIATE_TICKS.map((seconds) => (
                        <span
                          className="timeline-tick"
                          key={seconds}
                          style={{
                            left: `${((TIMELINE_WINDOW_SECONDS - seconds) / TIMELINE_WINDOW_SECONDS) * 100}%`,
                          }}
                        >
                          −{seconds}
                        </span>
                      ))}
                      <span className="timeline-tick" style={{ left: "100%" }}>
                        Now
                      </span>
                    </>
                  )}
                </div>
                <canvas
                  ref={canvasRef}
                  className="spectrum-canvas"
                  aria-label={
                    mode === "live-cells"
                      ? "53 frequency columns; brighter cells indicate louder audio and taller columns indicate more sudden rises in audio"
                      : "53 columns of time by 7 frequency bands; brighter cells indicate louder audio"
                  }
                />
                <div className={`graph-footer ${mode}`}>
                  <span className="axis-name">
                    {mode === "timeline" ? "Time" : "Frequency"}
                  </span>
                  <LevelLegend />
                </div>
              </div>
            </div>
            {desktop && captureErrorContent && (
              <div className="canvas-error-overlay">{captureErrorContent}</div>
            )}
          </div>

          {!desktop && captureErrorContent}

          <div className="controls">
            <button
              className={`primary-button ${state === "running" ? "stop" : ""} ${state === "requesting" ? "requesting" : ""}`}
              type="button"
              disabled={state === "requesting" || permissionDenied}
              onClick={
                state === "running" ? () => void stop() : () => void start()
              }
            >
              {state !== "requesting" &&
                (state === "running" ? <StopIcon /> : <VisualizeIcon />)}
              <span>
                {state === "requesting"
                  ? "Connecting…"
                  : state === "running"
                    ? "Stop"
                    : "Visualize audio"}
              </span>
            </button>
            <span
              className="control-elapsed"
              aria-label={`Elapsed time ${elapsed}`}
            >
              {elapsed}
            </span>
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
            <div className="display-controls">
              <ThemeToggle onToggle={toggleTheme} />
              <fieldset className="mode-control">
                <legend className="visually-hidden">Display mode</legend>
                <label className="mode-option">
                  <input
                    className="visually-hidden"
                    type="radio"
                    name="display-mode"
                    value="live-cells"
                    checked={mode === "live-cells"}
                    onChange={() => setMode("live-cells")}
                  />
                  <span>Live Cells</span>
                </label>
                <label className="mode-option">
                  <input
                    className="visually-hidden"
                    type="radio"
                    name="display-mode"
                    value="timeline"
                    checked={mode === "timeline"}
                    onChange={() => setMode("timeline")}
                  />
                  <span>Timeline</span>
                </label>
              </fieldset>
            </div>
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
