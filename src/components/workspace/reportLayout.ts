export const REPORT_TILE_GAP = 10;
const MIN_COLUMN_WIDTH = 300;

export function reportColumnCount(width: number, mobile: boolean): number {
  return mobile ? 1 : Math.max(1, Math.min(4, Math.floor((width + REPORT_TILE_GAP) / (MIN_COLUMN_WIDTH + REPORT_TILE_GAP))));
}

/** h 只用于首次测量前估高，排布结果不设置或放大卡片尺寸。 */
export function layoutReportTiles(
  tiles: ReadonlyArray<{ key: string; h: number }>,
  columns: number,
  measured: Readonly<Record<string, number>>,
) {
  const bottoms = Array.from({ length: columns }, () => 0);
  const placed = tiles.map((tile) => {
    let column = 0;
    for (let index = 1; index < columns; index += 1) {
      if (bottoms[index]! < bottoms[column]!) column = index;
    }
    const top = bottoms[column]!;
    bottoms[column] = top + (measured[tile.key] ?? tile.h) + REPORT_TILE_GAP;
    return { column, top };
  });
  return { placed, bottoms, height: Math.max(0, ...bottoms) - (tiles.length ? REPORT_TILE_GAP : 0) };
}

/**
 * 各列末尾剩下的空当：列高不齐时短的那几列下面会空一截。
 * bottoms[column] 已经含了一个间距，所以它就是占位块的顶；高度补到整块的底边为止。
 */
export function reportTrailingGaps(
  bottoms: ReadonlyArray<number>,
  height: number,
  minHeight = 90,
): Array<{ column: number; top: number; height: number }> {
  return bottoms
    .map((bottom, column) => ({ column, top: bottom, height: height - bottom }))
    .filter((gap) => gap.height >= minHeight);
}

export interface ReportGapShape {
  focus: { x: number; y: number };
  height: number;
  left: number;
  path: string;
  top: number;
  width: number;
}

/** Build the rounded skyline used to fill the trailing waterfall gaps; radius 0 cuts square corners (poster style). */
export function buildReportGapShape(
  bottoms: ReadonlyArray<number>,
  height: number,
  columnWidth: number,
  radius = 14,
): ReportGapShape | null {
  const gaps = reportTrailingGaps(bottoms, height, 40);
  if (!gaps.length || Math.max(...gaps.map((gap) => gap.height)) < 90) return null;
  const from = gaps[0]!.column;
  const to = gaps[gaps.length - 1]!.column;
  const spanLeft = (column: number) => column * (columnWidth + REPORT_TILE_GAP);
  const left = spanLeft(from);
  const right = spanLeft(to) + columnWidth;
  const tops: number[] = [];
  for (let column = from; column <= to; column += 1) tops.push(Math.min(bottoms[column]!, height - 24));
  const top = Math.min(...tops);
  // The skyline's bounding box can start above most of its visible area. Keep
  // the swarm in the column with the deepest visible region so clip-path does
  // not hide the whole animation at the geometric center of the box.
  const focusIndex = tops.reduce((best, value, index) => value < tops[best]! ? index : best, 0);
  const focusColumn = from + focusIndex;
  const focusTop = tops[focusIndex]! - top;
  const focusHeight = Math.max(1, height - top - focusTop);
  const focus = {
    x: spanLeft(focusColumn) - left + columnWidth / 2,
    y: focusTop + focusHeight / 2,
  };
  const points: Array<[number, number]> = [];
  tops.forEach((value, index) => {
    const column = from + index;
    const x0 = index === 0 ? left : spanLeft(column) - REPORT_TILE_GAP / 2;
    const x1 = index === tops.length - 1 ? right : spanLeft(column) + columnWidth + REPORT_TILE_GAP / 2;
    points.push([x0 - left, value - top], [x1 - left, value - top]);
  });
  points.push([right - left, height - top], [0, height - top]);
  return { focus, height: height - top, left, path: roundedPath(points, radius), top, width: right - left };
}

/** Round polygon corners without drawing through short skyline steps. */
function roundedPath(points: ReadonlyArray<[number, number]>, radius: number): string {
  const shape = points.filter((point, index) => {
    const previous = points[(index + points.length - 1) % points.length]!;
    return Math.hypot(point[0] - previous[0], point[1] - previous[1]) > 0.5;
  });
  if (shape.length < 3) return "";
  const toward = (from: [number, number], to: [number, number], distance: number): [number, number] => {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
    return [from[0] + (to[0] - from[0]) * distance / length, from[1] + (to[1] - from[1]) * distance / length];
  };
  const parts: string[] = [];
  shape.forEach((corner, index) => {
    const previous = shape[(index + shape.length - 1) % shape.length]!;
    const next = shape[(index + 1) % shape.length]!;
    const limit = Math.min(
      radius,
      Math.hypot(corner[0] - previous[0], corner[1] - previous[1]) / 2,
      Math.hypot(next[0] - corner[0], next[1] - corner[1]) / 2,
    );
    const enter = toward(corner, previous, limit);
    const exit = toward(corner, next, limit);
    parts.push(`${index === 0 ? "M" : "L"}${enter[0].toFixed(1)} ${enter[1].toFixed(1)}`);
    parts.push(`Q${corner[0].toFixed(1)} ${corner[1].toFixed(1)} ${exit[0].toFixed(1)} ${exit[1].toFixed(1)}`);
  });
  return `${parts.join(" ")} Z`;
}
