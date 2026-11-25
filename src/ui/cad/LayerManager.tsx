// The left panel of a drawing page: AutoCAD's Layer Properties Manager (docs/qa/ISSUES-2026-11-19.md item 1). One row
// per drawing layer (current, name, on, freeze, lock, colour, linetype, lineweight, transparency, plot) and one per
// AutoCAD GROUP; entities are picked on the canvas or with QSELECT, never listed. Loaded with the drawing screen.

import { useRef, useState } from "react";
import { useQs } from "./moreEdit";
import { findPage, useStore } from "../../core/store";
import type { Page } from "../../core/types";
import { t as tr, useT } from "../../i18n";
import { IconBtn, Menu, cx } from "../shell/controls";
import { Icon } from "../shell/Icons";
import { useClayer } from "./engine";
import {
  ACI, LWS, applyQselect, loadedLtypes, cadPanelModel, deleteLayer, makeCurrent, newLayer, qselectOptions, renameLayer, setLayerColor, setLayerFrozen, setLayerLocked, setLayerLtype, setLayerLw,
  setLayerOn, setLayerPlot, setLayerTransparency, type CadLayerRow,
} from "./layers";

const S = () => useStore.getState();
const say = (err: string | null) => err && S().notify(tr(err));

function ColorCell({ page, row }: { page: Page; row: CadLayerRow }) {
  const t = useT();
  const pick = useRef<HTMLInputElement>(null);
  const aci = ACI.find((c) => c.hex === row.color.toLowerCase());
  return (
    <>
      <Menu
        className="cad-li cad-swatch-btn"
        tip={`${t("cadlm.col.color")}: ${aci ? `${t("cadui.color.index")} ${aci.name}` : row.color}`}
        button={<span className="cad-swatch" style={{ background: row.color }} />}
        items={() => [
          ...ACI.map((c) => ({ label: `${t("cadui.color.index")} ${c.name}`, checked: c.hex === row.color.toLowerCase(), onSelect: () => setLayerColor(page, row.id, c.hex) })),
          { sep: true },
          { label: t("cadlm.trueColor"), checked: !aci, onSelect: () => pick.current?.click() },
        ]}
      />
      <input ref={pick} type="color" className="cad-lm-color-in" tabIndex={-1} aria-hidden value={row.color} onChange={(e) => setLayerColor(page, row.id, e.target.value)} />
    </>
  );
}

function NameCell({ page, row, editing, onDone }: { page: Page; row: CadLayerRow; editing: boolean; onDone: () => void }) {
  const [v, setV] = useState(row.name);
  if (!editing) return <span className="cad-lm-name" data-tip={row.name}>{row.name}</span>;
  const commit = () => {
    say(renameLayer(page, row.id, v));
    onDone();
  };
  return (
    <input
      className="cad-lm-name-in"
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onDone();
      }}
    />
  );
}

