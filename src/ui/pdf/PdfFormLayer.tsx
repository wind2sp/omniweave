// PDF form filling on the canvas (docs/design/PDF_ACROBAT_DAILY.md §2.3), like Acrobat's "Fill & Sign":
// every field of the current PDF page gets a light highlight; clicking a text field opens an input right over it,
// check boxes and radio buttons toggle on click, combo / list boxes open their choices. Tab moves to the next field.
// Values are stored on the page's PdfNode (`form`, undoable, saved in .omw); the page is drawn, exported and saved
// "in the original format" filled with them (io/pdf.ts pdfViewHash / saveSameTypePdf → io/pdfsurgeon/forms.ts).
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { applyTransform } from "../../core/geom";
import { draftPage, findPage, useStore } from "../../core/store";
import type { PdfNode } from "../../core/types";
import { t as tr, useT } from "../../i18n";
import { fileFormValues, pdfFormInfo, widgetRectOnNode, type PdfFormInfo } from "../../io/pdf";
import type { FormField, FormValue } from "../../io/pdfsurgeon/forms";
import { Icon } from "../shell/Icons";
import { usePdfAnnot } from "./PdfAnnotLayer";
import "./pdfForm.css";

/** "Fill form" on (default) or off (the page's fields are then left alone, e.g. to select or elevate) */
export const usePdfForm = create<{ off: boolean }>(() => ({ off: false }));

function usePageForm() {
  const page = useStore((s) => findPage(s.doc, s.pageId));
  const node = page?.nodes.find((n): n is PdfNode => n.type === "PDF");
  const hash = useStore((s) => (node ? s.doc.assets[node.assetId]?.hash : undefined));
  const [info, setInfo] = useState<PdfFormInfo | null>(null);
  useEffect(() => {
    let live = true;
    setInfo(null);
    if (hash) void pdfFormInfo(hash).then((i) => live && setInfo(i));
    return () => {
      live = false;
    };
  }, [hash]);
  return { page, node, info };
}

const NO_VALUES: Record<string, FormValue> = {};
const same = (a: FormValue | undefined, b: FormValue | undefined) => JSON.stringify(a) === JSON.stringify(b);

function setFormValue(pageId: string, nodeId: string, hash: string, name: string, v: FormValue, was: FormValue) {
  if (same(v, was)) return;
  useStore.getState().commit(tr("pdf.form.hist"), (d) => {
    // one value per field for the whole file: other pages of the same file drop their older one
    for (const p of d.pages)
      for (const x of p.nodes)
        if (x.type === "PDF" && x.id !== nodeId && x.form && name in x.form && d.assets[x.assetId]?.hash === hash) {
          const rest = { ...x.form };
          delete rest[name];
          x.form = rest;
        }
    const n = draftPage(d, pageId)?.nodes.find((x) => x.id === nodeId) as PdfNode | undefined;
    if (n) n.form = { ...(n.form ?? {}), [name]: v };
  });
}

/** Ribbon toggle for the PDF page strip; nothing when the page's file has no form. */
export function PdfFormBtn() {
  const t = useT();
  const { info } = usePageForm();
  const off = usePdfForm((s) => s.off);
  if (!info) return null;
  if (info.xfa)
    return (
      <button type="button" className="btn btn-ghost" disabled data-tip={t("pdf.form.xfaTip")}>
        <Icon name="textBox" size={14} />
        <span>{t("pdf.form.fill")}</span>
      </button>
    );
  return (
    <button type="button" className={"btn btn-ghost" + (off ? "" : " on")} aria-pressed={!off} data-tip={t("pdf.form.fillTip")} onClick={() => usePdfForm.setState({ off: !off })}>
      <Icon name="textBox" size={14} />
      <span>{t("pdf.form.fill")}</span>
    </button>
  );
}

interface Spot {
  field: FormField;
  wi: number;
  /** screen px inside the canvas wrapper */
  x: number;
  y: number;
  w: number;
  h: number;
  /** page px → screen px */
  k: number;
}

