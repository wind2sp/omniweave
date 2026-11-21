// Omniweave line-icon set. Drawn on a 20×20 grid; every stroke uses
// vector-effect: non-scaling-stroke (see styles.css), so lines stay 1.5px at any size.

import type { ReactNode } from "react";

const P: Record<string, ReactNode> = {
  // ── tools ──
  select: <path d="M5 3.5 15 9.2l-4.4 1.1-2.1 4.2Z" strokeLinejoin="round" />,
  direct: (
    <>
      <path d="M5 3.5 15 9.2l-4.4 1.1-2.1 4.2Z" strokeLinejoin="round" />
      <rect x="13.2" y="13.2" width="3.3" height="3.3" rx=".4" fill="currentColor" stroke="none" />
    </>
  ),
  hand: (
    <path d="M6.5 10.5V5.2a1.2 1.2 0 0 1 2.4 0V9m0-4.8V3.9a1.2 1.2 0 0 1 2.4 0V9m0-4.1a1.2 1.2 0 0 1 2.4 0V9.5m0-2.7a1.2 1.2 0 0 1 2.3 0v4.4c0 3.1-2.2 5.3-5.2 5.3-2.3 0-3.5-1-4.7-2.8L4 10.9c-.6-1 .6-2 1.5-1.3l1 .9" strokeLinecap="round" strokeLinejoin="round" />
  ),
  brush: (
    <>
      <path d="M16.5 3.5 9.6 10.4" strokeLinecap="round" />
      <path d="M9.6 10.4 8 9c-1.8 0-3 1.2-3 3 0 1.4-.6 2.4-1.5 3 2.6.6 5.6.2 6.8-1.4.8-1 .6-2.3-.2-3.2Z" strokeLinejoin="round" />
    </>
  ),
  eraser: (
    <>
      <path d="m8.2 16 7.9-7.9a1.5 1.5 0 0 0 0-2.1l-2.6-2.6a1.5 1.5 0 0 0-2.1 0L3.6 11.2a1.5 1.5 0 0 0 0 2.1L6.3 16h10.2" strokeLinejoin="round" strokeLinecap="round" />
      <path d="m7.6 7.6 5 5" />
    </>
  ),
  pen: (
    <>
      <path d="M10 2.8 15 9l-2.3 6H7.3L5 9Z" strokeLinejoin="round" />
      <path d="M10 2.8v6.4" />
      <circle cx="10" cy="10.4" r="1.2" />
      <path d="M7 17.5h6" strokeLinecap="round" />
    </>
  ),
  rect: <rect x="3.5" y="4.5" width="13" height="11" rx="1.5" />,
  ellipse: <ellipse cx="10" cy="10" rx="6.5" ry="5.8" />,
  text: <path d="M4.5 5.5V4h11v1.5M10 4v12m-2.5 0h5" strokeLinecap="round" strokeLinejoin="round" />,
  // image mode (Omniweave's own drawings, not Adobe's glyphs)
  marquee: <rect x="3.5" y="4.5" width="13" height="11" rx=".5" strokeDasharray="2.2 1.8" />,
  marqueeEllipse: <ellipse cx="10" cy="10" rx="6.6" ry="5.6" strokeDasharray="2.2 1.8" />,
  lasso: (
    <>
      <path d="M6.2 13.6C3.8 12.6 3 10.9 3.6 9c.9-3 4.6-4.9 8.4-4.4 3.5.5 5 2.6 4.3 4.9-.7 2.4-4 4-7.4 4" strokeLinecap="round" strokeDasharray="2.2 1.6" />
      <path d="M8.9 13.5c-1.5.1-2.6.8-2.6 1.8 0 .9 1 1.4 1.8 1.2" strokeLinecap="round" />
    </>
  ),
  wand: (
    <>
      <path d="m3.5 16.5 8.6-8.6" strokeLinecap="round" strokeWidth="2" />
      <path d="M14.5 2.5v2.4M14.5 8.1v2.4M10.5 6.5h2.4M16.1 6.5h2.4M11.9 3.9l1.3 1.3M15.8 7.8l1.3 1.3M17.1 3.9l-1.3 1.3" strokeLinecap="round" />
    </>
  ),
  eyedropper: (
    <>
      <path d="M3.5 16.5 4.4 13l6.8-6.8 2.6 2.6L7 15.6Z" strokeLinejoin="round" />
      <path d="m11.6 4.6 1.6-1.6a1.7 1.7 0 0 1 2.4 0l1.4 1.4a1.7 1.7 0 0 1 0 2.4l-1.6 1.6M10 5.5l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  gradient: (
    <>
      <rect x="3.5" y="4.5" width="13" height="11" rx="1.5" />
      <path d="M6 4.5v11M8.5 4.5v11M11 4.5v11" strokeOpacity=".75" />
      <path d="M13.2 4.5v11" strokeOpacity=".4" />
    </>
  ),
  zoom: (
    <>
      <circle cx="8.6" cy="8.6" r="5.1" />
      <path d="m12.4 12.4 4.1 4.1" strokeLinecap="round" strokeWidth="2" />
    </>
  ),
  // design mode
  line: <path d="M4 16 16 4" strokeLinecap="round" />,
  anchorAdd: (
    <>
      <path d="M8.5 3.5 13.5 9l-2 5.5H5.5L3.5 9Z" strokeLinejoin="round" />
      <path d="M8.5 3.5v5.2" />
      <path d="M15 12.5v5M12.5 15h5" strokeLinecap="round" />
    </>
  ),
  anchorDel: (
    <>
      <path d="M8.5 3.5 13.5 9l-2 5.5H5.5L3.5 9Z" strokeLinejoin="round" />
      <path d="M8.5 3.5v5.2" />
      <path d="M12.5 15h5" strokeLinecap="round" />
    </>
  ),
  // convert anchor point: the caret (Illustrator's ^) over a point with its handle line
  anchorConvert: (
    <>
      <path d="M4 16.5 10 4l6 12.5" strokeLinejoin="round" strokeLinecap="round" />
      <path d="M5.5 11.5h9" strokeLinecap="round" opacity=".55" />
      <rect x="8.6" y="10.1" width="2.8" height="2.8" fill="currentColor" stroke="none" />
    </>
  ),
  // curvature: a nib drawing a smooth curve through dots
  curvature: (
    <>
      <path d="M8 3.5 12 8.5l-1.6 4.5H5.6L4 8.5Z" strokeLinejoin="round" />
      <path d="M8 3.5v4.2" />
      <path d="M11 17c1.6-3.4 4.4-3.4 6 0" strokeLinecap="round" />
      <circle cx="14" cy="14.5" r=".9" fill="currentColor" stroke="none" />
    </>
  ),
  swapArrows: <path d="M5 8.5V6.5a2 2 0 0 1 2-2h6.5M11.5 2.5l2 2-2 2M15 11.5v2a2 2 0 0 1-2 2H6.5M8.5 17.5l-2-2 2-2" strokeLinecap="round" strokeLinejoin="round" />,
  outlineView: (
    <>
      <rect x="3.5" y="4.5" width="13" height="11" rx="1.5" />
      <path d="m3.5 4.5 13 11m0-11-13 11" strokeOpacity=".55" />
    </>
  ),

  // ── edit / file ──
  undo: <path d="M7.5 5 4 8.5 7.5 12M4.5 8.5h7a4 4 0 0 1 0 8H9" strokeLinecap="round" strokeLinejoin="round" />,
  redo: <path d="M12.5 5 16 8.5 12.5 12M15.5 8.5h-7a4 4 0 0 0 0 8H11" strokeLinecap="round" strokeLinejoin="round" />,
  save: (
    <>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h7.4L16 7.1v7.4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 14.5Z" strokeLinejoin="round" />
      <path d="M7 4v3.2h5V4M6.8 16v-4.3h6.4V16" strokeLinejoin="round" />
    </>
  ),
  export: (
    <>
      <path d="M10 12.5V3.5M6.5 7 10 3.5 13.5 7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 11v3.5A1.5 1.5 0 0 0 5.5 16h9a1.5 1.5 0 0 0 1.5-1.5V11" strokeLinecap="round" />
    </>
  ),
  open: (
    <path d="M3.5 15V5.5A1.5 1.5 0 0 1 5 4h3l1.6 1.8H15a1.5 1.5 0 0 1 1.5 1.5v1.2M3.5 15l2-5.5h12L15.4 15Z" strokeLinejoin="round" />
  ),
  newFile: (
    <>
      <path d="M11.5 3.5H6A1.5 1.5 0 0 0 4.5 5v10A1.5 1.5 0 0 0 6 16.5h8a1.5 1.5 0 0 0 1.5-1.5V7.5Z" strokeLinejoin="round" />
      <path d="M11.5 3.5v4h4M10 9.5v4.5M7.8 11.8h4.4" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  play: <path d="M6.5 4.6v10.8a.6.6 0 0 0 .9.5l8.6-5.4a.6.6 0 0 0 0-1L7.4 4.1a.6.6 0 0 0-.9.5Z" strokeLinejoin="round" />,
  plus: <path d="M10 4.5v11M4.5 10h11" strokeLinecap="round" />,
  minus: <path d="M4.5 10h11" strokeLinecap="round" />,
  copy: (
    <>
      <rect x="7" y="7" width="9" height="9" rx="1.5" />
      <path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7" />
    </>
  ),
  trash: (
    <path d="M4 6h12M8 6V4.5h4V6M5.5 6l.8 9.6a1.5 1.5 0 0 0 1.5 1.4h4.4a1.5 1.5 0 0 0 1.5-1.4L14.5 6M8.5 9v5m3-5v5" strokeLinecap="round" strokeLinejoin="round" />
  ),
  up: <path d="M5.5 12 10 7.5l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />,
  down: <path d="M5.5 8.5 10 13l4.5-4.5" strokeLinecap="round" strokeLinejoin="round" />,
  chevron: <path d="m6.5 8.5 3.5 3.5 3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />,
  chevronRight: <path d="m8.5 6.5 3.5 3.5-3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />,
  close: <path d="m5.5 5.5 9 9m0-9-9 9" strokeLinecap="round" />,
  check: <path d="m4.5 10.5 3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" />,
  eye: (
    <>
      <path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5Z" strokeLinejoin="round" />
      <circle cx="10" cy="10" r="2.2" />
    </>
  ),
  eyeOff: (
    <path d="M8.3 5.2A7 7 0 0 1 10 5c4.7 0 7.5 5 7.5 5a12.5 12.5 0 0 1-2 2.6M12 12.1A2.2 2.2 0 0 1 8 10c0-.6.2-1.1.6-1.5M5.3 6.4C3.5 7.8 2.5 10 2.5 10s2.8 5 7.5 5c1.3 0 2.5-.4 3.5-1M3.5 3.5l13 13" strokeLinecap="round" strokeLinejoin="round" />
  ),
  lock: (
    <>
      <rect x="4.5" y="9" width="11" height="7.5" rx="1.5" />
      <path d="M7 9V6.8a3 3 0 0 1 6 0V9" />
    </>
  ),
  unlock: (
    <>
      <rect x="4.5" y="9" width="11" height="7.5" rx="1.5" />
      <path d="M7 9V6.8a3 3 0 0 1 5.8-1.1" strokeLinecap="round" />
    </>
  ),
  fit: <path d="M3.5 7.5v-4h4m5 0h4v4m0 5v4h-4m-5 0h-4v-4" strokeLinecap="round" strokeLinejoin="round" />,
  search: (
    <>
      <circle cx="8.8" cy="8.8" r="5.3" />
      <path d="m12.6 12.6 3.9 3.9" strokeLinecap="round" />
    </>
  ),
  zoomIn: (
    <>
      <circle cx="8.8" cy="8.8" r="5.3" />
      <path d="m12.6 12.6 3.9 3.9M8.8 6.6v4.4M6.6 8.8H11" strokeLinecap="round" />
    </>
  ),
  sun: (
    <>
      <circle cx="10" cy="10" r="3.2" />
      <path d="M10 2.5v1.6m0 11.8v1.6M2.5 10h1.6m11.8 0h1.6M4.7 4.7l1.1 1.1m8.4 8.4 1.1 1.1m0-10.6-1.1 1.1m-8.4 8.4-1.1 1.1" strokeLinecap="round" />
    </>
  ),
  moon: <path d="M15.8 12.4A6.5 6.5 0 0 1 7.6 4.2a6.5 6.5 0 1 0 8.2 8.2Z" strokeLinejoin="round" />,
  panelLeft: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="1.5" />
      <path d="M8 4v12" />
    </>
  ),
  panelRight: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="1.5" />
      <path d="M12 4v12" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="10" r=".9" fill="currentColor" />
      <circle cx="10" cy="10" r=".9" fill="currentColor" />
      <circle cx="15" cy="10" r=".9" fill="currentColor" />
    </>
  ),

  // ── panels / kinds ──
  pages: (
    <>
      <rect x="6" y="3.5" width="10" height="12" rx="1.5" />
      <path d="M4 6.5v9A1.5 1.5 0 0 0 5.5 17H13" strokeLinecap="round" />
    </>
  ),
  folder: <path d="M2.8 5.6c0-.7.6-1.3 1.3-1.3h3.6l1.6 1.8h6.6c.7 0 1.3.6 1.3 1.3v7.2c0 .7-.6 1.3-1.3 1.3H4.1c-.7 0-1.3-.6-1.3-1.3Z" strokeLinejoin="round" />,
  folderOpen: (
    <>
      <path d="M2.8 14.4V5.6c0-.7.6-1.3 1.3-1.3h3.6l1.6 1.8h5.3c.7 0 1.3.6 1.3 1.3v1" strokeLinejoin="round" />
      <path d="M2.8 14.4 5 8.9c.2-.5.6-.8 1.1-.8h10.4c.6 0 1 .6.8 1.1l-2 5.3c-.2.5-.6.8-1.1.8H4.1c-.7 0-1.3-.4-1.3-.9Z" strokeLinejoin="round" />
    </>
  ),
  clipArrow: <path d="M6 4v6.5c0 1.4 1.1 2.5 2.5 2.5H15m-2.5-2.5L15 13l-2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />,
  clipMask: (
    <>
      <rect x="3" y="9" width="11" height="7.5" rx="1.2" />
      <path d="M7 3.5v3.3c0 .9.7 1.6 1.6 1.6H16m-2-2 2 2-2 2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  layers: (
    <>
      <path d="m10 3.5 6.5 3.5L10 10.5 3.5 7Z" strokeLinejoin="round" />
      <path d="m3.5 10 6.5 3.5 6.5-3.5M3.5 13l6.5 3.5 6.5-3.5" strokeLinejoin="round" />
    </>
  ),
  sliders: (
    <path d="M4 6h5m4 0h3M4 14h2m4 0h6M11 4v4M8 12v4" strokeLinecap="round" />
  ),
  sparkle: (
    <>
      <path d="M9 3.5 10.4 7.6 14.5 9 10.4 10.4 9 14.5 7.6 10.4 3.5 9 7.6 7.6Z" strokeLinejoin="round" />
      <path d="M15 13v3.5M13.3 14.8h3.4" strokeLinecap="round" />
    </>
  ),
  raster: (
    <>
      <rect x="3.5" y="3.5" width="13" height="13" rx="1.5" />
      <path d="M3.5 8h13M3.5 12.3h13M8 3.5v13m4.3-13v13" opacity=".7" />
    </>
  ),
  vector: (
    <>
      <path d="M4.5 15C6 8 9 5 15.5 4.5" />
      <rect x="2.8" y="13.8" width="3.4" height="3.4" rx=".5" />
      <rect x="13.8" y="2.8" width="3.4" height="3.4" rx=".5" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="4" width="13" height="12" rx="1.5" />
      <circle cx="7.5" cy="8" r="1.3" />
      <path d="m3.5 14 4-3.6 3 2.4 2.5-2 3.5 3" strokeLinejoin="round" />
    </>
  ),
  pdf: (
    <>
      <path d="M11.5 3.5H6A1.5 1.5 0 0 0 4.5 5v10A1.5 1.5 0 0 0 6 16.5h8a1.5 1.5 0 0 0 1.5-1.5V7.5Z" strokeLinejoin="round" />
      <path d="M11.5 3.5v4h4M7.5 11h5M7.5 13.5h3.5" strokeLinecap="round" />
    </>
  ),
  doc: (
    <>
      <path d="M5.5 3.5h9A1.5 1.5 0 0 1 16 5v10a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 15V5a1.5 1.5 0 0 1 1.5-1.5Z" />
      <path d="M7 7h6M7 10h6M7 13h4" strokeLinecap="round" />
    </>
  ),
  slide: (
    <>
      <rect x="2.5" y="4.5" width="15" height="9.5" rx="1.5" />
      <path d="M10 14v2.5M7 16.5h6" strokeLinecap="round" />
    </>
  ),
  design: (
    <>
      <path d="M3.5 6.5h13M3.5 13.5h13M6.5 3.5v13M13.5 3.5v13" strokeLinecap="round" opacity=".9" />
    </>
  ),
  master: (
    <>
      <rect x="3" y="4" width="14" height="9" rx="1.5" />
      <path d="M5.5 16h9M7 6.8h6" strokeLinecap="round" />
    </>
  ),
  // ── work modes = page kinds (docs/design/SHELL_LAYOUT.md §12). One set, used by the mode switch, the start screen's
  // categories, the document tabs, page thumbnails and the status bar. Each keeps one idea that survives 16 px:
  // a page with lines and a caret (typing), a 16:9 screen with play, a photo over a layer, a curve on its anchor
  // with handles, and the logo's three threads around a page. Own drawings — not any office or Adobe mark.
  modeAuto: (
    <>
      <path d="M8.91 3.85A6.25 6.25 0 0 1 16.16 8.91M15.87 12.14A6.25 6.25 0 0 1 7.86 15.87M5.21 14.02A6.25 6.25 0 0 1 5.98 5.21" strokeLinecap="round" />
      <rect x="8.55" y="8" width="2.9" height="4" rx=".5" fill="currentColor" stroke="none" />
    </>
  ),
  modeDoc: (
    <>
      <rect x="4.25" y="2.75" width="11.5" height="14.5" rx="1.5" />
      <path d="M7 6.5h6M7 9.5h6M7 12.5h3.25" strokeLinecap="round" />
      <path d="M12.75 11.25v2.5" strokeLinecap="round" />
    </>
  ),
  modeSlide: (
    <>
      <rect x="2.25" y="3.75" width="15.5" height="9" rx="1.25" />
      <path d="M10 12.75v3M7 16.25h6" strokeLinecap="round" />
      <path d="M8.6 6.4v3.7l3.1-1.85Z" fill="currentColor" strokeLinejoin="round" strokeWidth={1} />
    </>
  ),
  modeImage: (
    <>
      <path d="M6.25 3.25h8.5a2 2 0 0 1 2 2v8.5" strokeLinecap="round" />
      <rect x="3.25" y="6.25" width="10.5" height="10.5" rx="1.5" />
      <path d="m3.5 15 3.2-3.1 2.4 2 1.6-1.4 3 2.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx="10.5" cy="9.25" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  // ── drawing screen (ui/cad): set square + crosshair; AutoCAD-like ideas drawn in the Omniweave line style, no trade dress ──
  modeDraw: (
    <>
      <path d="M3.5 16.5V5.5l11 11Z" strokeLinejoin="round" />
      <path d="M6.3 13.7v-3l3 3Z" strokeLinejoin="round" />
      <path d="M14 3.5v5M11.5 6h5" strokeLinecap="round" />
    </>
  ),
  cadLine: (
    <>
      <path d="M4.5 15.5 15.5 4.5" strokeLinecap="round" />
      <rect x="3" y="14" width="3" height="3" rx=".3" fill="currentColor" stroke="none" />
      <rect x="14" y="3" width="3" height="3" rx=".3" fill="currentColor" stroke="none" />
    </>
  ),
  cadPline: (
    <>
      <path d="M3.5 15.5 7 6.5l5 7 4.5-9" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx="7" cy="6.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="13.5" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  cadCircle: (
    <>
      <circle cx="10" cy="10" r="6.3" />
      <path d="M10 10h6.3" strokeLinecap="round" />
      <circle cx="10" cy="10" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  cadArc: (
    <>
      <path d="M3.8 15A6.6 6.6 0 0 1 15.6 7.6" strokeLinecap="round" />
      <rect x="2.4" y="14.2" width="2.8" height="2.8" rx=".3" fill="currentColor" stroke="none" />
      <rect x="14.4" y="5.6" width="2.8" height="2.8" rx=".3" fill="currentColor" stroke="none" />
    </>
  ),
  cadRect: (
    <>
      <rect x="3.5" y="5" width="13" height="10" />
      <rect x="2.2" y="3.7" width="2.6" height="2.6" rx=".3" fill="currentColor" stroke="none" />
      <rect x="15.2" y="13.7" width="2.6" height="2.6" rx=".3" fill="currentColor" stroke="none" />
    </>
  ),
  cadMove: <path d="M10 2.8v14.4M2.8 10h14.4M7.8 5 10 2.8 12.2 5M7.8 15 10 17.2l2.2-2.2M5 7.8 2.8 10 5 12.2M15 7.8l2.2 2.2-2.2 2.2" strokeLinecap="round" strokeLinejoin="round" />,
  cadScale: (
    <>
      <rect x="3.5" y="9.5" width="7" height="7" />
      <path d="M3.5 3.5h13v13" strokeDasharray="2 2" />
      <path d="M8 12l7.5-7.5M11 4.5h4.5V9" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  cadMirror: (
    <>
      <path d="M10 2.5v15" strokeDasharray="2 2" />
      <path d="M7.5 5 3 14h4.5ZM12.5 5 17 14h-4.5Z" strokeLinejoin="round" />
    </>
  ),
  cadOffset: (
    <>
      <path d="M3.5 15.5c1-6 5-10 12-11" strokeLinecap="round" />
      <path d="M6.5 16.5c.8-4.6 3.8-7.6 10-8.4" strokeLinecap="round" strokeDasharray="2.2 1.8" />
    </>
  ),
  cadTrim: (
    <>
      <path d="M3 10h14" strokeLinecap="round" />
      <path d="M10 3v7" strokeLinecap="round" />
      <path d="M10 13v4" strokeLinecap="round" strokeDasharray="1.5 1.5" />
      <path d="M13.5 13.5l3 3m0-3-3 3" strokeLinecap="round" />
    </>
  ),
  cadExtend: (
    <>
      <path d="M16.5 3v14" strokeLinecap="round" />
      <path d="M3.5 10h6" strokeLinecap="round" />
      <path d="M9.5 10h7" strokeLinecap="round" strokeDasharray="1.6 1.6" />
      <path d="M11.5 7.5 14 10l-2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  cadFillet: (
    <>
      <path d="M4 16.5V10a6 6 0 0 1 6-6h6.5" strokeLinecap="round" />
      <path d="M4 4v3M4 4h3" strokeLinecap="round" strokeDasharray="1.4 1.4" />
    </>
  ),
  cadExplode: (
    <>
      <path d="M8 8H4.5v-3.5M12 8h3.5V4.5M8 12H4.5v3.5M12 12h3.5v3.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 10l-1.6-1.6M10 10l1.6-1.6M10 10l-1.6 1.6M10 10l1.6 1.6" strokeLinecap="round" />
    </>
  ),
  cadJoin: (
    <>
      <path d="M3.5 14.5l5-5" strokeLinecap="round" />
      <path d="M11.5 9.5h5" strokeLinecap="round" />
      <circle cx="10" cy="9.5" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  cadArray: (
    <>
      <rect x="3.5" y="3.5" width="4" height="4" rx=".6" />
      <rect x="12.5" y="3.5" width="4" height="4" rx=".6" />
      <rect x="3.5" y="12.5" width="4" height="4" rx=".6" />
      <rect x="12.5" y="12.5" width="4" height="4" rx=".6" strokeDasharray="1.4 1.2" />
    </>
  ),
  cadDist: (
    <>
      <path d="M3.5 13.5h13M3.5 10.5v6M16.5 10.5v6" strokeLinecap="round" />
      <path d="M6 13.5l-2.5-1.6v3.2ZM14 13.5l2.5-1.6v3.2Z" fill="currentColor" stroke="none" />
      <path d="M7 6.5h6" strokeLinecap="round" />
    </>
  ),
  cadArea: (
    <>
      <path d="M3.5 15.5 5 5l7-1.5 4.5 8-6 4Z" strokeLinejoin="round" />
      <path d="M6.5 13 8 8m1.5 5 2-4.5" strokeLinecap="round" strokeDasharray="1.4 1.6" />
    </>
  ),
  cadDim: (
    <>
      <path d="M3.5 4v8M16.5 4v8M3.5 10h13" strokeLinecap="round" />
      <path d="M6.2 10 3.5 8.5v3ZM13.8 10l2.7-1.5v3Z" fill="currentColor" stroke="none" />
      <path d="M7.5 15.5h5" strokeLinecap="round" />
    </>
  ),
  cadOrtho: <path d="M4.5 3.5v12h12M4.5 11.5h4v4" strokeLinecap="round" strokeLinejoin="round" />,
  cadPolar: (
    <>
      <path d="M4 16h12.5M4 16 14.5 5.5M4 16l7-11.5" strokeLinecap="round" />
      <path d="M8.5 16a4.5 4.5 0 0 0-1.3-3.2" />
    </>
  ),
  cadOsnap: (
    <>
      <rect x="5.5" y="5.5" width="9" height="9" />
      <path d="M10 2.5v5M10 12.5v5M2.5 10h5M12.5 10h5" strokeLinecap="round" />
    </>
  ),
  cadLwt: (
    <>
      <path d="M3.5 5h13" strokeWidth="0.8" strokeLinecap="round" />
      <path d="M3.5 10h13" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M3.5 15.5h13" strokeWidth="2.8" strokeLinecap="round" />
    </>
  ),
  cadSnap: (
    <>
      <circle cx="5" cy="5" r="1" fill="currentColor" stroke="none" />
      <circle cx="10" cy="5" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="5" r="1" fill="currentColor" stroke="none" />
      <circle cx="5" cy="10" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="10" r="1" fill="currentColor" stroke="none" />
      <circle cx="5" cy="15" r="1" fill="currentColor" stroke="none" />
      <circle cx="10" cy="15" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="15" r="1" fill="currentColor" stroke="none" />
      <path d="M10 8v4M8 10h4" strokeLinecap="round" />
    </>
  ),
  cadDyn: (
    <>
      <rect x="8" y="10" width="9" height="5.5" rx="1" />
      <path d="M3 3.5l3.6 8.4 1.2-3.4 3.4-1.2Z" strokeLinejoin="round" />
    </>
  ),
  modeDesign: (
    <>
      <path d="M3.5 15.5C4.8 11.6 6.3 9.6 8.4 8.7M11.6 8.7c2.1.9 3.6 2.9 4.9 6.8" strokeLinecap="round" />
      <path d="M4.4 7.25h4M11.6 7.25h4" />
      <circle cx="3.3" cy="7.25" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="16.7" cy="7.25" r="1.2" fill="currentColor" stroke="none" />
      <rect x="8.4" y="5.65" width="3.2" height="3.2" rx=".4" />
      <rect x="2.4" y="14.4" width="2.2" height="2.2" rx=".3" fill="currentColor" stroke="none" />
      <rect x="15.4" y="14.4" width="2.2" height="2.2" rx=".3" fill="currentColor" stroke="none" />
    </>
  ),
  upload: (
    <path d="M10 13V4m-3.5 3.5L10 4l3.5 3.5M4.5 13.5v1.5A1.5 1.5 0 0 0 6 16.5h8a1.5 1.5 0 0 0 1.5-1.5v-1.5" strokeLinecap="round" strokeLinejoin="round" />
  ),

  // ── typography ──
  bold: <path d="M6 4h4.8a3 3 0 0 1 0 6H6Zm0 6h5.6a3 3 0 0 1 0 6H6Z" strokeLinejoin="round" />,
  italic: <path d="M8.5 4h6M5.5 16h6M11.5 4l-3 12" strokeLinecap="round" />,
  underline: <path d="M6 3.5V9a4 4 0 0 0 8 0V3.5M5 16.5h10" strokeLinecap="round" />,
  alignLeft: <path d="M3.5 5h13M3.5 8.5h8M3.5 12h13M3.5 15.5h8" strokeLinecap="round" />,
  alignCenter: <path d="M3.5 5h13M6 8.5h8M3.5 12h13M6 15.5h8" strokeLinecap="round" />,
  alignRight: <path d="M3.5 5h13M8.5 8.5h8M3.5 12h13M8.5 15.5h8" strokeLinecap="round" />,
  alignJustify: <path d="M3.5 5h13M3.5 8.5h13M3.5 12h13M3.5 15.5h13" strokeLinecap="round" />,
  lineHeight: <path d="M9 5h7.5M9 10h7.5M9 15h7.5M5 4v12M3.3 5.8 5 4l1.7 1.8M3.3 14.2 5 16l1.7-1.8" strokeLinecap="round" strokeLinejoin="round" />,
  wrap: <path d="M3.5 5h13M3.5 10h10.5a2.5 2.5 0 0 1 0 5H10m1.7-1.8L10 15l1.7 1.7M3.5 15h3" strokeLinecap="round" strokeLinejoin="round" />,

  // ── pathfinder ──
  union: <path d="M3.5 3.5h8v4h5v9h-9v-4.5h-4Z" strokeLinejoin="round" fill="currentColor" fillOpacity=".25" />,
  subtract: (
    <>
      <path d="M3.5 3.5h9v4.5H8v4.5H3.5Z" strokeLinejoin="round" fill="currentColor" fillOpacity=".25" />
      <rect x="8" y="8" width="8.5" height="8.5" strokeDasharray="1.6 1.6" />
    </>
  ),
  intersect: (
    <>
      <rect x="3.5" y="3.5" width="9" height="9" strokeDasharray="1.6 1.6" />
      <rect x="7.5" y="7.5" width="9" height="9" strokeDasharray="1.6 1.6" />
      <rect x="7.5" y="7.5" width="5" height="5" fill="currentColor" fillOpacity=".45" />
    </>
  ),
  exclude: (
    <>
      <path d="M3.5 3.5h9v4h-5v5h-4Z" fill="currentColor" fillOpacity=".25" stroke="none" />
      <path d="M12.5 7.5h4v9h-9v-4h5Z" fill="currentColor" fillOpacity=".25" stroke="none" />
      <rect x="3.5" y="3.5" width="9" height="9" />
      <rect x="7.5" y="7.5" width="9" height="9" />
    </>
  ),
  forward: (
    <>
      <rect x="3.5" y="8" width="8.5" height="8.5" rx="1" strokeDasharray="1.6 1.6" />
      <rect x="8" y="3.5" width="8.5" height="8.5" rx="1" fill="currentColor" fillOpacity=".3" />
    </>
  ),
  backward: (
    <>
      <rect x="8" y="3.5" width="8.5" height="8.5" rx="1" fill="currentColor" fillOpacity=".3" />
      <rect x="3.5" y="8" width="8.5" height="8.5" rx="1" fill="var(--bg-1)" />
    </>
  ),
  toFront: <path d="M10 15.5v-9m-3.5 3L10 6l3.5 3.5M5 3.5h10" strokeLinecap="round" strokeLinejoin="round" />,
  toBack: <path d="M10 4.5v9m-3.5-3L10 14l3.5-3.5M5 16.5h10" strokeLinecap="round" strokeLinejoin="round" />,
  elevate: (
    <>
      <path d="M11.5 3.5H6A1.5 1.5 0 0 0 4.5 5v10A1.5 1.5 0 0 0 6 16.5h3" strokeLinejoin="round" strokeLinecap="round" />
      <path d="M11.5 3.5v4h4v2" strokeLinejoin="round" />
      <path d="M14 17V11.5m-2.3 2.2 2.3-2.2 2.3 2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7 8h2.5M7 11h2" strokeLinecap="round" />
    </>
  ),
  transition: (
    <>
      <rect x="2.5" y="5" width="8" height="10" rx="1.2" />
      <rect x="9.5" y="5" width="8" height="10" rx="1.2" fill="currentColor" fillOpacity=".25" />
    </>
  ),
  clock: (
    <>
      <circle cx="10" cy="10" r="6.5" />
      <path d="M10 6.5V10l2.5 1.6" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  drop: <path d="M10 3.5s5 5.2 5 8.5a5 5 0 0 1-10 0c0-3.3 5-8.5 5-8.5Z" strokeLinejoin="round" />,
  hardness: (
    <>
      <circle cx="10" cy="10" r="6.5" strokeDasharray="1.4 1.6" />
      <circle cx="10" cy="10" r="3.5" fill="currentColor" fillOpacity=".35" />
    </>
  ),
  opacity: (
    <>
      <circle cx="10" cy="10" r="6.5" />
      <path d="M10 3.5a6.5 6.5 0 0 1 0 13Z" fill="currentColor" fillOpacity=".45" stroke="none" />
    </>
  ),
  blend: (
    <>
      <circle cx="7.8" cy="10" r="4.5" />
      <circle cx="12.2" cy="10" r="4.5" />
    </>
  ),
  rotate: <path d="M15.5 10a5.5 5.5 0 1 1-1.8-4.1M15.8 3.6v3.2h-3.2" strokeLinecap="round" strokeLinejoin="round" />,
  grip: (
    <>
      <circle cx="8" cy="6" r=".9" fill="currentColor" />
      <circle cx="12" cy="6" r=".9" fill="currentColor" />
      <circle cx="8" cy="10" r=".9" fill="currentColor" />
      <circle cx="12" cy="10" r=".9" fill="currentColor" />
      <circle cx="8" cy="14" r=".9" fill="currentColor" />
      <circle cx="12" cy="14" r=".9" fill="currentColor" />
    </>
  ),
  cursorClick: (
    <>
      <path d="m8 8 8 3-3.5 1.3L11 16Z" strokeLinejoin="round" />
      <path d="M6 3.5v2M3.5 6h2M4.2 4.2l1.3 1.3" strokeLinecap="round" />
    </>
  ),
  link: <path d="M8.5 11.5 11.5 8.5M7.2 9.4 5.6 11a2.6 2.6 0 0 0 3.7 3.7l1.6-1.6m-2-6.5 1.6-1.6A2.6 2.6 0 0 1 14.2 8.6l-1.6 1.6" strokeLinecap="round" />,
  info: (
    <>
      <circle cx="10" cy="10" r="6.5" />
      <path d="M10 9v4.5" strokeLinecap="round" />
      <circle cx="10" cy="6.6" r=".8" fill="currentColor" stroke="none" />
    </>
  ),
  table: (
    <>
      <rect x="3.5" y="4.5" width="13" height="11" rx="1.5" />
      <path d="M3.5 8.2h13M3.5 11.9h13M8 4.5v11M12.2 4.5v11" />
    </>
  ),
  media: (
    <>
      <rect x="3" y="5" width="14" height="10" rx="2" />
      <path d="m8.6 7.8 3.6 2.2-3.6 2.2Z" fill="currentColor" stroke="none" />
    </>
  ),
  audio: (
    <>
      <path d="M4 8h2.5L10 5v10l-3.5-3H4Z" strokeLinejoin="round" />
      <path d="M12.8 7.5a3.4 3.4 0 0 1 0 5M14.8 5.8a6 6 0 0 1 0 8.4" strokeLinecap="round" />
    </>
  ),
  tools: (
    <>
      <path d="M12.5 3.8a3.3 3.3 0 0 0-3.9 4.4l-4.8 4.8a1.4 1.4 0 0 0 2 2l4.8-4.8a3.3 3.3 0 0 0 4.4-3.9l-2 2-1.8-.4-.4-1.8Z" strokeLinejoin="round" />
    </>
  ),
  stop: <rect x="5.5" y="5.5" width="9" height="9" rx="1.2" fill="currentColor" stroke="none" />,
  camera: (
    <>
      <path d="M3.5 7.2c0-.9.7-1.6 1.6-1.6h1.6l1.2-1.6h4.2l1.2 1.6h1.6c.9 0 1.6.7 1.6 1.6v6.6c0 .9-.7 1.6-1.6 1.6H5.1c-.9 0-1.6-.7-1.6-1.6Z" strokeLinejoin="round" />
      <circle cx="10" cy="10.4" r="2.6" />
    </>
  ),
  shield: <path d="M10 3.2 15.5 5v4.6c0 3.4-2.4 5.9-5.5 7.2-3.1-1.3-5.5-3.8-5.5-7.2V5Z" strokeLinejoin="round" />,
  // ── object align / distribute (bar = reference line) ──
  objLeft: (
    <>
      <path d="M3.5 3v14" strokeLinecap="round" />
      <rect x="5.5" y="5" width="10" height="3.5" rx=".6" />
      <rect x="5.5" y="11.5" width="6" height="3.5" rx=".6" />
    </>
  ),
  objHCenter: (
    <>
      <path d="M10 3v14" strokeLinecap="round" />
      <rect x="4.5" y="5" width="11" height="3.5" rx=".6" />
      <rect x="6.5" y="11.5" width="7" height="3.5" rx=".6" />
    </>
  ),
  objRight: (
    <>
      <path d="M16.5 3v14" strokeLinecap="round" />
      <rect x="4.5" y="5" width="10" height="3.5" rx=".6" />
      <rect x="8.5" y="11.5" width="6" height="3.5" rx=".6" />
    </>
  ),
  objTop: (
    <>
      <path d="M3 3.5h14" strokeLinecap="round" />
      <rect x="5" y="5.5" width="3.5" height="10" rx=".6" />
      <rect x="11.5" y="5.5" width="3.5" height="6" rx=".6" />
    </>
  ),
  objVCenter: (
    <>
      <path d="M3 10h14" strokeLinecap="round" />
      <rect x="5" y="4.5" width="3.5" height="11" rx=".6" />
      <rect x="11.5" y="6.5" width="3.5" height="7" rx=".6" />
    </>
  ),
  objBottom: (
    <>
      <path d="M3 16.5h14" strokeLinecap="round" />
      <rect x="5" y="4.5" width="3.5" height="10" rx=".6" />
      <rect x="11.5" y="8.5" width="3.5" height="6" rx=".6" />
    </>
  ),
  distH: (
    <>
      <path d="M3 3.5v13M17 3.5v13" strokeLinecap="round" />
      <rect x="8" y="6" width="4" height="8" rx=".6" />
      <path d="M4.5 10H7m6 0h2.5" strokeLinecap="round" strokeDasharray="1 1.4" />
    </>
  ),
  distV: (
    <>
      <path d="M3.5 3h13M3.5 17h13" strokeLinecap="round" />
      <rect x="6" y="8" width="8" height="4" rx=".6" />
      <path d="M10 4.5V7m0 6v2.5" strokeLinecap="round" strokeDasharray="1 1.4" />
    </>
  ),
  // ── view aids ──
  ruler: (
    <>
      <rect x="2.8" y="6.5" width="14.4" height="7" rx="1" />
      <path d="M5.5 6.5v2.4M8 6.5v3.6M10.5 6.5v2.4M13 6.5v3.6M15.2 6.5v2.4" strokeLinecap="round" />
    </>
  ),
  grid: <path d="M3.5 3.5h13v13h-13ZM7.8 3.5v13M12.2 3.5v13M3.5 7.8h13M3.5 12.2h13" strokeLinejoin="round" />,
  guides: <path d="M7 2.5v15M2.5 13h15" strokeLinecap="round" strokeDasharray="2.2 1.6" />,
  magnet: (
    <path d="M5 3.5h3v6.2a2 2 0 0 0 4 0V3.5h3v6.2a5 5 0 0 1-10 0ZM5 6.5h3m4 0h3" strokeLinejoin="round" />
  ),
  rotateLeft: <path d="M4.5 10a5.5 5.5 0 1 0 1.8-4.1M4.2 3.6v3.2h3.2" strokeLinecap="round" strokeLinejoin="round" />,
  flipH: (
    <>
      <path d="M10 2.5v15" strokeLinecap="round" strokeDasharray="1.6 1.4" />
      <path d="M8 5 3 14.5h5Z" strokeLinejoin="round" />
      <path d="M12 5l5 9.5h-5Z" strokeLinejoin="round" fill="currentColor" fillOpacity=".25" />
    </>
  ),
  flipV: (
    <>
      <path d="M2.5 10h15" strokeLinecap="round" strokeDasharray="1.6 1.4" />
      <path d="M5 8l9.5-5v5Z" strokeLinejoin="round" />
      <path d="M5 12l9.5 5v-5Z" strokeLinejoin="round" fill="currentColor" fillOpacity=".25" />
    </>
  ),
  transform: (
    <>
      <rect x="4.5" y="4.5" width="11" height="11" strokeDasharray="1.8 1.4" />
      <path d="M3 3h3v3H3ZM14 3h3v3h-3ZM3 14h3v3H3ZM14 14h3v3h-3Z" fill="currentColor" stroke="none" />
    </>
  ),
  crop: <path d="M6 2.5V14h11.5M2.5 6H14v11.5" strokeLinecap="round" strokeLinejoin="round" />,
  organize: (
    <>
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <rect x="11" y="3" width="6" height="6" rx="1" />
      <rect x="3" y="11" width="6" height="6" rx="1" />
      <rect x="11" y="11" width="6" height="6" rx="1" strokeDasharray="1.6 1.2" />
    </>
  ),
  // ── document mode (ribbon tabs Insert / Layout / View, navigation pane) ──
  pageBreak: (
    <>
      <path d="M5 2.5v4.5h10V2.5M5 17.5V13h10v4.5" strokeLinejoin="round" />
      <path d="M2.5 10h2.2M7 10h2M11 10h2M15.3 10h2.2" strokeLinecap="round" />
    </>
  ),
  sectionBreak: (
    <>
      <path d="M5 2.5v4.5h10V2.5M5 17.5V13h10v4.5" strokeLinejoin="round" />
      <path d="M2.5 9h15M2.5 11h15" strokeLinecap="round" />
    </>
  ),
  margins: (
    <>
      <rect x="4" y="2.5" width="12" height="15" rx="1" />
      <rect x="6.5" y="5" width="7" height="10" strokeDasharray="1.4 1.2" />
    </>
  ),
  paper: (
    <>
      <path d="M5 2.5h7l3.5 3.5v11.5H5Z" strokeLinejoin="round" />
      <path d="M12 2.5V6h3.5" strokeLinejoin="round" />
    </>
  ),
  orientation: (
    <>
      <rect x="2.5" y="6" width="9" height="11.5" rx="1" />
      <path d="M8 2.5h8.5a1 1 0 0 1 1 1V10" strokeLinecap="round" />
      <path d="m15.5 8 2 2 2-2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  columns: (
    <>
      <path d="M3 4h5.5M3 7h5.5M3 10h5.5M3 13h5.5M3 16h5.5M11.5 4H17M11.5 7H17M11.5 10H17M11.5 13H17M11.5 16H17" strokeLinecap="round" />
    </>
  ),
  footnote: (
    <>
      <path d="M3 4.5h10M3 7.5h10M3 10.5h6" strokeLinecap="round" />
      <path d="M3 14.5h5M11 15.5l1.8-1.3V18" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14.5 4.5l1.6-1.2v4" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  pilcrow: <path d="M9 16.5V3.5h6M12.5 3.5v13M9 3.5a3.5 3.5 0 0 0 0 7" strokeLinecap="round" strokeLinejoin="round" />,
  // a speech bubble with lines: comments and the review pane (메모·검토)
  comment: (
    <>
      <path d="M4 3.5h12a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 2.8V14.5H4A1.5 1.5 0 0 1 2.5 13V5A1.5 1.5 0 0 1 4 3.5z" strokeLinejoin="round" />
      <path d="M6 7.5h8M6 10.5h5" strokeLinecap="round" />
    </>
  ),
  header: (
    <>
      <rect x="3.5" y="2.5" width="13" height="15" rx="1" />
      <path d="M3.5 7h13" />
      <path d="M6 5h5" strokeLinecap="round" strokeWidth="2" />
    </>
  ),
  footer: (
    <>
      <rect x="3.5" y="2.5" width="13" height="15" rx="1" />
      <path d="M3.5 13h13" />
      <path d="M6 15.2h5" strokeLinecap="round" strokeWidth="2" />
    </>
  ),
  pageNum: (
    <>
      <rect x="3.5" y="2.5" width="13" height="15" rx="1" />
      <path d="M9 13.2l1.4-1v4" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  symbol: <path d="M4 16.5h3.8v-1.6A5.3 5.3 0 0 1 10 4a5.3 5.3 0 0 1 2.2 10.9v1.6H16" strokeLinecap="round" strokeLinejoin="round" />,
  textBox: (
    <>
      <rect x="2.5" y="4" width="15" height="12" rx="1" strokeDasharray="2 1.4" />
      <path d="M7 7.5h6M10 7.5v6" strokeLinecap="round" />
    </>
  ),
  zoomWidth: (
    <>
      <rect x="5" y="3" width="10" height="14" rx="1" />
      <path d="M1.8 10h3.2M15 10h3.2M3.5 8.5 1.8 10l1.7 1.5M16.5 8.5l1.7 1.5-1.7 1.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  zoomPage: (
    <>
      <rect x="5.5" y="2.5" width="9" height="12" rx="1" />
      <path d="M3 17.5h14" strokeLinecap="round" />
    </>
  ),
  outline: (
    <>
      <path d="M3 4.5h9M5.5 8.5h9M5.5 12h7M3 16h10" strokeLinecap="round" />
    </>
  ),
  indentMore: <path d="M3 4h14M9 8h8M9 12h8M3 16h14M3 8l3 2-3 2" strokeLinecap="round" strokeLinejoin="round" />,
  indentLess: <path d="M3 4h14M9 8h8M9 12h8M3 16h14M6 8l-3 2 3 2" strokeLinecap="round" strokeLinejoin="round" />,
  bullets: (
    <>
      <circle cx="4" cy="5" r=".9" fill="currentColor" stroke="none" />
      <circle cx="4" cy="10" r=".9" fill="currentColor" stroke="none" />
      <circle cx="4" cy="15" r=".9" fill="currentColor" stroke="none" />
      <path d="M7.5 5H17M7.5 10H17M7.5 15H17" strokeLinecap="round" />
    </>
  ),
  numbering: (
    <>
      <path d="M2.8 3.8 4 3v4M2.8 7h2.4M2.8 12.2a1.2 1.2 0 1 1 2 .9L2.8 15h2.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.5 5H17M7.5 10H17M7.5 15H17" strokeLinecap="round" />
    </>
  ),
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={"ic" + (className ? " " + className : "")} width={size} height={size} style={{ width: `calc(${size}px * var(--ui-scale, 1))`, height: `calc(${size}px * var(--ui-scale, 1))` }} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true" focusable="false">
      {P[name]}
    </svg>
  );
}

/** Point on the logo ring (32-unit box, PIL angles: 0° = right, clockwise). */
const ringPt = (deg: number, r: number) => {
  const a = (deg * Math.PI) / 180;
  return `${(16 + r * Math.cos(a)).toFixed(2)} ${(16 + r * Math.sin(a)).toFixed(2)}`;
};
const ringArc = (from: number, to: number, r: number) => `M${ringPt(from, r)}A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${ringPt(to, r)}`;
/** violet · teal · coral spans of assets/make_icon.py (woven_ring), in the same order */
const RING: [number, number, string][] = [
  [-120, 10, "#7c5cff"],
  [0, 130, "#22d3c5"],
  [120, 250, "#ff6b81"],
];
const LOGO_INK = "#1c1830";

/**
 * The Omniweave mark: the app icon's woven ring (assets/make_icon.py) on its ink tile, three threads each passing
 * over the next. Flat colours, no gradient, so the title bar (22 px), start screen and About match the taskbar icon.
 */
export function LogoMark({ size = 22 }: { size?: number }) {
  const r = 8.4;
  const w = size < 28 ? 4.4 : 3.8;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill={LOGO_INK} />
      {RING.map(([a, b, c]) => (
        <g key={c}>
          <path d={ringArc(a, b, r)} fill="none" stroke={LOGO_INK} strokeWidth={w + 1.6} strokeLinecap="round" />
          <path d={ringArc(a, b, r)} fill="none" stroke={c} strokeWidth={w} strokeLinecap="round" />
        </g>
      ))}
      {/* interlace: the violet thread's head passes back over the coral tail */}
      <path d={ringArc(-120, -100, r)} fill="none" stroke={LOGO_INK} strokeWidth={w + 1.6} strokeLinecap="round" />
      <path d={ringArc(-120, -90, r)} fill="none" stroke={RING[0][2]} strokeWidth={w} strokeLinecap="round" />
    </svg>
  );
}
