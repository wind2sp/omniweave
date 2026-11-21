// In-place editor of a PSD text layer (image mode): the text tool's click or a double-click on the layer opens it over
// the text; content, font size and colour are edited, Ctrl+Enter or a click elsewhere applies, Esc cancels.
// docs/design/PSD_TEXT.md.

import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { findPage, useStore } from "../../core/store";
import type { RasterNode } from "../../core/types";
import { useT } from "../../i18n";
import { rasterPixels } from "../../io/formats/psdWrite";
import { PSD_TEXT_SIZE, applyPsdText, psdTextFont, psdTextOrigin } from "./psdTextRender";

export const usePsdTextEdit = create<{ id: string | null; pageId: string | null }>(() => ({ id: null, pageId: null }));

export function startPsdTextEdit(pageId: string, n: RasterNode) {
  usePsdTextEdit.setState({ id: n.id, pageId });
  useStore.getState().set({ selection: [n.id], editingTextId: n.id });
}

export function endPsdTextEdit() {
  usePsdTextEdit.setState({ id: null, pageId: null });
  if (useStore.getState().editingTextId) useStore.getState().set({ editingTextId: null });
}

export function PsdTextEditor() {
  const { id, pageId } = usePsdTextEdit();
  const node = useStore((s) => (id && pageId ? findPage(s.doc, pageId)?.nodes.find((n) => n.id === id) : undefined));
  if (!id || !pageId || node?.type !== "RASTER" || !node.psdText) return null;
  return <Editor key={id} pageId={pageId} node={node} />;
}

const BAR_H = 34;

function Editor({ pageId, node }: { pageId: string; node: RasterNode }) {
  const tr = useT();
  const view = useStore((s) => s.view);
  const spec = node.psdText!;
  const [text, setText] = useState(spec.text);
  const [size, setSize] = useState(spec.size);
  const [color, setColor] = useState(spec.color);
  const area = useRef<HTMLTextAreaElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const done = useRef(false);

  useEffect(() => {
    // after the press that opened it has finished (its mousedown would move the focus away again)
    const id = setTimeout(() => {
      area.current?.focus();
      area.current?.select();
    }, 0);
    return () => clearTimeout(id);
  }, []);

  const finish = (apply: boolean) => {
    if (done.current) return;
    done.current = true;
    if (apply && size > 0) applyPsdText(pageId, node.id, { text, size, color });
    endPsdTextEdit();
  };

  // where the text is: the origin is the first baseline (left / centre / right point per alignment)
  const [ox, oy] = psdTextOrigin(node);
  const leading = spec.size > 0 ? (spec.leading * size) / spec.size : size * 1.2;
  const probe = document.createElement("canvas").getContext("2d")!;
  probe.font = psdTextFont(spec, size);
  const lines = text.split("\n");
  const textW = Math.max(size, ...lines.map((l) => probe.measureText(l).width)) + size * 0.6;
  const w = spec.box ? spec.box.w : textW;
  const leftPage = spec.box ? ox + spec.box.x : ox - (spec.align === "center" ? w / 2 : spec.align === "right" ? w : 0);
  const topPage = spec.box ? oy + spec.box.y : oy - size * 0.9 - Math.max(0, (leading - size * 1.15) / 2);
  const z = view.zoom;
  const sx = leftPage * z + view.panX, sy = topPage * z + view.panY;
  // the old text's painted box: covered while typing so the new text does not mix with it
  const [old] = useState(() => {
    try {
      return rasterPixels(node);
    } catch {
      return null;
    }
  });

  return (
    <div
      ref={wrap}
      className="psd-text-editor"
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={(e) => {
        if (!wrap.current?.contains(e.relatedTarget as Node | null)) finish(true);
      }}
      onKeyDown={(e) => {
        if (e.ctrlKey && e.key === "Tab") return;
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          finish(true);
        }
      }}
      style={{ position: "absolute", left: 0, top: 0, width: 0, height: 0, zIndex: 20 }}
    >
      {old && (
        <div
          aria-hidden
          style={{ position: "absolute", left: old.left * z + view.panX, top: old.top * z + view.panY, width: old.width * z, height: old.height * z, background: "rgba(255,255,255,0.88)", pointerEvents: "none" }}
        />
      )}
      <div
        role="toolbar"
        aria-label={tr("psdtext.bar")}
        style={{
          position: "absolute",
          left: Math.max(4, sx),
          top: Math.max(4, sy - BAR_H - 6),
          height: BAR_H,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 8px",
          whiteSpace: "nowrap",
          background: "var(--panel, #2b2d31)",
          color: "var(--text, #e8e8ea)",
          border: "1px solid var(--border, #444)",
          borderRadius: 6,
          boxShadow: "0 4px 14px rgba(0,0,0,.3)",
          fontSize: 12,
        }}
      >
        <span style={{ opacity: 0.8 }}>{tr("psdtext.title")}</span>
        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {tr("psdtext.size")}
          <input
            type="number"
            min={1}
            max={2000}
            step={0.5}
            value={Math.round(size * 100) / 100}
            aria-label={tr("psdtext.size")}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v > 0) setSize(Math.min(PSD_TEXT_SIZE.max, Math.max(PSD_TEXT_SIZE.min, v)));
            }}
            style={{ width: 64 }}
          />
          px
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {tr("psdtext.color")}
          <input type="color" value={color} aria-label={tr("psdtext.color")} onChange={(e) => setColor(e.target.value)} style={{ width: 32, height: 22, padding: 0, border: "none", background: "none" }} />
        </label>
        <button type="button" onClick={() => finish(true)} title={tr("psdtext.applyHint")}>
          {tr("psdtext.apply")}
        </button>
        <button type="button" onClick={() => finish(false)} title="Esc">
          {tr("psdtext.cancel")}
        </button>
      </div>
      <textarea
        ref={area}
        value={text}
        spellCheck={false}
        aria-label={tr("psdtext.textLabel", { name: node.name })}
        onChange={(e) => setText(e.target.value)}
        wrap={spec.box ? "soft" : "off"}
        style={{
          position: "absolute",
          // CSS zoom: the text is drawn at its real size on the page, as in the cell editor
          zoom: z,
          left: sx / z,
          top: sy / z,
          width: w + 8,
          height: Math.max(leading * lines.length, spec.box?.h ?? 0) + size * 0.4,
          margin: 0,
          padding: "0 2px",
          border: "1px dashed var(--accent, #4f7cff)",
          outline: "none",
          resize: "none",
          overflow: "hidden",
          background: "rgba(255,255,255,0.88)",
          color,
          font: psdTextFont(spec, size),
          lineHeight: `${leading}px`,
          textAlign: spec.align,
          caretColor: color,
        }}
      />
    </div>
  );
}