/** The fields of the current PDF page over the canvas (CanvasView). */
export function PdfFormLayer() {
  const { page, node, info } = usePageForm();
  const view = useStore((s) => s.view);
  const tool = useStore((s) => s.tool);
  const formOff = usePdfForm((s) => s.off);
  const annotOn = usePdfAnnot((s) => s.tool !== null);
  const off = formOff || annotOn; // a comment tool in use: the fields step aside
  const [active, setActive] = useState<string | null>(null);
  const hash = useStore((s) => (node ? s.doc.assets[node.assetId]?.hash : undefined));
  const values = useStore((s) => (hash ? fileFormValues(s.doc, hash) : NO_VALUES));
  useT();
  // another page: nothing stays open
  useEffect(() => setActive(null), [page?.id]);
  // Tab onto a check box / radio button: the keyboard follows (it has no editor of its own)
  useEffect(() => {
    if (active) (document.querySelector(`.pdf-field[data-key="${CSS.escape(active)}"]`) as HTMLElement | null)?.focus();
  }, [active]);
  if (!info || info.xfa || off || !page || !node || !node.visible || tool !== "select") return null;

  const spots: Spot[] = [];
  for (const f of info.fields)
    f.widgets.forEach((w, wi) => {
      if (w.page !== node.pageIndex || f.kind === "button" || f.kind === "signature") return;
      const [lx, ly, lw, lh] = widgetRectOnNode(info, w.page, w.rect);
      if (lw < 1 || lh < 1) return;
      const cs = [
        [lx, ly],
        [lx + lw, ly],
        [lx + lw, ly + lh],
        [lx, ly + lh],
      ].map((p) => applyTransform(node.transform, p as [number, number]));
      const xs = cs.map((p) => p[0] * view.zoom + view.panX), ys = cs.map((p) => p[1] * view.zoom + view.panY);
      const x = Math.min(...xs), y = Math.min(...ys);
      spots.push({ field: f, wi, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, k: view.zoom * (node.transform.scale || 1) });
    });
  const keyOf = (s: Spot) => `${s.field.name}#${s.wi}`;
  // typed values of the whole file (a field may have widgets on several pages)
  const valueOf = (f: FormField): FormValue => (f.name in values ? values[f.name] : f.value);
  const commit = (f: FormField, v: FormValue) => setFormValue(page.id, node.id, hash!, f.name, v, valueOf(f));
  const editable = spots.filter((s) => !s.field.readOnly);
  const move = (from: Spot, dir: 1 | -1) => {
    const i = editable.findIndex((s) => keyOf(s) === keyOf(from));
    const next = editable[(i + dir + editable.length) % editable.length];
    setActive(next ? keyOf(next) : null);
  };

  return (
    <div className="pdf-form-layer">
      {spots.map((s) => {
        const f = s.field;
        const key = keyOf(s);
        const v = valueOf(f);
        const box = { left: s.x, top: s.y, width: s.w, height: s.h };
        if (f.readOnly) return <div key={key} className="pdf-field ro" style={box} />;
        if (active === key && (f.kind === "text" || f.kind === "combo" || f.kind === "list"))
          return <FieldEditor key={key} spot={s} value={v} onCommit={(nv) => commit(f, nv)} onDone={() => setActive(null)} onMove={(dir) => move(s, dir)} />;
        const toggle = () => {
          // an editor open on another field closes (and keeps what was typed in it)
          if (active && active !== key) setActive(null);
          if (f.kind === "check") commit(f, !v);
          else if (f.kind === "radio") commit(f, f.widgets[s.wi].onState ?? "");
          else setActive(key);
        };
        return (
          <div
            key={key}
            className={"pdf-field" + (f.kind === "check" || f.kind === "radio" ? " btnlike" : "")}
            style={box}
            role={f.kind === "check" ? "checkbox" : f.kind === "radio" ? "radio" : "textbox"}
            aria-label={f.name}
            aria-checked={f.kind === "check" ? !!v : f.kind === "radio" ? v === f.widgets[s.wi].onState : undefined}
            tabIndex={0}
            data-key={key}
            data-tip={f.name}
            onPointerDown={(e) => {
              // only the main button fills; middle / right buttons still pan and open menus on the canvas
              if (e.button !== 0) return;
              e.stopPropagation();
              e.preventDefault();
              toggle();
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Tab") {
                e.preventDefault();
                move(s, e.shiftKey ? -1 : 1);
              } else if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                toggle();
              }
            }}
          />
        );
      })}
    </div>
  );
}

