// Format pane of the document edit mode (right dock): what is selected, in word-processor terms — character and
// paragraph format of the text, the picture's size, the table — or, with nothing selected, the page setup and the
// document's counts. Object geometry (X / Y / rotation / opacity) is not shown for text; lengths are mm (in for
// English) and font sizes / spacing pt, as in Word and 한글.

import { findPage, useStore } from "../../core/store";
import type { Align, SceneNode } from "../../core/types";
import { PAPERS, PX_PER_MM, marginsOf, paperOf, paperPx, type PageSetup } from "../../core/pageSetup";
import { PX_PER } from "../../core/units";
import { localBounds } from "../../core/loom";
import { boxSize } from "../../core/transform";
import { useRichStatus } from "../RichTextEditor";
import { applyPageSetup } from "../pageSetupActions";
import { docLengthUnit, fontScale } from "../editModes";
import { setSelectedSize } from "../xform";
import { startCrop } from "../cropTool";
import { canCrop } from "../../core/crop";
import { ColorField, Field, IconBtn, NumField, Section, Select, Seg, cx } from "./controls";
import { Icon } from "./Icons";
import { TablePanel } from "./NodePanels";
import { NodeProps } from "./RightDock";
import { FONTS, textTargetNow } from "./Ribbon";
import { docStats } from "./DocNav";
import { useUI } from "./uiStore";
import type { Live } from "./ops";
import { useLang, useT } from "../../i18n";


