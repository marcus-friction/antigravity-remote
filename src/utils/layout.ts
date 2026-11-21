export const TABLET_MIN_WIDTH = 600;
export const TABLET_MIN_SHORTEST_SIDE = 600;

/**
 * Returns true when the viewport matches a tablet (or unfolded large-screen) form factor.
 * Requires both width and shortest side >= 600dp (standard Android `sw600dp` / iPad threshold)
 * so landscape phones (e.g., 844x390) remain in overlay-drawer phone mode.
 */
export function isTabletViewport(width: number, height: number): boolean {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return false;
  }
  return (
    width >= TABLET_MIN_WIDTH &&
    Math.min(width, height) >= TABLET_MIN_SHORTEST_SIDE
  );
}

/**
 * Computes the navigation sidebar width for the current viewport.
 * On tablets, keeps the docked split-view sidebar compact enough to leave
 * generous room for the live chat pane; on phones, fills 86% up to 344dp.
 */
export function computeDrawerWidth(
  windowWidth: number,
  isTablet: boolean,
): number {
  const safeWidth =
    Number.isFinite(windowWidth) && windowWidth > 0 ? windowWidth : 390;
  if (isTablet) {
    return Math.min(344, Math.max(288, Math.round(safeWidth * 0.34)));
  }
  return Math.min(344, Math.max(296, Math.round(safeWidth * 0.86)));
}
