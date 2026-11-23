import { useMemo, useState } from "react";
import { HistoryTab } from "./HistoryTab";
import { ReviewTab } from "./ReviewPanel";
import { hasReview } from "../../core/review";
import { ANIM_PRESETS, animDuration, type AnimPreset } from "../../core/anim";
import { draftPage, findPage, useStore } from "../../core/store";
import type { AnimTrigger, KeyframeAnimation, Page, PageKind, SceneNode } from "../../core/types";
import { addAnimation, elevatePdf, setPageProps, updateNodes, updateSelected } from "../actions";
import { ColorField, Field, IconBtn, NumField, Section, Select, Seg, cx } from "./controls";
import { Icon } from "./Icons";
import { KIND_META, NODE_ICON, NODE_KIND_LABEL } from "./LeftDock";
import { MediaPanel, TablePanel } from "./NodePanels";
import { nodeLive, pageLive } from "./ops";
import { BLEND_OPTIONS, TRANSITIONS } from "./Ribbon";
import { useUI } from "./uiStore";
import { AlignButtons } from "./ArrangeTools";
import { localBounds } from "../../core/loom";
import { boxSize } from "../../core/transform";
import { setSelectedSize } from "../xform";
import { useT } from "../../i18n";
import { marginsOf, toUnit } from "../../core/pageSetup";
import { ClipSwitch, GroupProps, usePickedGroup } from "./GroupPanels";
import { GroupEffects, NodeEffects } from "../style/EffectsSection";
import { PROFILES, useCadScreenNow, useEditMode } from "../editModes";
import { CadProps } from "../cad/lazy";
import { DocPropsTab } from "./DocProps";

const S = () => useStore.getState();

function TextInput({ value, onCommit, ariaLabel }: { value: string; onCommit: (v: string) => void; ariaLabel: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className="text-input"
      value={draft ?? value}
      aria-label={ariaLabel}
      spellCheck={false}
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        setDraft(null);
        const v = e.target.value.trim();
        if (v && v !== value) onCommit(v);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setDraft(value);
        e.stopPropagation();
      }}
    />
  );
}

// ───────── page properties ─────────

function PageProps({ page }: { page: Page }) {
  const masters = useStore((s) => s.doc.masters);
  const isMaster = page.kind === "MASTER";
  const kinds: PageKind[] = ["DESIGN", "DOCUMENT", "SLIDE", "PDF"];
  const t = useT();
  return (
    <>
      <Section title={isMaster ? t("dock.props.master") : t("dock.pages.title")}>
        <Field label={t("dock.props.name")} wide>
          <TextInput value={page.name} ariaLabel={t("dock.props.pageName")} onCommit={(v) => setPageProps({ name: v })} />
        </Field>
        <div className="grid2">
          <NumField label="W" tip={t("dock.width")} value={page.width} min={16} max={16384} unit="px" width={0} live={pageLive<number>((p, v) => (p.width = v), t("dock.props.pageSize"))} />
          <NumField label="H" tip={t("dock.height")} value={page.height} min={16} max={16384} unit="px" width={0} live={pageLive<number>((p, v) => (p.height = v), t("dock.props.pageSize"))} />
        </div>
        <div className="preset-row">
          {(
            [
              ["A4", "A4", 794, 1123],
              ["16:9", "16:9", 1280, 720],
              ["FHD", "FHD", 1920, 1080],
              ["square", t("dock.props.square"), 1080, 1080],
            ] as const
          ).map(([id, l, w, h]) => (
            <button key={id} type="button" className={cx("chip", Math.abs(page.width - w) < 1 && Math.abs(page.height - h) < 1 && "on")} onClick={() => setPageProps({ width: w, height: h })}>
              {l}
            </button>
          ))}
          <IconBtn icon="rotate" size="sm" tip={t("dock.props.swap")} onClick={() => setPageProps({ width: page.height, height: page.width })} />
        </div>
        {page.kind === "DOCUMENT" && (
          <div className="media-row">
            <button type="button" className="chip" onClick={() => useUI.getState().set({ shellDialog: "pageSetup" })}>
              {t("cmd.page.setup")}…
            </button>
            <span className="muted-note">
              {(() => {
                const m = marginsOf(page);
                const mm = (v: number) => `${toUnit(v, "mm")}`;
                return t("pagesetup.margin.summary", { top: mm(m.top), bottom: mm(m.bottom), left: mm(m.left), right: `${mm(m.right)} mm` });
              })()}
            </span>
          </div>
        )}
        <Field label={t("dock.background")}>
          <ColorField value={page.background} showHex live={pageLive<string>((p, v) => (p.background = v), t("dock.props.bgColor"))} />
        </Field>
        {!isMaster && (
          <Field label={t("dock.props.kind")}>
            <Select<PageKind> value={page.kind} options={kinds.map((k) => ({ value: k, label: KIND_META[k].label }))} onChange={(v) => setPageProps({ kind: v })} />
          </Field>
        )}
        {!isMaster && (
          <Field label={t("dock.props.master")}>
            <Select
              value={page.masterId ?? "__none"}
              options={[{ value: "__none", label: t("dock.none") }, ...masters.map((m) => ({ value: m.id, label: m.name }))]}
              onChange={(v) => setPageProps({ masterId: v === "__none" ? null : v })}
            />
          </Field>
        )}
      </Section>
      {page.kind === "SLIDE" && (
        <Section title={t("dock.props.transition")}>
          <Field label={t("dock.props.effect")}>
            <Select value={page.transition.type} options={TRANSITIONS} onChange={(v) => setPageProps({ transition: { ...page.transition, type: v } })} />
          </Field>
          <Field label={t("dock.props.time")}>
            <NumField icon="clock" tip={t("dock.props.transitionTime")} value={page.transition.duration} min={0} max={5000} step={50} unit="ms" width={0} disabled={page.transition.type === "NONE"} live={pageLive<number>((p, v) => (p.transition = { ...page.transition, duration: v }), t("dock.props.transitionTime"))} />
          </Field>
        </Section>
      )}
      <Section title={t("dock.props.info")}>
        <dl className="info-list">
          <dt>{t("dock.props.objects")}</dt>
          <dd>{t("dock.count", { n: page.nodes.length })}</dd>
          <dt>{t("dock.props.animations")}</dt>
          <dd>{t("dock.count", { n: page.animations.length })}</dd>
          <dt>{t("dock.props.ratio")}</dt>
          <dd>{(page.width / page.height).toFixed(3)}</dd>
        </dl>
      </Section>
    </>
  );
}