function TextFormat() {
  const t = useT();
  const lang = useLang((s) => s.lang);
  useStore((s) => s.selection);
  useStore((s) => s.editingTextId);
  useStore((s) => s.doc);
  useRichStatus();
  const tg = textTargetNow();
  if (!tg) return null;
  const f = tg.fmt, p = tg.para;
  const u = docLengthUnit(lang);
  const k = 1 / PX_PER[u];
  const lenStep = u === "in" ? 0.05 : 0.5, lenPrec = u === "in" ? 2 : 1;
  const fontOpts = (f.fontFamily && !FONTS.includes(f.fontFamily) ? [f.fontFamily, ...FONTS] : FONTS).map((x) => ({ value: x, label: x }));
  const check = (key: "keepNext" | "keepLines" | "pageBreakBefore", label: string) => (
    <label className="check">
      <input type="checkbox" checked={!!p[key]} onChange={(e) => tg.setPara({ [key]: e.target.checked }, label)} />
      <span>{label}</span>
    </label>
  );
  return (
    <>
      <Section title={t("docmode.props.character")} actions={<Icon name="text" size={14} />}>
        <Field label={t("ribbon.text.font")} wide>
          <Select value={f.fontFamily ?? ""} options={fontOpts} onChange={(v) => tg.setRun("fontFamily", v, t("ribbon.text.font"))} />
        </Field>
        <div className="grid2">
          <NumField label={t("docmode.props.size")} tip={t("docmode.fontSizePt")} value={f.fontSize ?? null} min={1} max={400} step={0.5} precision={1} scale={fontScale("pt")} unit="pt" width={0} live={tg.runLive("fontSize", t("ribbon.text.fontSize"))} />
          <ColorField tip={t("ribbon.text.color")} value={f.color ?? null} showHex live={tg.runLive("color", t("ribbon.text.color"))} />
        </div>
        <div className="btn-row props-btns">
          <IconBtn icon="bold" tip={t("ribbon.text.bold")} kbd="Ctrl+B" pressed={f.bold === true} onClick={() => tg.toggle("bold")} />
          <IconBtn icon="italic" tip={t("ribbon.text.italic")} kbd="Ctrl+I" pressed={f.italic === true} onClick={() => tg.toggle("italic")} />
          <IconBtn icon="underline" tip={t("ribbon.text.underline")} kbd="Ctrl+U" pressed={f.underline === true} onClick={() => tg.toggle("underline")} />
          <button type="button" className={cx("ibtn", "ibtn-md", "rt-glyph", f.strike === true && "on")} data-tip={t("ribbon.text.strike")} aria-pressed={f.strike === true} onClick={() => tg.toggle("strike")}>
            <s>{t("ribbon.text.strikeGlyph")}</s>
          </button>
          <ColorField tip={t("ribbon.text.highlightTip")} value={f.highlight ?? null} live={tg.runLive("highlight", t("ribbon.text.highlight")) as Live<string>} onNone={() => tg.setRun("highlight", null, t("ribbon.text.noHighlight"))} />
        </div>
        <Field label={t("ribbon.text.tracking")}>
          <NumField tip={t("ribbon.text.trackingTip")} value={f.letterSpacing === undefined ? null : (f.letterSpacing ?? 0)} min={-20} max={100} step={0.25} precision={2} scale={0.75} unit="pt" width={0} live={tg.runLive("letterSpacing", t("ribbon.text.tracking")) as Live<number>} />
        </Field>
      </Section>
      <Section
        title={t("docmode.props.paragraph")}
        actions={
          <button type="button" className="link-btn" onClick={() => useUI.getState().set({ shellDialog: "paragraph" })}>
            {t("docmode.props.more")}
          </button>
        }
      >
        <Seg<Align>
          value={p.align ?? null}
          ariaLabel={t("ribbon.alignGroup")}
          onChange={(v) => tg.setPara({ align: v }, t("ribbon.alignGroup"))}
          options={[
            { value: "LEFT", icon: "alignLeft", tip: t("ribbon.text.alignLeft") },
            { value: "CENTER", icon: "alignCenter", tip: t("ribbon.text.alignCenter") },
            { value: "RIGHT", icon: "alignRight", tip: t("ribbon.text.alignRight") },
            { value: "JUSTIFY", icon: "alignJustify", tip: t("ribbon.text.justify") },
          ]}
        />
        <p className="props-sub">{t("docmode.indent")}</p>
        <div className="grid2">
          <NumField label={t("docmode.left")} tip={t("ribbon.text.leftIndent")} value={p.indentLeft ?? null} min={-200 * k} max={600 * k} step={lenStep} precision={lenPrec} scale={k} unit={u} width={0} live={tg.paraLive("indentLeft", t("docmode.indent"))} />
          <NumField label={t("docmode.right")} tip={t("docmode.rightIndent")} value={p.indentRight ?? null} min={0} max={600 * k} step={lenStep} precision={lenPrec} scale={k} unit={u} width={0} live={tg.paraLive("indentRight", t("docmode.indent"))} />
          <NumField label={t("docmode.firstLine")} tip={t("ribbon.text.firstLineTip")} value={p.indent ?? null} min={-200 * k} max={400 * k} step={lenStep} precision={lenPrec} scale={k} unit={u} width={0} live={tg.paraLive("indent", t("ribbon.text.firstLineIndent"))} />
        </div>
        <p className="props-sub">{t("docmode.spacing")}</p>
        <div className="grid2">
          <NumField label={t("docmode.before")} tip={t("paragraph.ribbon.beforeTip")} value={p.spaceBefore ?? null} min={0} max={200} step={1} precision={1} scale={0.75} unit="pt" width={0} live={tg.paraLive("spaceBefore", t("docmode.spacing"))} />
          <NumField label={t("docmode.after")} tip={t("ribbon.text.spaceAfter")} value={p.spaceAfter ?? null} min={0} max={200} step={1} precision={1} scale={0.75} unit="pt" width={0} live={tg.paraLive("spaceAfter", t("docmode.spacing"))} />
          {p.lineMultiple === null ? (
            <NumField key="pct" icon="lineHeight" tip={t("paragraph.ribbon.linePctTip")} value={p.lineSpacing ?? null} min={50} max={500} step={5} scale={100} unit="%" width={0} live={tg.paraLive("lineSpacing", t("ribbon.text.lineSpacing"))} />
          ) : (
            <NumField key="mul" icon="lineHeight" tip={t("ribbon.text.lineSpacingTip")} value={p.lineMultiple ?? null} min={0.5} max={5} step={0.05} precision={2} unit={t("docmode.props.lines")} width={0} live={tg.paraLive("lineMultiple", t("ribbon.text.lineSpacing"))} />
          )}
        </div>
        <div className="check-col">
          {check("keepNext", t("docmode.props.keepNext"))}
          {check("keepLines", t("docmode.props.keepLines"))}
          {check("pageBreakBefore", t("docmode.props.pageBreakBefore"))}
        </div>
      </Section>
    </>
  );
}

