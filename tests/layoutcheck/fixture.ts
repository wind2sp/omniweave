// A small HWPX package shaped like what Hangul saves ("Omni 분기 보고서"), with hp:linesegarray, for the
// layout-check unit tests. Our own exporter writes no lineseg, so this one is written by hand.

import { strToU8, zipSync } from "fflate";

const NS = `xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"`;

export const seg = (textpos: number, vertpos: number, opts: { size?: number; pitch?: number; horzpos?: number; horzsize?: number } = {}) => {
  const size = opts.size ?? 1000, pitch = opts.pitch ?? 1.6;
  return `<hp:lineseg textpos="${textpos}" vertpos="${vertpos}" vertsize="${size}" textheight="${size}" baseline="${size * 0.85}" spacing="${Math.round(size * (pitch - 1))}" horzpos="${opts.horzpos ?? 0}" horzsize="${opts.horzsize ?? 42520}" flags="393216"/>`;
};
export const segs = (...s: string[]) => `<hp:linesegarray>${s.join("")}</hp:linesegarray>`;

/**
 * header.xml. `left` / `intent` are the values written unwrapped and in hp:default (hp:case gets half — the
 * measured meaning is: case = HWPUNIT, unwrapped = HWPUNIT, default = 2× HWPUNIT). With `hwpUnitChar`, margins and line spacing sit
 * in hp:switch like Hangul 2014+ writes them: hp:case (HwpUnitChar namespace) holds the plain HWPUNIT value
 * (half), hp:default the doubled one — both branches as in qa/interop/adobe-made/hwpx_doc.hwpx.
 */
export function header(opts: { breakNonLatin?: string; condense?: number; left?: number; intent?: number; ratio?: number; spacing?: number; hwpUnitChar?: boolean } = {}) {
  const r = opts.ratio ?? 100, sp = opts.spacing ?? 0;
  const margin = (k: number) =>
    `<hh:margin><hc:intent value="${(opts.intent ?? 0) / k}" unit="HWPUNIT"/><hc:left value="${(opts.left ?? 0) / k}" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="0" unit="HWPUNIT"/><hc:next value="0" unit="HWPUNIT"/></hh:margin>` +
    `<hh:lineSpacing type="PERCENT" value="160" unit="HWPUNIT"/>`;
  const marginXml = opts.hwpUnitChar
    ? `<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">${margin(2)}</hp:case><hp:default>${margin(1)}</hp:default></hp:switch>`
    : margin(1);
  const langs = (v: number) => `hangul="${v}" latin="${v}" hanja="${v}" japanese="${v}" other="${v}" symbol="${v}" user="${v}"`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?><hh:head ${NS}><hh:refList>` +
    `<hh:fontfaces><hh:fontface lang="HANGUL" fontCnt="1"><hh:font id="0" face="Omni Batang" type="TTF"/></hh:fontface>` +
    `<hh:fontface lang="LATIN" fontCnt="1"><hh:font id="0" face="Omni Batang" type="TTF"/></hh:fontface></hh:fontfaces>` +
    `<hh:charProperties itemCnt="1"><hh:charPr id="0" height="1000" textColor="#000000" shadeColor="none"><hh:fontRef ${langs(0)}/><hh:ratio ${langs(r)}/><hh:spacing ${langs(sp)}/><hh:relSz ${langs(100)}/></hh:charPr></hh:charProperties>` +
    `<hh:paraProperties itemCnt="1"><hh:paraPr id="0" tabPrIDRef="0" condense="${opts.condense ?? 0}"><hh:align horizontal="JUSTIFY" vertical="BASELINE"/>` +
    `<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="${opts.breakNonLatin ?? "KEEP_WORD"}" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>` +
    marginXml +
    `</hh:paraPr></hh:paraProperties>` +
    `</hh:refList></hh:head>`
  );
}

export const p = (body: string, lineseg = "", attrs = "") => `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"${attrs}>${body}${lineseg}</hp:p>`;
export const run = (inner: string) => `<hp:run charPrIDRef="0">${inner}</hp:run>`;
export const t = (s: string) => `<hp:t>${s}</hp:t>`;

export const SEC_PR = `<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000"><hp:pagePr landscape="WIDELY" width="59528" height="84186" gutterType="LEFT_ONLY"><hp:margin header="4252" footer="4252" gutter="0" left="8504" right="8504" top="5668" bottom="4252"/></hp:pagePr></hp:secPr>`;

export function hwpx(paras: string[], head = header()): Uint8Array {
  return zipSync({
    mimetype: strToU8("application/hwp+zip"),
    "version.xml": strToU8(`<?xml version="1.0"?><hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" application="Hancom Office Hangul"/>`),
    "Contents/header.xml": strToU8(head),
    "Contents/section0.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><hs:sec ${NS}>${paras.join("")}</hs:sec>`),
  });
}
