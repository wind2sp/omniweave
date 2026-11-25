// The phone shell's own icons: one set, drawn here on a 24 px grid — 1.75 px strokes, round ends and joins, 1.5–2 px
// corner radii, optical weight checked side by side. Format icons are one file outline with the kind drawn inside;
// the inside takes the kind's colour (a small mark, --m-k-*), the outline the text colour.
// No icon font and no glyphs of the system font (they differ phone to phone in weight and size).

/** path data (several sub-paths per icon); "dot" draws a filled 2 px point */
const P = {
  // shell
  home: "M4 10.5 12 4l8 6.5V18a2 2 0 0 1-2 2h-3.5v-5.5h-5V20H6a2 2 0 0 1-2-2z",
  files:
    "M7 3.5h6.5L18 8v10.5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2zM13.5 3.5V8H18",
  tools:
    "M14.7 6.3a4 4 0 0 0-5.4 5.1L4 16.7V20h3.3l5.3-5.3a4 4 0 0 0 5.1-5.4l-2.4 2.4-2.3-.6-.6-2.3z",
  settings: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
  open: "M3.5 7.5a2 2 0 0 1 2-2h4.2l1.8 2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z",
  scan: "M4 8.5V6a2 2 0 0 1 2-2h2.5M15.5 4H18a2 2 0 0 1 2 2v2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5M8.5 20H6a2 2 0 0 1-2-2v-2.5M4 12h16",
  desk: "M3.5 6a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2zM9 20h6M12 16v4",
  plus: "M12 5v14M5 12h14",
  back: "M14.5 5.5 8 12l6.5 6.5",
  next: "M9.5 5.5 16 12l-6.5 6.5",
  prev: "M14.5 5.5 8 12l6.5 6.5",
  up: "M5.5 14.5 12 8l6.5 6.5",
  eye: "M3 12s3.3-6 9-6 9 6 9 6-3.3 6-9 6-9-6-9-6zM12 14.75a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5z",
  eyeOff: "M3 12s3.3-6 9-6 9 6 9 6-3.3 6-9 6-9-6-9-6zM4.5 19.5l15-15",
  down: "M5.5 9.5 12 16l6.5-6.5",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  search: "M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM15.5 15.5 20 20",
  share:
    "M12 14.5v-11M8 7.5l4-4 4 4M5 11.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6.5",
  save: "M12 3.5v11M7.5 10 12 14.5 16.5 10M5 19.5h14",
  edit: "M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3zM13.5 8.5l3 3",
  more: "dot:6,12 dot:12,12 dot:18,12",
  convert: "M5 8.5h13M15 5l3.5 3.5L15 12M19 15.5H6M9 12l-3.5 3.5L9 19",
  undo: "M9 6.5 4.5 11 9 15.5M4.5 11H15a4.5 4.5 0 0 1 0 9h-3",
  redo: "M15 6.5l4.5 4.5-4.5 4.5M19.5 11H9a4.5 4.5 0 0 0 0 9h3",
  check: "M5 12.5 10 17.5 19 7",
  lock: "M8 10.5V8a4 4 0 0 1 8 0v2.5M6.5 10.5h11A1.5 1.5 0 0 1 19 12v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5V12a1.5 1.5 0 0 1 1.5-1.5z",
  unlock:
    "M8 10.5V8a4 4 0 0 1 7.7-1.5M6.5 10.5h11A1.5 1.5 0 0 1 19 12v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5V12a1.5 1.5 0 0 1 1.5-1.5z",
  device:
    "M8 3.5h8A1.5 1.5 0 0 1 17.5 5v14a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 19V5A1.5 1.5 0 0 1 8 3.5zM11 17.5h2",
  alert: "M12 4.5 20.5 19h-17zM12 10v4dot:12,16.5",
  page: "M7 3.5h6.5L18 8v10.5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2zM13.5 3.5V8H18M8.5 12h7M8.5 15.5h5",
  read: "M4 5.5h5a3 3 0 0 1 3 3V20a2.5 2.5 0 0 0-2.5-2.5H4zM20 5.5h-5a3 3 0 0 0-3 3V20a2.5 2.5 0 0 1 2.5-2.5H20z",
  compare:
    "M12 3.5v17M6 5.5h12A1.5 1.5 0 0 1 19.5 7v10a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 17V7A1.5 1.5 0 0 1 6 5.5z",
  grid: "M5 4.5h4.5A.5.5 0 0 1 10 5v4.5a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5zM14.5 4.5H19a.5.5 0 0 1 .5.5v4.5a.5.5 0 0 1-.5.5h-4.5a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5zM5 14h4.5a.5.5 0 0 1 .5.5V19a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5v-4.5A.5.5 0 0 1 5 14zM14.5 14H19a.5.5 0 0 1 .5.5V19a.5.5 0 0 1-.5.5h-4.5a.5.5 0 0 1-.5-.5v-4.5a.5.5 0 0 1 .5-.5z",
  menu: "M4 7h16M4 12h16M4 17h16",
  play: "M8 5.5v13l10-6.5z",
  // quick tools
  merge:
    "M5.5 4h6A1.5 1.5 0 0 1 13 5.5v6a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 4 11.5v-6A1.5 1.5 0 0 1 5.5 4zM13 11h5.5a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-6a1.5 1.5 0 0 1-1.5-1.5V13",
  compress: "M9.5 4v5.5H4M14.5 20v-5.5H20M4.5 4.5l5 5M19.5 19.5l-5-5",
  toImage:
    "M5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13A1.5 1.5 0 0 1 5.5 4zM4 16l4.5-4.5 4 4 2.5-2.5 5 5dot:15.5,8.5",
  toPdf:
    "M8.5 4h10A1.5 1.5 0 0 1 20 5.5v10M5.5 8h10A1.5 1.5 0 0 1 17 9.5v9a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 4 18.5v-9A1.5 1.5 0 0 1 5.5 8zM4 17l3.5-3.5 3 3 2-2 4.5 4.5",
  shrink:
    "M5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13A1.5 1.5 0 0 1 5.5 4zM9 9l6 6M15 10.5V15h-4.5",
  // viewer / markup
  mark: "M9 15 15.5 8.5 18 11l-6.5 6.5H9zM14 10l2.5 2.5M5 20h14",
  sign: "M3.5 16.5c2.5 0 3.5-9 6.5-9 2 0 .5 7.5 3.5 7.5 1.5 0 2.5-2.5 4-2.5 1 0 1.5 1 2.5 1M3.5 20h17",
  print:
    "M7 9V4h10v5M7 16H5.5A1.5 1.5 0 0 1 4 14.5v-4A1.5 1.5 0 0 1 5.5 9h13a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5H17M7 13.5h10V20H7z",
  pages:
    "M9 3.5h8.5A1.5 1.5 0 0 1 19 5v11a1.5 1.5 0 0 1-1.5 1.5H9A1.5 1.5 0 0 1 7.5 16V5A1.5 1.5 0 0 1 9 3.5zM7.5 7H6a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 6 21h8.5a1.5 1.5 0 0 0 1.5-1.5v-2",
  ocr: "M4 8.5V6a2 2 0 0 1 2-2h2.5M15.5 4H18a2 2 0 0 1 2 2v2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5M8.5 20H6a2 2 0 0 1-2-2v-2.5M8.5 9h7M12 9v7",
  form: "M5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13A1.5 1.5 0 0 1 5.5 4zM8 12l3 3 5-6",
  comment:
    "M5.5 4.5h13A1.5 1.5 0 0 1 20 6v9a1.5 1.5 0 0 1-1.5 1.5H10L6 20v-3.5h-.5A1.5 1.5 0 0 1 4 15V6a1.5 1.5 0 0 1 1.5-1.5z",
  move: "M12 4v16M4 12h16M9.5 6.5 12 4l2.5 2.5M9.5 17.5 12 20l2.5-2.5M6.5 9.5 4 12l2.5 2.5M17.5 9.5 20 12l-2.5 2.5",
  // photo
  crop: "M7 3.5V17h13.5M3.5 7H17v13.5",
  rotate: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5V9H15",
  light:
    "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4",
  eraser: "M4.5 15.5 13 7l5 5-8.5 8.5H7zM10 20.5h10",
  cutout:
    "M12 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM5.5 20a6.5 6.5 0 0 1 13 0M3.5 6V3.5H6M18 3.5h2.5V6",
  contrast: "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 4v16",
  full: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
  // editor tools
  select: "M6 4l12 7-5.5 1.5L10 18z",
  pen: "M3.5 17c2.5-3 4.5-4.5 6.5-4.5 2.5 0 2.5 3.5 5 3.5 1.5 0 3-1 5.5-3.5",
  brush:
    "M18.5 4.5a2 2 0 0 1 0 3L11.5 14.5 9.5 12.5l7-7a2 2 0 0 1 2-1zM9 13c-2 0-3.5 1.5-3.5 3.5 0 1.5-.5 2.5-1.5 3 3 .5 6.5-.5 6.5-3.5",
  shapes:
    "M4 5.5A1.5 1.5 0 0 1 5.5 4h6A1.5 1.5 0 0 1 13 5.5v6a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 4 11.5zM15.5 11a4.5 4.5 0 1 1-4.5 4.5",
  rect: "M6.5 5.5h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z",
  ellipse: "M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14z",
  line: "M5.5 18.5l13-13",
  text: "M5 6.5V5h14v1.5M12 5v14M9 19h6",
  table:
    "M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM4 9.5h16M4 14.5h16M9.5 9.5V20",
  layers: "M12 4 3.5 8.5 12 13l8.5-4.5zM3.5 13 12 17.5 20.5 13",
  measure:
    "M4 15.5 15.5 4 20 8.5 8.5 20zM8 11.5l1.5 1.5M10.5 9l1.5 1.5M13 6.5l1.5 1.5",
  props: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
  // kinds of file: the outline, then what is drawn inside (coloured)
  fileBase:
    "M7 3.5h6.5L18 8v10.5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2zM13.5 3.5V8H18",
  "k:doc": "M8.5 11.5h7M8.5 14.5h7M8.5 17.5h4",
  "k:sheet": "M8.5 11h7v6.5h-7zM8.5 14.25h7M12 11v6.5",
  "k:slide": "M8.5 11h7v4.5h-7zM10.5 18h3",
  "k:pdf": "M9.5 18v-7h2a2 2 0 0 1 0 4h-2",
  "k:photo": "M8.5 17.5l2.5-3 2 2 1.25-1.5 1.75 2.5dot:14,11.5",
  "k:design": "M12 10.5l3 3.5-3 3.5-3-3.5zdot:12,14",
  "k:cad": "M8.5 18l3.5-7 3.5 7M9.8 15.5h4.4",
  "k:omw": "M15.2 12.6a3.2 3.2 0 1 0 .3 3.4M12 14.25h.01",
  "k:media": "M10 11v6l5-3z",
  "k:other": "M9 14h6",
} as const;