// ───────── node properties ─────────

export function NodeProps({ nodes }: { nodes: SceneNode[] }) {
  const n = nodes[0];
  const multi = nodes.length > 1;
  const same = <K extends keyof SceneNode>(k: K) => nodes.every((x) => x[k] === n[k]);
  const sameT = (k: "x" | "y" | "rotation" | "scale") => (nodes.every((x) => x.transform[k] === n.transform[k]) ? n.transform[k] : null);
  const kinds = [...new Set(nodes.map((x) => x.type))];
  const t = useT();
  return (
    <>
      <Section title={multi ? t("dock.props.selected", { n: nodes.length }) : NODE_KIND_LABEL[n.type]} actions={<Icon name={kinds.length === 1 ? NODE_ICON[n.type] : "layers"} size={14} />}>
        {!multi && (
          <Field label={t("dock.props.name")} wide>
            <TextInput value={n.name} ariaLabel={t("dock.props.objectName")} onCommit={(v) => updateNodes([n.id], t("dock.rename"), (x) => (x.name = v))} />
          </Field>
        )}
        <div className="grid2">
          <NumField label="X" tip={t("dock.props.xPos")} value={sameT("x")} precision={1} unit="px" width={0} live={nodeLive<number>(t("dock.props.position"), (x, v) => (x.transform.x = v))} />
          <NumField label="Y" tip={t("dock.props.yPos")} value={sameT("y")} precision={1} unit="px" width={0} live={nodeLive<number>(t("dock.props.position"), (x, v) => (x.transform.y = v))} />
          <NumField icon="rotate" tip={t("dock.props.rotation")} value={sameT("rotation")} min={-360} max={360} precision={1} unit="°" width={0} live={nodeLive<number>(t("dock.props.rotation"), (x, v) => (x.transform.rotation = v))} />
          <NumField label={t("dock.props.scale")} tip={t("dock.props.scale")} value={sameT("scale")} scale={100} min={1} max={5000} unit="%" width={0} live={nodeLive<number>(t("dock.props.scale"), (x, v) => (x.transform.scale = v))} />
          {!multi && <SizeFields node={n} />}
        </div>
      </Section>
      <Section title={t("dock.props.alignFlip")}>
        <div className="arrange-grid">
          <AlignButtons />
        </div>
      </Section>
      <Section title={t("dock.props.appearance")}>
        <div className="grid2">
          <NumField icon="opacity" tip={t("dock.props.opacity")} value={same("opacity") ? n.opacity : null} scale={100} min={0} max={100} unit="%" width={0} live={nodeLive<number>(t("dock.props.opacity"), (x, v) => (x.opacity = v))} />
          <Select icon="blend" tip={t("dock.props.blend")} value={same("blendMode") ? n.blendMode : ""} options={BLEND_OPTIONS} onChange={(v) => updateSelected(t("dock.props.blend"), (x) => (x.blendMode = v))} />
        </div>
        <div className="check-row">
          <label className="check">
            <input type="checkbox" checked={nodes.every((x) => x.visible)} onChange={(e) => updateSelected(t("dock.props.visibility"), (x) => (x.visible = e.target.checked))} />
            <span>{t("dock.show")}</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={nodes.every((x) => x.locked)} onChange={(e) => updateSelected(t("dock.lock"), (x) => (x.locked = e.target.checked))} />
            <span>{t("dock.lock")}</span>
          </label>
          <ClipSwitch nodes={nodes} />
        </div>
      </Section>
      {!multi && <TypeProps node={n} />}
      <NodeEffects nodes={nodes} />
    </>
  );
}

