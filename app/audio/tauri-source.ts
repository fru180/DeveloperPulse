import { CaptureError, type AnalysisFrame, type AnalysisSource } from "./types";

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
      const message =
        typeof error === "string"
          ? error
          : "Could not capture Mac system audio.";
      const code = message.toLowerCase().includes("permission")
        ? "permission_denied"
        : "capture_failed";
      throw new CaptureError(code, message);
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