function QSelect({ page, onClose }: { page: Page; onClose: () => void }) {
  const t = useT();
  const o = qselectOptions(page);
  const [kind, setKind] = useState("");
  const [layer, setLayer] = useState("");
  const [color, setColor] = useState("");
  const [add, setAdd] = useState(false);
  const run = () => {
    const n = applyQselect(page, { kind: kind || undefined, layer: layer || undefined, color: color || undefined }, add);
    S().notify(t("cadlm.qs.done", { n }));
  };
  const sel = (label: string, value: string, set: (v: string) => void, opts: string[]) => (
    <label className="cad-lm-qs-row">
      <span>{label}</span>
      <select value={value} onChange={(e) => set(e.target.value)}>
        <option value="">{t("cadlm.qs.any")}</option>
        {opts.map((x) => (
          <option key={x} value={x}>
            {x === "TEXT" ? t("cadui.ent.text") : x}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="cad-lm-qs" role="group" aria-label={t("cadlm.qs.title")}>
      <div className="cad-lm-qs-head">{t("cadlm.qs.title")}</div>
      {sel(t("cadlm.qs.type"), kind, setKind, o.kinds)}
      {sel(t("cadlm.qs.layer"), layer, setLayer, o.layers)}
      {sel(t("cadlm.qs.color"), color, setColor, o.colors)}
      <label className="cad-lm-qs-row">
        <input type="checkbox" checked={add} onChange={(e) => setAdd(e.target.checked)} />
        <span>{t("cadlm.qs.add")}</span>
      </label>
      <div className="cad-lm-qs-btns">
        <button type="button" className="btn btn-primary" onClick={run}>
          {t("cadlm.qs.run")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {t("cadlm.qs.close")}
        </button>
      </div>
    </div>
  );
}

export function CadLayerManager() {
  const t = useT();
  const page = useStore((s) => findPage(s.doc, s.pageId));
  const selection = useStore((s) => s.selection);
  useClayer((s) => s.v);
  const [picked, setPicked] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [qs, setQs] = useState(false);
  // QSELECT / FILTER typed on the command line open it too
  const qsReq = useQs((s) => s.open);
  // AutoCAD's group manager hides unnamed (*A) groups unless "Include Unnamed" is on
  const [unnamed, setUnnamed] = useState(false);
  if (!page?.source?.cad) return null;
  const rows = cadPanelModel(page, { unnamed });
  const ltypes = loadedLtypes(page);
  const anyGroups = (page.source.cad.groups ?? []).length > 0;
  const layers = rows.filter((r): r is CadLayerRow => r.kind === "layer");
  const groups = rows.filter((r) => r.kind === "group");
  const cur = layers.find((r) => r.id === picked) ?? null;
  const add = () => {
    const r = newLayer(page);
    if ("error" in r) say(r.error);
    else {
      setPicked(r.id);
      setEditing(r.id);
    }
  };
  const del = () => cur && say(deleteLayer(page, cur.id));
  return (
    <div className="dock-body cad-lm">
      <div className="cad-lm-bar" role="toolbar" aria-label={t("cadlm.title")}>
        <IconBtn icon="plus" tip={t("cadlm.new")} onClick={add} />
        <IconBtn icon="trash" tip={t("cadlm.delete")} className="danger" disabled={!cur} onClick={del} />
        <IconBtn icon="check" tip={t("cadlm.setCurrent")} disabled={!cur || cur.current} onClick={() => cur && say(makeCurrent(page, cur.id))} />
        <IconBtn icon="text" tip={t("cadlm.rename")} disabled={!cur} onClick={() => cur && setEditing(cur.id)} />
        <span className="dock-tabs-spacer" />
        <IconBtn icon="search" tip={t("cadlm.qs.tip")} pressed={qs} onClick={() => setQs(!qs)} />
      </div>
      {(qs || qsReq) && <QSelect page={page} onClose={() => (setQs(false), useQs.setState({ open: false }))} />}
      <div className="dock-scroll cad-lm-scroll">
        <table className="cad-lm-table" role="grid" aria-label={t("cadlm.title")}>
          <thead>
            <tr>
              <th data-tip={t("cadlm.col.status")}>{t("cadlm.col.statusShort")}</th>
              <th className="cad-lm-th-name">{t("cadlm.col.name")}</th>
              <th>{t("cadlm.col.on")}</th>
              <th>{t("cadlm.col.freeze")}</th>
              <th>{t("cadlm.col.lock")}</th>
              <th>{t("cadlm.col.color")}</th>
              <th>{t("cadlm.col.ltype")}</th>
              <th>{t("cadlm.col.lw")}</th>
              <th>{t("cadlm.col.transparency")}</th>
              <th>{t("cadlm.col.plot")}</th>
            </tr>
          </thead>
          <tbody>
            {layers.map((r) => (
              <tr
                key={r.id}
                className={cx("cad-lm-row", r.current && "cur", picked === r.id && "on")}
                aria-selected={picked === r.id}
                tabIndex={0}
                onClick={() => setPicked(r.id)}
                onDoubleClick={(e) => !(e.target as HTMLElement).closest("button,input,select") && say(makeCurrent(page, r.id))}
                onKeyDown={(e) => {
                  if ((e.target as HTMLElement) !== e.currentTarget) return;
                  if (e.key === "F2") (e.preventDefault(), setEditing(r.id));
                  if (e.key === "Delete") (e.preventDefault(), e.stopPropagation(), say(deleteLayer(page, r.id)));
                }}
              >
                <td className="cad-lm-status" data-tip={r.current ? t("cadlm.isCurrent") : t("cadlm.setCurrentDbl")}>
                  {r.current ? <Icon name="check" size={13} /> : null}
                </td>
                <td className="cad-lm-td-name" data-tip={t("cadlm.count", { n: r.count })}>
                  <NameCell page={page} row={r} editing={editing === r.id} onDone={() => setEditing(null)} />
                </td>
                <td>
                  <button type="button" className="cad-li" aria-pressed={r.on} data-tip={r.on ? t("cadui.layer.off") : t("cadui.layer.on")} onClick={() => setLayerOn(page, r.id, !r.on)}>
                    <Icon name={r.on ? "eye" : "eyeOff"} size={14} />
                  </button>
                </td>
                <td>
                  <button type="button" className={cx("cad-li cad-frz", r.frozen && "on")} aria-pressed={r.frozen} data-tip={r.frozen ? t("cadui.layer.thaw") : t("cadui.layer.freeze")} onClick={() => say(setLayerFrozen(page, r.id, !r.frozen))}>
                    {r.frozen ? "❄" : <Icon name="sun" size={13} />}
                  </button>
                </td>
                <td>
                  <button type="button" className="cad-li" aria-pressed={r.locked} data-tip={r.locked ? t("dock.unlock") : t("dock.lock")} onClick={() => setLayerLocked(page, r.id, !r.locked)}>
                    <Icon name={r.locked ? "lock" : "unlock"} size={14} />
                  </button>
                </td>
                <td>
                  <ColorCell page={page} row={r} />
                </td>
                <td>
                  <select className="cad-lm-sel" value={r.ltype} aria-label={t("cadlm.col.ltype")} onChange={(e) => setLayerLtype(page, r.id, e.target.value)}>
                    {(ltypes.some((x) => x.toUpperCase() === r.ltype.toUpperCase()) ? ltypes : [r.ltype, ...ltypes]).map((x) => (
                      <option key={x} value={x.toUpperCase() === r.ltype.toUpperCase() ? r.ltype : x}>
                        {x}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select className="cad-lm-sel" value={r.lw === undefined ? "" : String(r.lw)} aria-label={t("cadlm.col.lw")} onChange={(e) => setLayerLw(page, r.id, e.target.value === "" ? undefined : Number(e.target.value))}>
                    <option value="">{t("cadlm.lwDefault")}</option>
                    {(r.lw === undefined || LWS.includes(r.lw) ? LWS : [r.lw, ...LWS]).map((v) => (
                      <option key={v} value={String(v)}>
                        {`${v.toFixed(2)} mm`}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    className="cad-lm-num"
                    type="number"
                    min={0}
                    max={90}
                    defaultValue={r.transparency}
                    key={r.transparency}
                    aria-label={t("cadlm.col.transparency")}
                    onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && (e.target as HTMLInputElement).blur())}
                    onBlur={(e) => Number(e.target.value) !== r.transparency && setLayerTransparency(page, r.id, Number(e.target.value) || 0)}
                  />
                </td>
                <td>
                  <button type="button" className={cx("cad-li", !r.plot && "cad-lm-noplot")} aria-pressed={r.plot} data-tip={r.plot ? t("cadlm.plotOff") : t("cadlm.plotOn")} onClick={() => setLayerPlot(page, r.id, !r.plot)}>
                    <Icon name="paper" size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {anyGroups && (
          <div className="cad-lm-groups">
            <div className="cad-lm-sec">{t("cadlm.groups")}</div>
            <label className="cad-lm-qs-row">
              <input type="checkbox" checked={unnamed} onChange={(e) => setUnnamed(e.target.checked)} />
              <span>{t("cadlm.unnamedGroups")}</span>
            </label>
            {groups.map((g) =>
              g.kind === "group" ? (
                <button key={g.name} type="button" className="cad-lm-group" data-tip={t("cadlm.groupTip", { n: g.ids.length })} onClick={() => S().set({ selection: g.ids })}>
                  <Icon name="folder" size={13} />
                  <span>{g.name}</span>
                  <span className="count">{g.ids.length}</span>
                </button>
              ) : null,
            )}
          </div>
        )}
      </div>
      <footer className="dock-foot">
        <span className="foot-info">{selection.length ? t("cadlm.footSel", { n: layers.length, sel: selection.length }) : t("cadlm.foot", { n: layers.length })}</span>
      </footer>
    </div>
  );
}