/** On-page width / height of one object (local size × scale); the top-left corner stays put. */
function SizeFields({ node }: { node: SceneNode }) {
  const sz = boxSize({ t: node.transform, lb: localBounds(node) });
  const plain = (dim: "w" | "h") => ({ set: (v: number) => setSelectedSize(dim, v) });
  const t = useT();
  return (
    <>
      <NumField label="W" tip={t("dock.props.widthOnPage")} value={Math.round(sz.w * 10) / 10} min={1} precision={1} unit="px" width={0} live={plain("w")} />
      <NumField label="H" tip={node.type === "TEXT" ? t("dock.props.textHeight") : t("dock.props.heightOnPage")} value={Math.round(sz.h * 10) / 10} min={1} precision={1} unit="px" width={0} disabled={node.type === "TEXT"} live={plain("h")} />
    </>
  );
}

function TypeProps({ node }: { node: SceneNode }) {
  const assets = useStore((s) => s.doc.assets);
  const t = useT();
  switch (node.type) {
    case "VECTOR":
      return (
        <Section title={t("dock.node.VECTOR")}>
          <Field label={t("dock.props.fill")}>
            <ColorField value={node.fill} showHex live={nodeLive<string>(t("dock.props.fill"), (x, v) => (x.fill = v))} onNone={() => updateSelected(t("dock.props.noFill"), (x) => (x.fill = null))} />
          </Field>
          <Field label={t("dock.props.stroke")}>
            <ColorField value={node.stroke} showHex live={nodeLive<string>(t("dock.props.strokeColor"), (x, v) => (x.stroke = v))} onNone={() => updateSelected(t("dock.props.noStroke"), (x) => (x.stroke = null))} />
          </Field>
          <Field label={t("dock.props.strokeWidth")}>
            <NumField icon="minus" tip={t("dock.props.strokeWidth")} value={node.strokeWidth} min={0} max={200} step={0.5} precision={1} unit="px" width={0} live={nodeLive<number>(t("dock.props.strokeWidth"), (x, v) => (x.strokeWidth = v))} />
          </Field>
          <Field label={t("dock.props.fillRule")}>
            <Seg
              value={node.fillRule}
              onChange={(v) => updateSelected(t("dock.props.fillRule"), (x) => (x.fillRule = v))}
              options={[
                { value: "nonzero", label: t("dock.props.nonzero") },
                { value: "evenodd", label: t("dock.props.evenodd") },
              ]}
            />
          </Field>
          <p className="muted-note">{t("dock.props.vectorInfo", { paths: node.contours.length, points: node.contours.reduce((a, c) => a + c.nodes.length, 0) })}</p>
        </Section>
      );
    case "TEXT":
      return (
        <Section title={t("dock.props.textBox")}>
          <Field label={t("dock.width")}>
            <NumField label="W" tip={t("dock.props.boxWidth")} value={node.width} min={20} max={10000} unit="px" width={0} live={nodeLive<number>(t("dock.props.textWidth"), (x, v) => (x.width = v))} />
          </Field>
          <Field label={t("dock.background")}>
            <ColorField value={node.background} showHex live={nodeLive<string>(t("dock.props.textBg"), (x, v) => (x.background = v))} onNone={() => updateSelected(t("dock.props.textNoBg"), (x) => (x.background = null))} />
          </Field>
          <Field label={t("dock.props.wrap")}>
            <Seg
              value={node.wordBreak}
              onChange={(v) => updateSelected(t("dock.props.wrap"), (x) => (x.wordBreak = v))}
              options={[
                { value: "keep-all", label: t("dock.props.wrapWord"), tip: "keep-all" },
                { value: "normal", label: t("dock.props.wrapChar"), tip: "normal" },
              ]}
            />
          </Field>
          <Field label={t("dock.props.spaceAfter")}>
            <NumField label="↧" tip={t("dock.props.spaceAfterTip")} value={node.paragraphs[0]?.spaceAfter ?? 0} min={0} max={200} unit="px" width={0} live={nodeLive<number>(t("dock.props.paraSpacing"), (x, v) => x.paragraphs.forEach((p: any) => (p.spaceAfter = v)))} />
          </Field>
          <Field label={t("dock.props.indent")}>
            <NumField label="⇥" tip={t("dock.props.firstIndent")} value={node.paragraphs[0]?.indent ?? 0} min={-200} max={400} unit="px" width={0} live={nodeLive<number>(t("dock.props.indent"), (x, v) => x.paragraphs.forEach((p: any) => (p.indent = v)))} />
          </Field>
          <p className="muted-note">{t("dock.props.textInfo", { n: node.paragraphs.length })}</p>
        </Section>
      );
    case "IMAGE":
      return (
        <Section title={t("dock.node.IMAGE")}>
          <div className="grid2">
            <NumField label="W" tip={t("dock.width")} value={node.width} min={1} precision={1} unit="px" width={0} live={nodeLive<number>(t("dock.props.imageSize"), (x, v) => (x.width = v))} />
            <NumField label="H" tip={t("dock.height")} value={node.height} min={1} precision={1} unit="px" width={0} live={nodeLive<number>(t("dock.props.imageSize"), (x, v) => (x.height = v))} />
          </div>
          <p className="muted-note">{assets[node.assetId] ? `${assets[node.assetId].name} · ${(assets[node.assetId].size / 1024).toFixed(0)}KB` : t("dock.props.noAsset")}</p>
        </Section>
      );
    case "PDF":
      return (
        <Section title={t("dock.props.pdfPage")}>
          <dl className="info-list">
            <dt>{t("dock.props.srcPage")}</dt>
            <dd>{node.pageIndex + 1}</dd>
            <dt>{t("dock.props.size")}</dt>
            <dd>
              {Math.round(node.width)} × {Math.round(node.height)}
            </dd>
            <dt>{t("dock.props.elevated")}</dt>
            <dd>{t("dock.count", { n: node.covers.length })}</dd>
          </dl>
          <button type="button" className="btn btn-accent btn-block" disabled={node.covers.length > 0} onClick={() => void elevatePdf()}>
            <Icon name="elevate" size={14} />
            <span>{node.covers.length ? t("dock.props.elevateDone") : t("dock.props.elevate")}</span>
          </button>
        </Section>
      );
    case "TABLE":
      return <TablePanel node={node} />;
    case "MEDIA":
      return <MediaPanel node={node} />;
    case "RASTER":
      return (
        <Section title={t("dock.node.RASTER")}>
          <dl className="info-list">
            <dt>{t("dock.props.tiles")}</dt>
            <dd>{t("dock.props.tileCount", { n: Object.keys(node.tiles).length })}</dd>
            <dt>{t("dock.props.memory")}</dt>
            <dd>{((Object.keys(node.tiles).length * 256 * 256 * 4) / 1048576).toFixed(1)}MB</dd>
          </dl>
          <button type="button" className="btn btn-ghost btn-block" onClick={() => S().set({ tool: "brush" })}>
            <Icon name="brush" size={14} />
            <span>{t("dock.props.paintBrush")}</span>
          </button>
        </Section>
      );
  }
}

