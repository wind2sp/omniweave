// The Acrobat tools as commands (command search, menus, keys — keymap.ts PDF rows). Labels: cmd.<id>.
import type { Command } from "../commands";
import { useStore } from "../../core/store";
import { isPdfPage } from "../ribbonTabs";
import { openPdfDialog, setPdfTool, usePdfTools } from "./pdfToolsStore";

const onPdf = () => {
  const s = useStore.getState();
  return isPdfPage(s.doc.pages.find((p) => p.id === s.pageId));
};

export const PDF_TOOL_COMMANDS: Command[] = [
  { id: "pdf.redactArea", icon: "shield", when: onPdf, checked: () => usePdfTools.getState().tool === "redact", run: () => setPdfTool("redact") },
  { id: "pdf.redact", icon: "shield", dialog: true, when: onPdf, run: () => openPdfDialog("redact") },
  { id: "pdf.watermark", icon: "sparkle", dialog: true, when: onPdf, run: () => openPdfDialog("watermark") },
  { id: "pdf.headerFooter", icon: "header", dialog: true, when: onPdf, run: () => openPdfDialog("headerFooter") },
  { id: "pdf.background", icon: "paper", dialog: true, when: onPdf, run: () => openPdfDialog("background") },
  { id: "pdf.bookmarks", icon: "outline", dialog: true, when: onPdf, run: () => openPdfDialog("bookmarks") },
  { id: "pdf.link", icon: "link", when: onPdf, checked: () => usePdfTools.getState().tool === "link", run: () => setPdfTool("link") },
  { id: "pdf.pageLabels", icon: "pageNum", dialog: true, when: onPdf, run: () => openPdfDialog("labels") },
  { id: "pdf.formField", icon: "textBox", when: onPdf, checked: () => usePdfTools.getState().tool === "field", run: () => setPdfTool("field") },
  { id: "pdf.formDetect", icon: "wand", dialog: true, when: onPdf, run: () => openPdfDialog("detect") },
  { id: "pdf.replacePages", icon: "swapArrows", dialog: true, when: onPdf, run: () => openPdfDialog("replace") },
  { id: "pdf.crop", icon: "crop", dialog: true, when: onPdf, run: () => openPdfDialog("crop") },
  { id: "pdf.replacePicture", icon: "image", when: onPdf, checked: () => usePdfTools.getState().tool === "picture", run: () => setPdfTool("picture") },
  { id: "pdf.pdfa", icon: "save", dialog: true, when: onPdf, run: () => openPdfDialog("pdfa") },
  { id: "pdf.compare", icon: "doc", dialog: true, when: onPdf, run: () => openPdfDialog("compare") },
  // Acrobat's keys: Ctrl+Shift+N 페이지로 이동, Ctrl+D 문서 속성, Ctrl+Shift+R 페이지 회전
  { id: "pdf.goToPage", icon: "pages", dialog: true, when: () => useStore.getState().doc.pages.length > 0, run: () => openPdfDialog("goto") },
  { id: "pdf.docProps", icon: "info", dialog: true, when: onPdf, run: () => openPdfDialog("props") },
  { id: "pdf.rotatePages", icon: "rotate", dialog: true, when: () => useStore.getState().doc.pages.length > 0, run: () => openPdfDialog("rotate") },
];
