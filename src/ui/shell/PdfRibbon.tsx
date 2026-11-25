// PDF ribbon (docs/design/UI_TOP_REDESIGN.md §3, issue 3): a PDF page gets its own tabs — never the word processor's.
//   PDF   편집 (텍스트 편집(승격) big, text / picture) · 쪽 정리 · 주석 · 양식 · 서명 · 인식(OCR)
//   주석  the comment tools, the review pane and the drawing tools
//   쪽    organise, insert, duplicate, delete, move, rotate, extract, split
//   보호  save with a password, a smaller PDF
//   보기  zoom, panes, rulers / grid
// Every button runs a command of commands.ts (or the same function the old menu ran), so command search agrees.
import { findPage, useStore } from "../../core/store";
import { useT } from "../../i18n";
import { elevatePdf, exportAs } from "../actions";
import { sameTypeExport } from "../../io/formats";
import { toggleGrid, toggleRulers } from "../aids";
import { ocrTarget } from "../ocrActions";
import { PdfAnnotBtns, usePdfAnnot } from "../pdf/PdfAnnotLayer";
import { PdfFormBtn } from "../pdf/PdfFormLayer";
import { PdfToolsPanel } from "../pdf/PdfTools";
import { exportComments, importComments } from "../pdf/PdfComments";
import { openPdfDialog, setPdfTool } from "../pdf/pdfToolsStore";
import { BigBtn, CmdBig, CmdSmall, CtxPanel, Group, SmallBtn, ViewModesGroup, can, docZoom } from "./DocRibbon";
import { useImageUI } from "./imageMenu";
import { zoomStep } from "./ops";
import { ContextArea, ToolStrip } from "./Ribbon";
import type { RibbonContext } from "./ribbonContext";
import { useUI } from "./uiStore";

/** 텍스트 편집(승격): the PDF page's text becomes editable text boxes over the page (once per page). */
function ElevateBig() {
  const t = useT();
  const page = useStore((s) => findPage(s.doc, s.pageId));
  const pdf = page?.nodes.find((n) => n.type === "PDF");
  const done = !!(pdf && pdf.type === "PDF" && pdf.covers.length);
  return (
    <button type="button" className={"rbig rbig-accent" + (done ? " on" : "")} data-tip={t("ribbon.pdf.elevateTip")} aria-label={t("ribbon.pdf.elevate")} disabled={done || !can("text.editPdf")} onClick={() => void elevatePdf()}>
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" className="ic">
        <path d="M4 15.5 13.5 6l1.5 1.5L5.5 17H4z M12 4.5l3.5 3.5 1.2-1.2a1 1 0 0 0 0-1.4l-2.1-2.1a1 1 0 0 0-1.4 0z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M2 3h6M5 3v6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
      <span>{done ? t("ribbon.pdf.elevated") : t("topui.pdf.editText")}</span>
    </button>
  );
}

function OcrBig() {
  const t = useT();
  useStore((s) => s.selection);
  // (the selected picture, or the page itself: a scanned PDF page — ui/ocrActions.ts ocrTarget)
  useStore((s) => s.pageId);
  const target = ocrTarget();
  return <BigBtn icon="search" label={t("topui.pdf.ocr")} tip={target ? t("ocr.menuHint") : t("image.menu.needTarget")} disabled={!target} onClick={() => useImageUI.getState().set({ kind: "ocr" })} />;
}