/** A picture in the document: size on the page (mm / in), crop. */
function PictureFormat({ node }: { node: SceneNode }) {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const u = docLengthUnit(lang);
  const k = 1 / PX_PER[u];
  const sz = boxSize({ t: node.transform, lb: localBounds(node) });
  const plain = (dim: "w" | "h") => ({ set: (v: number) => setSelectedSize(dim, v) });
  return (
    <Section title={t("docmode.ctx.picture")} actions={<Icon name="image" size={14} />}>
      <p className="props-sub">{t("docmode.props.size")}</p>
      <div className="grid2">
        <NumField label={t("docmode.props.width")} tip={t("dock.props.widthOnPage")} value={sz.w} min={1 * k} precision={u === "in" ? 2 : 1} scale={k} unit={u} width={0} live={plain("w")} />
        <NumField label={t("docmode.props.height")} tip={t("dock.props.heightOnPage")} value={sz.h} min={1 * k} precision={u === "in" ? 2 : 1} scale={k} unit={u} width={0} live={plain("h")} />
      </div>
      {canCrop(node) && (
        <button type="button" className="btn btn-ghost btn-block" data-kbd="C" onClick={startCrop}>
          <Icon name="crop" size={14} />
          <span>{t("ribbon.crop")}</span>
        </button>
      )}
      <p className="muted-note">{t("docmode.props.pictureNote")}</p>
    </Section>
  );
}

