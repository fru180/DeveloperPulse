import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPTURE_RETRY_STORAGE_KEY,
  captureErrorFromTauri,
  clearCaptureRetryAfterRestart,
  consumeCaptureRetryAfterRestart,
  GENERIC_CAPTURE_ERROR_MESSAGE,
  markCaptureRetryAfterRestart,
  SYSTEM_AUDIO_PERMISSION_GUIDANCE,
  SYSTEM_AUDIO_SETTINGS_URL,
  tauriCaptureDebugMessage,
} from "../app/audio/capture-errors.ts";

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

test("turns a typed Tauri permission failure into safe guidance", () => {
  const rawMessage =
    "No shareable content available: user denied application capture TCC";
  const error = captureErrorFromTauri({
    code: "permission_denied",
    debugMessage: rawMessage,
  });

  assert.equal(error.code, "permission_denied");
  assert.equal(error.message, SYSTEM_AUDIO_PERMISSION_GUIDANCE.body);
  assert.doesNotMatch(error.message, /shareable content|TCC/i);
  assert.equal(
    tauriCaptureDebugMessage({
      code: "permission_denied",
      debugMessage: rawMessage,
    }),
    rawMessage,
  );
});

test("uses one friendly fallback for unknown and legacy desktop failures", () => {
  for (const failure of [
    "Could not start system audio capture: internal error",
    { code: "capture_failed", debugMessage: "internal error" },
    new Error("unexpected error"),
  ]) {
    const error = captureErrorFromTauri(failure);
    assert.equal(error.code, "capture_failed");
    assert.equal(error.message, GENERIC_CAPTURE_ERROR_MESSAGE);
  }
});

test("provides the direct macOS settings destination and manual path", () => {
  assert.equal(
    SYSTEM_AUDIO_SETTINGS_URL,
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  );
  assert.match(
    SYSTEM_AUDIO_PERMISSION_GUIDANCE.settingsPath,
    /System Settings → Privacy & Security → Screen & System Audio Recording/,
  );
  assert.equal(SYSTEM_AUDIO_PERMISSION_GUIDANCE.title, "Allow system audio");
  assert.equal(
    SYSTEM_AUDIO_PERMISSION_GUIDANCE.body,
    "Enable DeveloperPulse in:",
  );
  assert.equal(
    SYSTEM_AUDIO_PERMISSION_GUIDANCE.nextStep,
    "Then restart DeveloperPulse.",
  );
});

test("consumes the restart retry marker exactly once", () => {
  const storage = createStorage();
  assert.equal(markCaptureRetryAfterRestart(storage), true);
  assert.equal(storage.getItem(CAPTURE_RETRY_STORAGE_KEY), "1");
  assert.equal(consumeCaptureRetryAfterRestart(storage), true);
  assert.equal(consumeCaptureRetryAfterRestart(storage), false);

  markCaptureRetryAfterRestart(storage);
  clearCaptureRetryAfterRestart(storage);
  assert.equal(consumeCaptureRetryAfterRestart(storage), false);
});

test("keeps storage failures from blocking manual recovery", () => {
  const unavailableStorage = {
    getItem() {
      throw new Error("unavailable");
    },
    setItem() {
      throw new Error("unavailable");
    },
    removeItem() {
      throw new Error("unavailable");
    },
  };

  assert.equal(markCaptureRetryAfterRestart(unavailableStorage), false);
  assert.equal(consumeCaptureRetryAfterRestart(unavailableStorage), false);
  assert.doesNotThrow(() => clearCaptureRetryAfterRestart(unavailableStorage));
});