function PdfHomePanel() {
  const t = useT();
  useStore((s) => s.pageId);
  usePdfAnnot((s) => s.tool);
  return (
    <div className="rpanel">
      <Group label={t("topui.pdf.g.edit")}>
        <ElevateBig />
        <div className="rcol">
          <CmdSmall id="insert.text" icon="textBox" label={t("topui.pdf.addText")} />
          <CmdSmall id="insert.image" icon="image" label={t("topui.pdf.addImage")} />
          <CmdSmall id="edit.find" icon="search" />
        </div>
      </Group>
      <Group label={t("topui.pdf.g.pages")}>
        <CmdBig id="page.organizer" icon="organize" label={t("topui.pdf.organize")} />
        <div className="rcol">
          <CmdSmall id="page.rotateRight" />
          <CmdSmall id="page.rotateLeft" />
          <CmdSmall id="file.importPages" />
        </div>
      </Group>
      <Group label={t("topui.pdf.g.comment")}>
        <div className="rcol">
          <CmdSmall id="text.pdfHighlight" />
          <CmdSmall id="text.pdfUnderline" />
          <CmdSmall id="text.pdfStrike" />
        </div>
        <CmdBig id="text.pdfNote" icon="comment" />
      </Group>
      <Group label={t("topui.pdf.g.form")}>
        <CmdBig id="text.fillPdfForm" icon="textBox" />
      </Group>
      <Group label={t("topui.pdf.g.sign")}>
        <CmdBig id="text.pdfSign" icon="pen" />
      </Group>
      <Group label={t("topui.pdf.g.ocr")}>
        <OcrBig />
      </Group>
    </div>
  );
}

function PdfCommentPanel() {
  const t = useT();
  return (
    <div className="rpanel rpanel-draw">
      <PdfAnnotBtns />
      <PdfFormBtn />
      <span className="ribbon-div" />
      {/* Acrobat: comments as a data file (XFDF / FDF), out and in */}
      <div className="rcol">
        <SmallBtn icon="export" label={t("pdftools.comments.exportXfdf")} onClick={() => void exportComments("xfdf")} />
        <SmallBtn icon="export" label={t("pdftools.comments.exportFdf")} onClick={() => void exportComments("fdf")} />
        <SmallBtn icon="upload" label={t("pdftools.comments.import")} onClick={() => void importComments()} />
      </div>
      <span className="ribbon-div" />
      <ToolStrip />
      <span className="ribbon-div" />
      <ContextArea />
      <SmallBtn icon="panelRight" label={t("review.tab")} onClick={() => useUI.getState().set({ rightOpen: true, rightTab: "review" })} />
    </div>
  );
}

function PdfPagesPanel() {
  const t = useT();
  useStore((s) => s.pageId);
  useStore((s) => s.doc.pages.length);
  return (
    <div className="rpanel">
      <Group label={t("topui.pdf.g.pages")}>
        <CmdBig id="page.organizer" icon="organize" label={t("topui.pdf.organize")} />
        <CmdBig id="file.importPages" icon="upload" />
        <div className="rcol">
          <CmdSmall id="page.duplicate" />
          <CmdSmall id="page.delete" />
        </div>
        <div className="rcol">
          <CmdSmall id="page.moveUp" />
          <CmdSmall id="page.moveDown" />
        </div>
        <div className="rcol">
          <CmdSmall id="page.rotateRight" />
          <CmdSmall id="page.rotateLeft" />
        </div>
      </Group>
      <Group label={t("topui.pdf.g.split")}>
        <CmdBig id="page.extract" icon="export" />
        <CmdBig id="page.split" icon="organize" />
      </Group>
      <Group label={t("docmode.pageSetup")}>
        <CmdBig id="page.setup" icon="doc" label={t("docmode.pageSetup")} />
      </Group>
    </div>
  );
}

