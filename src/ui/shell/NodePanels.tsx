// Properties panels for TABLE and MEDIA nodes (shown in the right dock).

import { useEffect, useMemo, useRef, useState } from "react";
import { getBlob, makeAsset } from "../../core/assets";
import { useStore } from "../../core/store";
import type { Align, MediaNode, TableCell, TableNode } from "../../core/types";
import { grabFrame, mediaUrl } from "../../io/formats/media";
import { addNode, updateNodes } from "../actions";
import { useCellSel } from "../CellEditor";
import { mergeSelectedCells, splitSelectedCell } from "../pageSetupActions";
import { ColorField, Field, NumField, Section, Seg } from "./controls";
import { Icon } from "./Icons";
import { nodeLive } from "./ops";
import { newImage } from "../../core/types";
import { useT } from "../../i18n";

const S = () => useStore.getState();

function editTable(n: TableNode, label: string, fn: (t: TableNode) => void) {
  updateNodes([n.id], label, (t: TableNode) => fn(t));
}

const blankRow = (cols: number): TableCell[] => Array.from({ length: cols }, () => ({ text: "" }));

export function TablePanel({ node }: { node: TableNode }) {
  const tr = useT();
  const sel = useCellSel((s) => s.target);
  const end = useCellSel((s) => s.end);
  const cur = sel && sel.nodeId === node.id && sel.row < node.rows.length && sel.col < node.colWidths.length ? sel : null;
  const other = cur && end && end.row < node.rows.length && end.col < node.colWidths.length ? end : cur;
  const range = cur && other ? { r0: Math.min(cur.row, other.row), c0: Math.min(cur.col, other.col), r1: Math.max(cur.row, other.row), c1: Math.max(cur.col, other.col) } : null;
  const cols = node.colWidths.length;
  const r = cur?.row ?? node.rows.length - 1;
  const c = cur?.col ?? cols - 1;
  const cell = node.rows[r]?.[c];
  const setSel = (row: number, col: number) => useCellSel.setState({ target: { nodeId: node.id, row, col } });
  return (
    <>
      <Section title={tr("dock.table.title", { rows: node.rows.length, cols })}>
        <p className="muted-note">{cur ? tr("dock.table.selCell", { r: r + 1, c: c + 1 }) : tr("dock.table.hint")}</p>
        <div className="media-row">
          <button type="button" className="chip" onClick={() => editTable(node, tr("dock.table.insertRow"), (t) => void t.rows.splice(r, 0, blankRow(cols)))}>
            {tr("dock.table.rowAbove")}
          </button>
          <button type="button" className="chip" onClick={() => (editTable(node, tr("dock.table.insertRow"), (t) => void t.rows.splice(r + 1, 0, blankRow(cols))), setSel(r + 1, c))}>
            {tr("dock.table.rowBelow")}
          </button>
          <button type="button" className="chip" disabled={node.rows.length <= 1} onClick={() => (editTable(node, tr("dock.table.deleteRow"), (t) => void t.rows.splice(r, 1)), setSel(Math.max(0, r - 1), c))}>
            {tr("dock.table.deleteRow")}
          </button>
        </div>
        <div className="media-row">
          <button type="button" className="chip" onClick={() => editTable(node, tr("dock.table.insertCol"), (t) => (t.rows.forEach((row) => row.splice(c, 0, { text: "" })), t.colWidths.splice(c, 0, t.colWidths[c] ?? 100)))}>
            {tr("dock.table.colLeft")}
          </button>
          <button type="button" className="chip" onClick={() => (editTable(node, tr("dock.table.insertCol"), (t) => (t.rows.forEach((row) => row.splice(c + 1, 0, { text: "" })), t.colWidths.splice(c + 1, 0, t.colWidths[c] ?? 100))), setSel(r, c + 1))}>
            {tr("dock.table.colRight")}
          </button>
          <button type="button" className="chip" disabled={cols <= 1} onClick={() => (editTable(node, tr("dock.table.deleteCol"), (t) => (t.rows.forEach((row) => row.splice(c, 1)), t.colWidths.splice(c, 1))), setSel(r, Math.max(0, c - 1)))}>
            {tr("dock.table.deleteCol")}
          </button>
        </div>
        <Field label={tr("dock.table.colWidth")}>
          <NumField label="W" tip={tr("dock.table.colWidthTip", { c: c + 1 })} value={node.colWidths[c]} min={16} max={2000} unit="px" width={0} live={nodeLive<number>(tr("dock.table.colWidth"), (t, v) => (t.colWidths[c] = v), [node.id])} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={node.headerRow} onChange={(e) => editTable(node, tr("dock.table.headerRow"), (t) => void (t.headerRow = e.target.checked))} />
          <span>{tr("dock.table.firstRowHeader")}</span>
        </label>
        {/* 셀 합치기 / 셀 나누기: the clicked cell and the cell Shift+clicked after it */}
        <div className="media-row">
          <button type="button" className="chip" disabled={!range || (range.r0 === range.r1 && range.c0 === range.c1)} onClick={mergeSelectedCells}>
            {tr("cmd.table.merge")}
          </button>
          <button type="button" className="chip" disabled={!cur} onClick={splitSelectedCell}>
            {tr("cmd.table.split")}
          </button>
        </div>
        <p className="muted-note">{range && (range.r0 !== range.r1 || range.c0 !== range.c1) ? tr("table.range", { r0: range.r0 + 1, c0: range.c0 + 1, r1: range.r1 + 1, c1: range.c1 + 1 }) : tr("table.rangeHint")}</p>
      </Section>
      {cell && (
        <Section title={tr("dock.table.cellFormat")}>
          <div className="media-row">
            <button type="button" className={"chip" + (cell.bold ? " on" : "")} onClick={() => editTable(node, tr("dock.table.cellBold"), (t) => void (t.rows[r][c] = { ...t.rows[r][c], bold: !cell.bold || undefined }))}>
              <Icon name="bold" size={12} /> {tr("dock.table.bold")}
            </button>
            <Seg<Align>
              value={cell.align ?? "LEFT"}
              onChange={(v) => editTable(node, tr("dock.table.cellAlign"), (t) => void (t.rows[r][c] = { ...t.rows[r][c], align: v === "LEFT" ? undefined : v }))}
              options={[
                { value: "LEFT", label: tr("dock.table.left") },
                { value: "CENTER", label: tr("dock.table.center") },
                { value: "RIGHT", label: tr("dock.table.right") },
              ]}
            />
          </div>
          <Field label={tr("dock.table.cellBg")}>
            <ColorField value={cell.fill ?? null} showHex live={nodeLive<string>(tr("dock.table.cellBg"), (t, v) => (t.rows[r][c] = { ...t.rows[r][c], fill: v }), [node.id])} onNone={() => editTable(node, tr("dock.table.cellNoBg"), (t) => void (t.rows[r][c] = { ...t.rows[r][c], fill: undefined }))} />
          </Field>
          {cell.formula && <p className="muted-note">{tr("dock.table.formula", { formula: cell.formula })}</p>}
        </Section>
      )}
      <Section title={tr("dock.table.look")}>
        <div className="grid2">
          <NumField label={tr("dock.table.font")} tip={tr("dock.table.fontSizeTip")} value={node.fontSize} min={6} max={96} unit="px" width={0} live={nodeLive<number>(tr("dock.table.fontSize"), (t, v) => (t.fontSize = v), [node.id])} />
          <NumField label={tr("dock.table.row")} tip={tr("dock.table.minRowHeight")} value={node.rowHeight} min={12} max={400} unit="px" width={0} live={nodeLive<number>(tr("dock.table.rowHeight"), (t, v) => (t.rowHeight = v), [node.id])} />
        </div>
        <Field label={tr("dock.table.textColor")}>
          <ColorField value={node.color} showHex live={nodeLive<string>(tr("dock.table.textColorHist"), (t, v) => (t.color = v), [node.id])} />
        </Field>
        <Field label={tr("dock.table.border")}>
          <ColorField value={node.borderColor} showHex live={nodeLive<string>(tr("dock.table.borderHist"), (t, v) => (t.borderColor = v), [node.id])} />
        </Field>
        <Field label={tr("dock.table.header")}>
          <ColorField value={node.headerFill} showHex live={nodeLive<string>(tr("dock.table.headerBg"), (t, v) => (t.headerFill = v), [node.id])} />
        </Field>
        <Field label={tr("dock.background")}>
          <ColorField value={node.background} showHex live={nodeLive<string>(tr("dock.table.bg"), (t, v) => (t.background = v), [node.id])} onNone={() => editTable(node, tr("dock.table.noBg"), (t) => void (t.background = null))} />
        </Field>
      </Section>
    </>
  );
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

export function MediaPanel({ node }: { node: MediaNode }) {
  const asset = useStore((s) => s.doc.assets[node.assetId]);
  const url = useMemo(() => {
    const b = asset && getBlob(asset.hash);
    return b ? mediaUrl(b, asset.mime) : null;
  }, [asset]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [t, setT] = useState(0);
  const tr = useT();
  const set = (label: string, fn: (m: MediaNode) => void) => updateNodes([node.id], label, fn);
  const end = node.trimEnd ?? node.duration;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.muted = node.muted;
    el.loop = false;
    const onTime = () => {
      setT(el.currentTime);
      if (node.trimEnd !== null && el.currentTime >= node.trimEnd) {
        if (node.loop) el.currentTime = node.trimStart;
        else el.pause();
      }
    };
    const onPlay = () => {
      if (el.currentTime < node.trimStart || (node.trimEnd !== null && el.currentTime >= node.trimEnd - 0.05)) el.currentTime = node.trimStart;
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("play", onPlay);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("play", onPlay);
    };
  }, [node.muted, node.trimStart, node.trimEnd, node.loop, url]);

  const capture = async (asPoster: boolean) => {
    const el = ref.current;
    if (!el) return;
    const png = await grabFrame(el);
    if (!png) return S().notify(tr("dock.media.readFail"));
    const a = makeAsset(png, "image/png", `${node.name} ${fmt(el.currentTime)}.png`);
    if (asPoster) {
      S().commit(tr("dock.media.poster"), (d) => {
        d.assets[a.id] = a;
        const pg = d.pages.find((p) => p.id === S().pageId) ?? d.masters.find((p) => p.id === S().pageId);
        const m = pg?.nodes.find((x) => x.id === node.id) as MediaNode | undefined;
        if (m) m.posterAssetId = a.id;
      });
    } else {
      const img = newImage(a.id, node.width, node.height, tr("dock.media.frameName", { name: node.name, time: fmt(el.currentTime) }));
      img.transform = { ...node.transform, x: node.transform.x + 24, y: node.transform.y + 24 };
      addNode(img, { [a.id]: a });
      S().notify(tr("dock.media.inserted"));
    }
  };

  return (
    <Section title={node.media === "video" ? tr("dock.media.video") : tr("dock.media.audio")}>
      {url ? (
        node.media === "video" ? (
          <video ref={ref} className="media-preview" src={url} controls preload="metadata" />
        ) : (
          <audio ref={ref} className="media-preview audio" src={url} controls preload="metadata" />
        )
      ) : (
        <p className="muted-note">{tr("dock.media.missing")}</p>
      )}
      <dl className="info-list">
        <dt>{tr("dock.media.duration")}</dt>
        <dd>{node.duration ? fmt(node.duration) : tr("dock.media.unknown")}</dd>
        <dt>{tr("dock.media.range")}</dt>
        <dd>
          {fmt(node.trimStart)} – {fmt(end)}
        </dd>
        <dt>{tr("dock.media.file")}</dt>
        <dd>{asset ? `${asset.mime} · ${(asset.size / 1048576).toFixed(1)}MB` : "-"}</dd>
      </dl>
      <div className="media-row">
        <button type="button" className="chip" disabled={!url} onClick={() => set(tr("dock.media.startPoint"), (m) => void (m.trimStart = Math.min(t, (m.trimEnd ?? m.duration) || t)))}>
          {tr("dock.media.setStart", { time: fmt(t) })}
        </button>
        <button type="button" className="chip" disabled={!url} onClick={() => set(tr("dock.media.endPoint"), (m) => void (m.trimEnd = Math.max(t, m.trimStart)))}>
          {tr("dock.media.setEnd", { time: fmt(t) })}
        </button>
        <button type="button" className="chip" disabled={node.trimStart === 0 && node.trimEnd === null} onClick={() => set(tr("dock.media.resetRange"), (m) => ((m.trimStart = 0), (m.trimEnd = null)))}>
          {tr("dock.media.resetRange")}
        </button>
      </div>
      <div className="grid2">
        <NumField label={tr("dock.media.start")} tip={tr("dock.media.startTip")} value={node.trimStart} min={0} max={node.duration || 36000} step={0.1} precision={1} unit="s" width={0} live={nodeLive<number>(tr("dock.media.startPoint"), (m, v) => (m.trimStart = v), [node.id])} />
        <NumField label={tr("dock.media.end")} tip={tr("dock.media.endTip")} value={end} min={0} max={node.duration || 36000} step={0.1} precision={1} unit="s" width={0} live={nodeLive<number>(tr("dock.media.endPoint"), (m, v) => (m.trimEnd = v), [node.id])} />
      </div>
      <div className="check-row">
        <label className="check">
          <input type="checkbox" checked={node.muted} onChange={(e) => set(tr("dock.media.mute"), (m) => void (m.muted = e.target.checked))} />
          <span>{tr("dock.media.mute")}</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={node.loop} onChange={(e) => set(tr("dock.media.loop"), (m) => void (m.loop = e.target.checked))} />
          <span>{tr("dock.media.loop")}</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={node.autoplay} onChange={(e) => set(tr("dock.media.autoplay"), (m) => void (m.autoplay = e.target.checked))} />
          <span>{tr("dock.media.autoplaySlideshow")}</span>
        </label>
      </div>
      {node.media === "video" && (
        <div className="media-row">
          <button type="button" className="btn btn-ghost" disabled={!url} onClick={() => void capture(false)}>
            <Icon name="camera" size={14} />
            <span>{tr("dock.media.frameToImage")}</span>
          </button>
          <button type="button" className="btn btn-ghost" disabled={!url} onClick={() => void capture(true)}>
            <Icon name="image" size={14} />
            <span>{tr("dock.media.setPoster")}</span>
          </button>
        </div>
      )}
      <div className="grid2">
        <NumField label="W" tip={tr("dock.width")} value={node.width} min={8} precision={1} unit="px" width={0} live={nodeLive<number>(tr("dock.media.size"), (m, v) => (m.width = v), [node.id])} />
        <NumField label="H" tip={tr("dock.height")} value={node.height} min={8} precision={1} unit="px" width={0} live={nodeLive<number>(tr("dock.media.size"), (m, v) => (m.height = v), [node.id])} />
      </div>
    </Section>
  );
}