export type IconName = Exclude<keyof typeof P, `k:${string}` | "fileBase">;
export type Kind =
  | "doc"
  | "sheet"
  | "slide"
  | "pdf"
  | "photo"
  | "design"
  | "cad"
  | "omw"
  | "media"
  | "other";

/** sub-paths and filled points of one entry */
function parts(d: string) {
  const dots: [number, number][] = [];
  const path = d
    .replace(/dot:([\d.]+),([\d.]+)/g, (_, x, y) => (dots.push([+x, +y]), ""))
    .trim();
  return { path, dots };
}

export function Icon({
  name,
  className,
}: {
  name: IconName;
  className?: string;
}) {
  const { path, dots } = parts(P[name]);
  return (
    <svg
      className={"m-ic" + (className ? " " + className : "")}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {path && <path d={path} />}
      {dots.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={1.25} className="m-ic-dot" />
      ))}
    </svg>
  );
}

/** a file's kind from its name (the extension) — the same kinds the home screen lists */
export function kindOf(name: string): Kind {
  const ext = (name.toLowerCase().split(".").pop() ?? "").trim();
  if (
    [
      "docx",
      "doc",
      "hwpx",
      "hwp",
      "odt",
      "rtf",
      "txt",
      "md",
      "html",
      "htm",
    ].includes(ext)
  )
    return "doc";
  if (["xlsx", "xls", "csv", "ods", "tsv"].includes(ext)) return "sheet";
  if (["pptx", "ppt", "odp", "pps", "ppsx"].includes(ext)) return "slide";
  if (ext === "pdf") return "pdf";
  if (
    [
      "png",
      "jpg",
      "jpeg",
      "webp",
      "gif",
      "bmp",
      "tif",
      "tiff",
      "heic",
      "psd",
      "psb",
    ].includes(ext)
  )
    return "photo";
  if (["ai", "svg", "eps"].includes(ext)) return "design";
  if (["dxf", "dwg"].includes(ext)) return "cad";
  if (ext === "omw") return "omw";
  if (
    [
      "mp3",
      "wav",
      "ogg",
      "oga",
      "flac",
      "aac",
      "m4a",
      "opus",
      "mp4",
      "webm",
      "mov",
      "m4v",
    ].includes(ext)
  )
    return "media";
  return "other";
}

/** a file icon of its kind: outline in the text colour, the inside in the kind's colour */
export function KindIcon({
  kind,
  className,
}: {
  kind: Kind;
  className?: string;
}) {
  const inner = parts(P[`k:${kind}`]);
  return (
    <svg
      className={"m-ic m-kic m-k-" + kind + (className ? " " + className : "")}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d={P.fileBase} />
      <g className="m-kic-in">
        {inner.path && <path d={inner.path} />}
        {inner.dots.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={1.1} className="m-ic-dot" />
        ))}
      </g>
    </svg>
  );
}
