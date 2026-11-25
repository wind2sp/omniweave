// Line icons of the image mode's Photoshop tools and layer buttons, on the 20 × 20 grid of shell/Icons.tsx.

import type { ReactNode } from "react";

export const PS_ICONS: Record<string, ReactNode> = {
  // dodge: Photoshop's lollipop (a circle on a stick)
  dodge: (
    <>
      <circle cx="12" cy="7" r="4" />
      <path d="M9.2 9.8 3.5 15.5" strokeLinecap="round" strokeWidth="1.8" />
    </>
  ),
  // burn: a hand making a ring (an open circle above fingers)
  burn: (
    <>
      <path d="M6 16.5c0-3 1.2-4.2 1.2-6.2M10.5 16.5c0-2.8.8-4 .8-5.8M14.5 16.5c0-2.5 1-3.6 1-5.2" strokeLinecap="round" />
      <circle cx="11" cy="5.6" r="2.6" />
    </>
  ),
  // sponge: a rounded block with pores
  sponge: (
    <>
      <path d="M4 7.5c0-2 1.3-3 3-3h6c1.7 0 3 1 3 3v6.5c0 1.2-.9 2-2 2H6c-1.1 0-2-.8-2-2Z" strokeLinejoin="round" />
      <circle cx="8" cy="9" r=".9" fill="currentColor" stroke="none" />
      <circle cx="12" cy="8.2" r=".9" fill="currentColor" stroke="none" />
      <circle cx="10.4" cy="12.2" r=".9" fill="currentColor" stroke="none" />
      <circle cx="13.6" cy="12.6" r=".7" fill="currentColor" stroke="none" />
    </>
  ),
  // layer mask: a frame with a round hole (Photoshop's panel button)
  mask: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="1.5" />
      <circle cx="10" cy="10" r="3.4" fill="currentColor" stroke="none" />
    </>
  ),
  // new adjustment layer: the half-filled circle
  adjustLayer: (
    <>
      <circle cx="10" cy="10" r="6.5" />
      <path d="M10 3.5a6.5 6.5 0 0 1 0 13z" fill="currentColor" stroke="none" />
    </>
  ),
  // spot healing brush: a bandage with a sparkle
  spotHeal: (
    <>
      <rect x="3" y="7.2" width="12" height="5.6" rx="2.8" transform="rotate(-35 9 10)" />
      <path d="M8 9.2h2M9 8.2v2" strokeLinecap="round" />
      <path d="M15.5 2.5v2.4M14.3 3.7h2.4" strokeLinecap="round" />
    </>
  ),
  // healing brush: a bandage
  heal: (
    <>
      <rect x="3" y="7.2" width="14" height="5.6" rx="2.8" transform="rotate(-35 10 10)" />
      <path d="M8.6 9.6h2.8M10 8.2v2.8" strokeLinecap="round" />
    </>
  ),
  // patch: a dashed patch with an arrow
  patch: (
    <>
      <path d="M3.5 5.5c2-2 5-2 6.5 0s1 5-1.5 6-5 1-5-2 0-4 0-4z" strokeDasharray="2 1.6" />
      <path d="M11 12.5l5 3.5M16 16l-.4-2.6M16 16l-2.6.2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // clone stamp: a rubber stamp
  clone: (
    <>
      <path d="M8 3.5h4v3.2c0 1 1.5 1.6 1.5 3.3H6.5c0-1.7 1.5-2.3 1.5-3.3z" strokeLinejoin="round" />
      <rect x="4" y="10" width="12" height="3" rx=".6" />
      <path d="M5 16h10" strokeLinecap="round" />
    </>
  ),
  // quick selection: a brush with a dashed circle
  quickSelect: (
    <>
      <circle cx="7.5" cy="12.5" r="4" strokeDasharray="2 1.6" />
      <path d="M10.3 9.7 16 4" strokeLinecap="round" />
      <path d="M15 3l2 2" strokeLinecap="round" />
    </>
  ),
  // object selection: a dashed box round a figure
  objectSelect: (
    <>
      <rect x="3" y="3" width="14" height="14" rx="1" strokeDasharray="2 1.6" />
      <circle cx="10" cy="8" r="2" />
      <path d="M6.5 14.5c.6-2.2 2-3.2 3.5-3.2s2.9 1 3.5 3.2" strokeLinecap="round" />
    </>
  ),
// paths panel: fill path, stroke path, path → selection, selection → path
  pathFill: <path d="M4 15c1-6 4-10 12-11-1 7-5 11-12 11z" fill="currentColor" stroke="none" />,
  pathStroke: <path d="M4 15c1-6 4-10 12-11-1 7-5 11-12 11z" />,
  pathToSel: <path d="M4 15c1-6 4-10 12-11-1 7-5 11-12 11z" strokeDasharray="2 1.6" />,
  selToPath: (
    <>
      <rect x="3" y="3" width="14" height="14" rx="1" strokeDasharray="2 1.6" />
      <path d="M6 13c1-3 3-6 8-7" />
    </>
  ),
  // vertical type: a T over a down arrow
  vtext: <path d="M4 4h8M8 4v9M15 5v11M13 14l2 2 2-2" strokeLinecap="round" strokeLinejoin="round" />,
  // lock transparent pixels: a checkerboard square
  lockAlpha: (
    <>
      <rect x="4" y="4" width="12" height="12" />
      <path d="M4 4h4v4H4zM12 4h4v4h-4zM8 8h4v4H8zM4 12h4v4H4zM12 12h4v4h-4z" fill="currentColor" stroke="none" />
    </>
  ),
  // lock position: a four-way arrow
  lockMove: <path d="M10 3v14M3 10h14M10 3l-2 2M10 3l2 2M10 17l-2-2M10 17l2-2M3 10l2-2M3 10l2 2M17 10l-2-2M17 10l-2 2" strokeLinecap="round" />,
};
