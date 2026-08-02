import { CaptureError } from "./types.ts";

export const SYSTEM_AUDIO_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
export const CAPTURE_RETRY_STORAGE_KEY =
  "developer-pulse-retry-system-audio-after-restart";

export const SYSTEM_AUDIO_PERMISSION_GUIDANCE = {
  title: "Allow access to system audio",
  body: "macOS requires Screen & System Audio Recording permission before DeveloperPulse can visualize audio playing on your Mac. Your audio is analyzed on this Mac—it isn’t recorded or uploaded.",
  settingsPath:
    "System Settings → Privacy & Security → Screen & System Audio Recording",
  nextStep:
    "Turn on DeveloperPulse, return here, then restart the app to apply the change.",
  openFailed: "System Settings couldn’t be opened. Follow the path above.",
  restartFailed:
    "DeveloperPulse couldn’t restart. Quit and reopen the app, then select Visualize audio.",
} as const;

export const GENERIC_CAPTURE_ERROR_MESSAGE =
  "DeveloperPulse couldn’t start audio visualization. Please try again.";

interface TauriCaptureErrorPayload {
  code: string;
  debugMessage?: string;
}

interface RetryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function isTauriCaptureErrorPayload(
  value: unknown,
): value is TauriCaptureErrorPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string"
  );
}

export function captureErrorFromTauri(value: unknown) {
  const permissionDenied =
    isTauriCaptureErrorPayload(value) && value.code === "permission_denied";
  return new CaptureError(
    permissionDenied ? "permission_denied" : "capture_failed",
    permissionDenied
      ? SYSTEM_AUDIO_PERMISSION_GUIDANCE.body
      : GENERIC_CAPTURE_ERROR_MESSAGE,
  );
}

export function tauriCaptureDebugMessage(value: unknown) {
  return isTauriCaptureErrorPayload(value) ? value.debugMessage : undefined;
}

export function markCaptureRetryAfterRestart(storage: RetryStorage) {
  try {
    storage.setItem(CAPTURE_RETRY_STORAGE_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

export function clearCaptureRetryAfterRestart(storage: RetryStorage) {
  try {
    storage.removeItem(CAPTURE_RETRY_STORAGE_KEY);
  } catch {
    // A failed cleanup must not prevent the user from retrying manually.
  }
}

export function consumeCaptureRetryAfterRestart(storage: RetryStorage) {
  try {
    const shouldRetry = storage.getItem(CAPTURE_RETRY_STORAGE_KEY) === "1";
    storage.removeItem(CAPTURE_RETRY_STORAGE_KEY);
    return shouldRetry;
  } catch {
    return false;
  }
}