function PropsTab() {
  const page = useStore((s) => findPage(s.doc, s.pageId));
  const selection = useStore((s) => s.selection);
  const picked = usePickedGroup();
  const t = useT();
  if (!page) return <div className="empty-state">{t("dock.props.noPage")}</div>;
  const nodes = page.nodes.filter((n) => selection.includes(n.id));
  return (
    <div className="dock-scroll pad">
      {picked && <GroupProps group={picked.group} count={picked.count} />}
      {picked && <GroupEffects group={picked.group} />}
      {nodes.length ? <NodeProps nodes={nodes} /> : !picked && <PageProps page={page} />}
    </div>
  );
}

// ───────── animations ─────────

// ids only; labels are looked up at render time (dock.anim.trigger.* / dock.anim.prop.*)
const TRIGGER_IDS: AnimTrigger[] = ["ON_CLICK", "WITH_PREVIOUS", "AFTER_PREVIOUS"];

function editAnims(label: string, fn: (list: KeyframeAnimation[]) => KeyframeAnimation[] | void) {
  const s = S();
  s.commit(label, (d) => {
    const pg = draftPage(d, s.pageId);
    if (!pg) return;
    const r = fn(pg.animations as KeyframeAnimation[]);
    if (r) pg.animations = r as any;
  });
}

