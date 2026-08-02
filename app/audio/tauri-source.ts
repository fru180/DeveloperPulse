import type { AnalysisFrame, AnalysisSource } from "./types";
import {
  captureErrorFromTauri,
  tauriCaptureDebugMessage,
} from "./capture-errors";

export class MacSystemAudioSource implements AnalysisSource {
  async start(onFrame: Parameters<AnalysisSource["start"]>[0]) {
    try {
      const [{ invoke }, { Channel }] = await Promise.all([
        import("@tauri-apps/api/core"),
        import("@tauri-apps/api/core"),
      ]);
      const channel = new Channel<AnalysisFrame>();
      channel.onmessage = onFrame;
      await invoke("start_system_audio", { onMessage: channel });
    } catch (error) {
      const debugMessage = tauriCaptureDebugMessage(error);
      if (debugMessage) {
        console.error(
          "Could not start Mac system audio capture:",
          debugMessage,
        );
      }
      throw captureErrorFromTauri(error);
    }
  }

  async stop() {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("stop_system_audio");
  }
}

export function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
