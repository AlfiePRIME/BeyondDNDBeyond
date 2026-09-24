/**
 * Every grid cell on the straight line from `from` to `to`, both ends
 * included, in order (Bresenham). A fast brush drag can skip several cells
 * between two pointerover events; the editor paints this whole line so the
 * stroke stays continuous.
 */
export function cellsOnLine(
  from: { x: number; y: number },
  to: { x: number; y: number }
): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  let x = from.x;
  let y = from.y;
  const dx = Math.abs(to.x - x);
  const dy = -Math.abs(to.y - y);
  const stepX = x < to.x ? 1 : -1;
  const stepY = y < to.y ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    cells.push({ x, y });
    if (x === to.x && y === to.y) return cells;
    const doubled = 2 * err;
    if (doubled >= dy) {
      err += dy;
      x += stepX;
    }
    if (doubled <= dx) {
      err += dx;
      y += stepY;
    }
  }
}