function PdfProtectPanel() {
  const t = useT();
  return (
    <div className="rpanel">
      <Group label={t("topui.pdf.g.protect")}>
        {/* a PDF with a PDF password (standard AES-256), as Acrobat's Protect — not an Omniweave file (실사용 점검 2026-11-23 #80) */}
        <BigBtn icon="lock" label={t("cmd.file.saveProtected")} tip={t("topui.pdf.protectPdfTip")} onClick={() => { const s = useStore.getState(); const pg = findPage(s.doc, s.pageId); void exportAs(pg && sameTypeExport(pg, s.doc.pages) ? "same" : "pdf", true); }} />
        <BigBtn icon="export" label={t("size.menu")} tip={t("size.menuHint")} onClick={() => useUI.getState().set({ shellDialog: "sizePdf" })} />
      </Group>
      {/* Acrobat ▸ 보호 ▸ 가리기: also on the 도구 tab (ui/pdf/PdfTools.tsx) */}
      <Group label={t("pdftools.g.redact")}>
        <BigBtn icon="shield" label={t("pdftools.redact.area")} tip={t("pdftools.redact.areaTip")} onClick={() => setPdfTool("redact")} />
        <BigBtn icon="search" label={t("pdftools.redact.findBtn")} onClick={() => openPdfDialog("redact")} />
        <BigBtn icon="save" label={t("pdftools.pdfa.title")} onClick={() => openPdfDialog("pdfa")} />
      </Group>
      <span className="ctx-hint">{t("topui.pdf.protectHint")}</span>
    </div>
  );
}

function PdfViewPanel() {
  const t = useT();
  const ui = useUI();
  return (
    <div className="rpanel">
      <ViewModesGroup />
      <Group label={t("docmode.group.zoom")}>
        <BigBtn icon="zoomPage" label={t("docmode.onePage")} onClick={() => docZoom("page")} />
        <BigBtn icon="zoomWidth" label={t("docmode.pageWidth")} onClick={() => docZoom("width")} />
        <BigBtn icon="fit" label="100%" tip={t("cmd.view.actual")} kbd="Ctrl+1" onClick={() => docZoom("100")} />
        <div className="rcol">
          <SmallBtn icon="zoomIn" label={t("cmd.view.zoomIn")} kbd="Ctrl+=" onClick={() => zoomStep(1)} />
          <SmallBtn icon="minus" label={t("cmd.view.zoomOut")} kbd="Ctrl+-" onClick={() => zoomStep(-1)} />
        </div>
      </Group>
      <Group label={t("docmode.group.show")}>
        <div className="rcol">
          <label className="rcheck" data-tip={t("cmd.view.rulers")}>
            <input type="checkbox" checked={ui.rulers} onChange={toggleRulers} />
            <span>{t("docmode.ruler")}</span>
          </label>
          <label className="rcheck" data-tip={t("cmd.view.grid")}>
            <input type="checkbox" checked={ui.grid} onChange={toggleGrid} />
            <span>{t("docmode.gridlines")}</span>
          </label>
        </div>
      </Group>
      <Group label={t("docmode.group.panes")}>
        <BigBtn icon="pages" label={t("topui.pdf.pagesPane")} on={ui.leftOpen} onClick={() => ui.set({ leftOpen: !ui.leftOpen })} />
        <BigBtn icon="sliders" label={t("docmode.formatPane")} on={ui.rightOpen} onClick={() => ui.set({ rightOpen: !ui.rightOpen })} />
        <BigBtn icon="comment" label={t("review.tab")} on={ui.rightOpen && ui.rightTab === "review"} onClick={() => ui.set({ rightOpen: !(ui.rightOpen && ui.rightTab === "review"), rightTab: "review" })} />
      </Group>
    </div>
  );
}

export function PdfRibbon({ tab, ctx }: { tab: string; ctx: RibbonContext | null }) {
  const t = useT();
  return (
    <div className="ribbon doc-ribbon pdf-ribbon">
      <div className="rbody" role="tabpanel" aria-label={tab === "ctx" ? ctx?.label : t(`topui.tab.pdf.${tab}`)}>
        {tab === "pdf" ? (
          <PdfHomePanel />
        ) : tab === "comment" ? (
          <PdfCommentPanel />
        ) : tab === "pages" ? (
          <PdfPagesPanel />
        ) : tab === "tools" ? (
          <PdfToolsPanel />
        ) : tab === "protect" ? (
          <PdfProtectPanel />
        ) : tab === "view" ? (
          <PdfViewPanel />
        ) : (
          <CtxPanel ctx={ctx} />
        )}
      </div>
    </div>
  );
}
