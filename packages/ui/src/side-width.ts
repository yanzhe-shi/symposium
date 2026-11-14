/** The narrowest the side panel may be dragged, and the room always left for the chat. */
export const MIN_SIDE_WIDTH = 300;
export const MIN_CHAT_WIDTH = 360;

/** Which stored width applies: the Code tab is wide, the other tabs are narrow. */
export type SideLayout = 'narrow' | 'wide';

const key = (layout: SideLayout): string => `symposium.sideWidth.${layout}`;

/** Keeps a dragged width between the panel's minimum and what leaves the chat enough room. */
export function clampSideWidth(wanted: number, bodyWidth: number): number {
  const most = Math.max(MIN_SIDE_WIDTH, bodyWidth - MIN_CHAT_WIDTH);
  return Math.round(Math.min(Math.max(wanted, MIN_SIDE_WIDTH), most));
}

/** The width the human last dragged the panel to, if any. */
export function loadSideWidth(layout: SideLayout): number | undefined {
  const stored = Number(localStorage.getItem(key(layout)));
  return Number.isFinite(stored) && stored >= MIN_SIDE_WIDTH ? stored : undefined;
}

/** Remembers a width. `undefined` goes back to the default. */
export function saveSideWidth(layout: SideLayout, width: number | undefined): void {
  if (width === undefined) localStorage.removeItem(key(layout));
  else localStorage.setItem(key(layout), String(width));
}
