export const LIVE_CELL_COLUMNS = 53;
export const LIVE_CELL_ROWS = 7;

export function calculateCellGridLayout(width: number, pixelRatio = 1) {
  const gap = Math.max(2 * pixelRatio, Math.min(5 * pixelRatio, width / 250));
  const cellSize = (width - gap * (LIVE_CELL_COLUMNS - 1)) / LIVE_CELL_COLUMNS;
  const gridWidth =
    cellSize * LIVE_CELL_COLUMNS + gap * (LIVE_CELL_COLUMNS - 1);
  const gridHeight = cellSize * LIVE_CELL_ROWS + gap * (LIVE_CELL_ROWS - 1);

  return { gap, cellSize, gridWidth, gridHeight };
}
