import {
  COLUMN_COUNT,
  ROW_COUNT,
  type Intensity,
  type IntensityColumn,
} from "./audio/types.ts";

const LEVEL_THRESHOLDS = [0.55, 0.77, 0.9, 0.97] as const;

function randomToIntensity(value: number): Intensity {
  if (value < LEVEL_THRESHOLDS[0]) return 0;
  if (value < LEVEL_THRESHOLDS[1]) return 1;
  if (value < LEVEL_THRESHOLDS[2]) return 2;
  if (value < LEVEL_THRESHOLDS[3]) return 3;
  return 4;
}

export function createIdlePreviewGrid(
  random: () => number = Math.random,
): IntensityColumn[] {
  return Array.from(
    { length: COLUMN_COUNT },
    () =>
      Array.from({ length: ROW_COUNT }, () =>
        randomToIntensity(random()),
      ) as IntensityColumn,
  );
}