function AnimTab() {
  const page = useStore((s) => findPage(s.doc, s.pageId));
  const selection = useStore((s) => s.selection);
  const [trigger, setTrigger] = useState<AnimTrigger>("ON_CLICK");
  const t = useT();
  if (!page) return null;
  const triggers = TRIGGER_IDS.map((value) => ({ value, label: t(`dock.anim.trigger.${value}`) }));
  const nameOf = (id: string) => page.nodes.find((n) => n.id === id)?.name ?? t("dock.anim.deleted");
  let step = 0;
  return (
    <div className="dock-scroll pad">
      <Section title={t("dock.anim.add")}>
        {!selection.length && <p className="muted-note">{t("dock.anim.selectFirst")}</p>}
        <Field label={t("dock.anim.start")}>
          <Select value={trigger} options={triggers} onChange={setTrigger} />
        </Field>
        <div className="preset-grid">
          {(Object.keys(ANIM_PRESETS) as AnimPreset[]).map((k) => (
            <button key={k} type="button" className="preset" disabled={!selection.length} onClick={() => addAnimation(k, trigger)}>
              <Icon name="sparkle" size={14} />
              <span>{t(`dock.anim.preset.${k}`, undefined, ANIM_PRESETS[k].label)}</span>
            </button>
          ))}
        </div>
      </Section>
      <Section title={t("dock.anim.order", { n: page.animations.length })} actions={page.animations.length ? <button type="button" className="link-btn" onClick={() => editAnims(t("dock.anim.clearAll"), () => [])}>{t("dock.anim.deleteAll")}</button> : undefined}>
        {!page.animations.length && (
          <div className="empty-state small">
            <Icon name="sparkle" size={20} />
            <p>{t("dock.anim.empty")}</p>
          </div>
        )}
        <ol className="anim-list">
          {page.animations.map((a, i) => {
            if (a.trigger === "ON_CLICK") step++;
            const sel = selection.includes(a.targetNodeId);
            return (
              <li key={a.id} className={cx("anim-row", sel && "active")} onClick={() => S().set({ selection: [a.targetNodeId] })}>
                <span className={cx("anim-step", a.trigger !== "ON_CLICK" && "cont")} data-tip={a.trigger === "ON_CLICK" ? t("dock.anim.click", { n: step }) : step ? t("dock.anim.afterClick", { n: step }) : t("dock.anim.auto")}>
                  {a.trigger === "ON_CLICK" ? step : "·"}
                </span>
                <div className="anim-main">
                  <span className="anim-name">{nameOf(a.targetNodeId)}</span>
                  <span className="anim-sub">
                    {t(`dock.anim.prop.${a.property}`)} · {animDuration(a)}ms
                  </span>
                </div>
                <span onClick={(e) => e.stopPropagation()} className="anim-ctl">
                  <Select<AnimTrigger> value={a.trigger} options={triggers} width={88} onChange={(v) => editAnims(t("dock.anim.changeTrigger"), (l) => void (l[i].trigger = v))} />
                  {/* duration in seconds (the keyframes keep their proportions) */}
                  <NumField
                    tip={t("slide.anim.duration")}
                    value={animDuration(a) / 1000}
                    min={0.05}
                    max={60}
                    step={0.25}
                    precision={2}
                    unit="s"
                    width={64}
                    live={{
                      set: (v) => {
                        const old = animDuration(a);
                        if (old > 0 && v > 0) editAnims(t("slide.anim.duration"), (l) => void (l[i].keyframes = l[i].keyframes.map((k) => ({ ...k, time: (k.time * v * 1000) / old }))));
                      },
                    }}
                  />
                  <IconBtn icon="up" size="sm" tip={t("dock.moveUp")} disabled={i === 0} onClick={() => editAnims(t("dock.anim.reorder"), (l) => void ([l[i - 1], l[i]] = [l[i], l[i - 1]]))} />
                  <IconBtn icon="down" size="sm" tip={t("dock.moveDown")} disabled={i === page.animations.length - 1} onClick={() => editAnims(t("dock.anim.reorder"), (l) => void ([l[i], l[i + 1]] = [l[i + 1], l[i]]))} />
                  <IconBtn icon="trash" size="sm" tip={t("dock.delete")} className="danger" onClick={() => editAnims(t("dock.anim.delete"), (l) => l.filter((x) => x.id !== a.id && !(a.pptx && x.pptx?.g === a.pptx.g)))} />
                </span>
              </li>
            );
          })}
        </ol>
      </Section>
    </div>
  );
}

