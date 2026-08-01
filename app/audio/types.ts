export const BAND_RANGES = [
  [20, 60],
  [60, 150],
  [150, 400],
  [400, 1_000],
  [1_000, 2_500],
  [2_500, 6_000],
  [6_000, 16_000],
] as const;

export const BAND_LABELS = ["16k", "6k", "2.5k", "1k", "400", "150", "20"];
export const COLUMN_COUNT = 53;
export const ROW_COUNT = 7;
export const SPECTRUM_BAND_COUNT = 64;
export const UPDATE_INTERVAL_MS = 50;
export const TIMELINE_INTERVAL_MS = 300;

export type BandDb = [number, number, number, number, number, number, number];
export type Intensity = 0 | 1 | 2 | 3 | 4;
export type IntensityColumn = [
  Intensity,
  Intensity,
  Intensity,
  Intensity,
  Intensity,
  Intensity,
  Intensity,
];
export type SpectrumDb = number[];
export type VisualizerMode = "live-cells" | "timeline";

export interface AnalysisFrame {
  sequence: number;
  capturedAtMs: number;
  spectrumDb: SpectrumDb;
}

export interface AnalysisSource {
  readonly label: string;
  start(
    onFrame: (frame: AnalysisFrame) => void,
    onEnded: (message?: string) => void,
  ): Promise<void>;
  stop(): Promise<void>;
}

export type CaptureState = "idle" | "requesting" | "running" | "error";

export class CaptureError extends Error {
  public readonly code:
    | "unsupported"
    | "permission_denied"
    | "no_audio_track"
    | "capture_ended"
    | "capture_failed";

  constructor(
    code:
      | "unsupported"
      | "permission_denied"
      | "no_audio_track"
      | "capture_ended"
      | "capture_failed",
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "CaptureError";
  }
}
