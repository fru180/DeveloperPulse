import { aggregateSpectrumData } from "./analysis";
import { CaptureError, UPDATE_INTERVAL_MS, type AnalysisSource } from "./types";

type ChromeDisplayMediaTrackConstraints = MediaTrackConstraints & {
  suppressLocalAudioPlayback?: boolean;
};

export class BrowserTabSource implements AnalysisSource {
  readonly label = "Shared tab audio";

  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sequence = 0;
  private stopping = false;

  async start(
    onFrame: Parameters<AnalysisSource["start"]>[0],
    onEnded: Parameters<AnalysisSource["start"]>[1],
  ) {
    if (
      !navigator.mediaDevices?.getDisplayMedia ||
      typeof AudioContext === "undefined"
    ) {
      throw new CaptureError(
        "unsupported",
        "This browser cannot capture shared tab audio. Use the latest Chrome or Edge.",
      );
    }

    this.stopping = false;
    try {
      const audio: ChromeDisplayMediaTrackConstraints = {
        suppressLocalAudioPlayback: false,
      };
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio,
      });
    } catch (error) {
      if (
        error instanceof DOMException &&
        ["NotAllowedError", "AbortError"].includes(error.name)
      ) {
        throw new CaptureError(
          "permission_denied",
          "Sharing was cancelled. Choose a browser tab and enable ‘Share tab audio’. ",
        );
      }
      throw new CaptureError(
        "capture_failed",
        "Could not start tab capture. Please try again.",
      );
    }

    const audioTrack = this.stream.getAudioTracks()[0];
    if (!audioTrack) {
      await this.stop();
      throw new CaptureError(
        "no_audio_track",
        "No audio was shared. Choose a browser tab and enable ‘Share tab audio’.",
      );
    }

    audioTrack.addEventListener(
      "ended",
      () => {
        if (!this.stopping) onEnded("Tab sharing ended.");
      },
      { once: true },
    );

    this.context = new AudioContext();
    await this.context.resume();
    const source = this.context.createMediaStreamSource(this.stream);
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 4096;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -20;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);

    const values = new Float32Array(analyser.frequencyBinCount);
    this.sequence = 0;
    this.timer = setInterval(() => {
      analyser.getFloatFrequencyData(values);
      onFrame({
        sequence: this.sequence++,
        capturedAtMs: Date.now(),
        spectrumDb: aggregateSpectrumData(
          values,
          this.context?.sampleRate ?? 48_000,
          analyser.fftSize,
        ),
      });
    }, UPDATE_INTERVAL_MS);
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.context && this.context.state !== "closed")
      await this.context.close();
    this.context = null;
  }
}