export function RightDock() {
  const set = useUI((s) => s.set);
  const nAnim = useStore((s) => findPage(s.doc, s.pageId)?.animations.length ?? 0);
  const t = useT();
  // the edit mode decides the tabs (no animations in documents and images) and what Properties shows
  const mode = useEditMode();
  // a drawing: AutoCAD's Properties palette (general · geometry in drawing units)
  const cadOn = useCadScreenNow();
  const anim = PROFILES[mode].animations && !cadOn;
  const want = useUI((s) => s.rightTab);
  const doc = mode === "DOCUMENT";
  // the review pane (메모·변경 내용): documents with comments or tracked changes, and every document page (stage 2:
  // comments are added and changes recorded there)
  const pages = useStore((s) => s.doc.pages);
  const review = useMemo(() => doc && (hasReview(pages) || pages.some((p) => p.kind === "DOCUMENT")), [doc, pages]);
  const tab = (want === "anim" && !anim) || (want === "review" && !review) ? "props" : want;
  return (
    <aside className="dock dock-right" aria-label={t("dock.right.label")}>
      <div className="dock-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "props"} className={cx("dock-tab", tab === "props" && "on")} onClick={() => set({ rightTab: "props" })}>
          <Icon name="sliders" size={14} />
          <span className="dock-tab-label" title={doc ? t("docmode.format") : t("dock.tab.props")}>{doc ? t("docmode.format") : cadOn ? t("cadui.props.tab") : t("dock.tab.props")}</span>
        </button>
        {anim && (
          <button type="button" role="tab" aria-selected={tab === "anim"} className={cx("dock-tab", tab === "anim" && "on")} onClick={() => set({ rightTab: "anim" })}>
            <Icon name="sparkle" size={14} />
            <span className="dock-tab-label" title={t("dock.props.animations")}>{t("dock.props.animations")}</span> {nAnim > 0 && <span className="count">{nAnim}</span>}
          </button>
        )}
        {review && (
          <button type="button" role="tab" aria-selected={tab === "review"} className={cx("dock-tab", tab === "review" && "on")} onClick={() => set({ rightTab: "review" })}>
            <Icon name="comment" size={14} />
            <span className="dock-tab-label" title={t("review.tab")}>{t("review.tab")}</span>
          </button>
        )}
        <button type="button" role="tab" aria-selected={tab === "history"} className={cx("dock-tab", tab === "history" && "on")} onClick={() => set({ rightTab: "history" })}>
          <Icon name="clock" size={14} />
          <span className="dock-tab-label" title={t("dock.tab.history")}>{t("dock.tab.history")}</span>
        </button>
        <span className="dock-tabs-spacer" />
        <IconBtn icon="panelRight" size="sm" tip={t("dock.collapse")} kbd="Ctrl+Alt+2" onClick={() => set({ rightOpen: false })} />
      </div>
      <div className="dock-body">{tab === "props" ? doc ? <DocPropsTab /> : cadOn ? <CadProps /> : <PropsTab /> : tab === "anim" ? <AnimTab /> : tab === "review" ? <ReviewTab /> : <HistoryTab />}</div>
    </aside>
  );
}