/** Nothing selected: the page setup of this section and the document's counts. */
function PageFormat() {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const page = useStore((s) => findPage(s.doc, s.pageId));
  const doc = useStore((s) => s.doc);
  const mode = useStore((s) => s.mode);
  if (!page) return <div className="empty-state">{t("dock.props.noPage")}</div>;
  const m = marginsOf(page);
  const u = docLengthUnit(lang);
  const k = 1 / PX_PER[u];
  const setup = (patch: Partial<PageSetup>) => applyPageSetup({ width: page.width, height: page.height, margins: m, ...patch }, "document");
  const margin = (key: keyof typeof m): Live<number> => ({ set: (v) => setup({ margins: { ...m, [key]: Math.max(0, v) } }) });
  const landscape = page.width > page.height;
  const paper = paperOf(page.width, page.height);
  const st = docStats(doc, mode);
  const nPages = doc.pages.filter((p) => p.kind === page.kind).length;
  const mmPrec = u === "in" ? 2 : 1, step = u === "in" ? 0.05 : 1;
  return (
    <>
      <Section title={t("docmode.props.page")} actions={<Icon name="paper" size={14} />}>
        <Field label={t("docmode.size")}>
          <Select<string>
            value={paper}
            options={[...PAPERS.map((p) => ({ value: p.id as string, label: `${t(`pagesetup.paper.${p.id}`, undefined, p.id)} · ${p.w} × ${p.h} mm` })), ...(paper === "custom" ? [{ value: "custom", label: t("pagesetup.paper.custom") }] : [])]}
            onChange={(v) => {
              if (v === "custom") return;
              const px = paperPx(v as (typeof PAPERS)[number]["id"]);
              setup(landscape ? { width: px.height, height: px.width } : px);
            }}
          />
        </Field>
        <Field label={t("docmode.orientation")}>
          <Seg<"p" | "l">
            value={landscape ? "l" : "p"}
            onChange={(v) => (v === "l") !== landscape && setup({ width: page.height, height: page.width })}
            options={[
              { value: "p", label: t("docmode.portrait") },
              { value: "l", label: t("docmode.landscape") },
            ]}
          />
        </Field>
        <p className="props-sub">{t("docmode.margins")}</p>
        <div className="grid2">
          <NumField label={t("docmode.top")} tip={t("docmode.margins")} value={m.top} min={0} precision={mmPrec} step={step} scale={k} unit={u} width={0} live={margin("top")} />
          <NumField label={t("docmode.bottom")} tip={t("docmode.margins")} value={m.bottom} min={0} precision={mmPrec} step={step} scale={k} unit={u} width={0} live={margin("bottom")} />
          <NumField label={t("docmode.left")} tip={t("docmode.margins")} value={m.left} min={0} precision={mmPrec} step={step} scale={k} unit={u} width={0} live={margin("left")} />
          <NumField label={t("docmode.right")} tip={t("docmode.margins")} value={m.right} min={0} precision={mmPrec} step={step} scale={k} unit={u} width={0} live={margin("right")} />
          <NumField label={t("headerfooter.header")} tip={t("docmode.props.headerDist")} value={m.header} min={0} precision={mmPrec} step={step} scale={k} unit={u} width={0} live={margin("header")} />
          <NumField label={t("headerfooter.footer")} tip={t("docmode.props.footerDist")} value={m.footer} min={0} precision={mmPrec} step={step} scale={k} unit={u} width={0} live={margin("footer")} />
        </div>
        <button type="button" className="btn btn-ghost btn-block" onClick={() => useUI.getState().set({ shellDialog: "pageSetup" })}>
          <Icon name="doc" size={14} />
          <span>{t("docmode.pageSetup")}…</span>
        </button>
      </Section>
      <Section title={t("docmode.props.document")}>
        <dl className="info-list">
          <dt>{t("docmode.props.pages")}</dt>
          <dd>{nPages.toLocaleString()}</dd>
          <dt>{t("menu.wc.words")}</dt>
          <dd>{st.words.toLocaleString()}</dd>
          <dt>{t("menu.wc.chars")}</dt>
          <dd>{st.chars.toLocaleString()}</dd>
          <dt>{t("menu.wc.charsNoSpaces")}</dt>
          <dd>{st.charsNoSpaces.toLocaleString()}</dd>
          <dt>{t("menu.wc.paragraphs")}</dt>
          <dd>{st.paragraphs.toLocaleString()}</dd>
        </dl>
        <p className="muted-note">{t("docmode.props.mmNote", { mm: Math.round(PX_PER_MM * 100) / 100 })}</p>
      </Section>
    </>
  );
}

export function DocPropsTab() {
  const page = useStore((s) => findPage(s.doc, s.pageId));
  const selection = useStore((s) => s.selection);
  const editing = useStore((s) => s.editingTextId);
  const nodes = page ? page.nodes.filter((n) => selection.includes(n.id)) : [];
  const kinds = new Set(nodes.map((n) => n.type));
  let body: React.ReactNode;
  if (editing || (nodes.length && kinds.size === 1 && kinds.has("TEXT"))) body = <TextFormat />;
  else if (nodes.length === 1 && nodes[0].type === "TABLE") body = <TablePanel node={nodes[0]} />;
  else if (nodes.length === 1 && (nodes[0].type === "IMAGE" || nodes[0].type === "RASTER" || nodes[0].type === "PDF")) body = <PictureFormat node={nodes[0]} />;
  else if (nodes.length) body = <NodeProps nodes={nodes} />;
  else body = <PageFormat />;
  return <div className="dock-scroll pad">{body}</div>;
}
