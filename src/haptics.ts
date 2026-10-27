import { Capacitor, registerPlugin } from "@capacitor/core";

type VibrationPattern = number | number[];

interface RhythmHapticsPlugin {
  isSupported(): Promise<{ supported: boolean }>;
  play(options: { pattern: number[] }): Promise<void>;
  stop(): Promise<void>;
}

const RhythmHaptics = registerPlugin<RhythmHapticsPlugin>("RhythmHaptics");

function usesNativeIOSHaptics() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}

export async function vibrationSupported() {
  if (usesNativeIOSHaptics()) {
    try {
      return (await RhythmHaptics.isSupported()).supported;
    } catch {
      return false;
    }
  }

  return typeof navigator.vibrate === "function";
}

export function playVibration(pattern: VibrationPattern) {
  if (usesNativeIOSHaptics()) {
    const normalizedPattern = (Array.isArray(pattern) ? pattern : [pattern]).map((duration) =>
      Math.max(0, Math.round(duration)),
    );
    void RhythmHaptics.play({ pattern: normalizedPattern }).catch(() => undefined);
    return;
  }

  navigator.vibrate?.(pattern);
}

export function stopVibration() {
  if (usesNativeIOSHaptics()) {
    void RhythmHaptics.stop().catch(() => undefined);
    return;
  }

  navigator.vibrate?.(0);
}