function FieldEditor({ spot, value, onCommit, onDone, onMove }: { spot: Spot; value: FormValue; onCommit: (v: FormValue) => void; onDone: () => void; onMove: (dir: 1 | -1) => void }) {
  const f = spot.field;
  const [text, setText] = useState(typeof value === "string" ? value : Array.isArray(value) ? value.join("\n") : "");
  const [picked, setPicked] = useState<string[]>(Array.isArray(value) ? value : typeof value === "string" && value ? [value] : []);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement>(null);
  const cancelled = useRef(false);
  const done = useRef(false);
  const commitNow = () => {
    if (f.kind === "text") onCommit(text);
    else if (f.kind === "list") onCommit(picked);
    else onCommit(picked[0] ?? "");
  };
  // closed without a blur (another field clicked, page or tool changed): what was typed is still kept
  const latest = useRef(commitNow);
  latest.current = commitNow;
  useEffect(() => {
    // (React StrictMode runs this twice: the first cleanup must not leave the editor marked finished)
    done.current = false;
    ref.current?.focus();
    if (f.kind === "text") ref.current?.select();
    return () => {
      if (!done.current && !cancelled.current) {
        done.current = true;
        latest.current();
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const finish = (dir?: 1 | -1) => {
    if (done.current) return;
    done.current = true;
    if (!cancelled.current) commitNow();
    if (dir) onMove(dir);
    else onDone();
  };
  const keys = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      cancelled.current = true;
      finish();
    } else if (e.key === "Tab") {
      e.preventDefault();
      finish(e.shiftKey ? -1 : 1);
    } else if (e.key === "Enter" && !(f.kind === "text" && f.multiline) && !e.altKey) {
      e.preventDefault();
      finish(1);
    }
  };
  const style = { left: spot.x, top: spot.y, width: spot.w, height: spot.h };
  // the text size Acrobat would draw: fit a single line to the box (at most 12 pt), 12 pt for multi-line boxes
  const pt = (96 / 72) * spot.k;
  const fontSize = f.multiline ? 12 * pt : Math.max(9, Math.min(12 * pt, spot.h * 0.62));
  const common = {
    ref,
    className: "pdf-field-edit",
    style: { ...style, fontSize },
    onBlur: () => finish(),
    onKeyDown: keys,
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    "aria-label": f.name,
  };
  if (f.kind === "text")
    return f.multiline ? (
      <textarea {...common} value={text} maxLength={f.maxLen} onChange={(e) => setText(e.target.value)} />
    ) : (
      <input {...common} value={text} maxLength={f.maxLen} onChange={(e) => setText(e.target.value)} />
    );
  const opts = f.options ?? [];
  const exp = f.exportValues ?? opts;
  return (
    <select
      {...common}
      multiple={f.kind === "list"}
      size={f.kind === "list" ? Math.max(2, Math.min(opts.length, 8)) : undefined}
      value={f.kind === "list" ? picked : (picked[0] ?? "")}
      onChange={(e) => {
        const v = [...e.target.selectedOptions].map((o) => o.value);
        // a combo box takes the choice at once (Acrobat); a list box keeps adding until Tab / Enter / leaving
        if (f.kind === "combo") {
          done.current = true;
          onCommit(v[0] ?? "");
          onDone();
          return;
        }
        setPicked(v);
      }}
    >
      {f.kind === "combo" && <option value="" />}
      {opts.map((o, i) => (
        <option key={i} value={exp[i]}>
          {o}
        </option>
      ))}
    </select>
  );
}
