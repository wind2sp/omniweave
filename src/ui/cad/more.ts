// The rest of the drawing screen's commands (moreDraw · moreEdit · moreBlock · moreDim) and AutoCAD's acad.pgp:
// every alias of the stock acad.pgp runs the command AutoCAD runs — or, for a command the drawing screen does not
// have (3D, rendering, sheet sets …), says so by name instead of running another (QA bux2 2026-11-24: E ran EXTEND).

import { t } from "../../i18n";
import { COMMANDS, OPT_KEY, registerCommands, run as runCmd, type Cmd } from "./engine";
import { extraCommands } from "../commands";
import { cadScreenNow } from "../editModes";
import { BLOCKS } from "./moreBlock";
import { DIMS } from "./moreDim";
import { DRAW } from "./moreDraw";
import { EDIT } from "./moreEdit";
import { PLOT } from "./plot";
import { LAYOUTS } from "./layout";
import { EXTRA } from "./moreExtra";

/** AutoCAD's stock acad.pgp (2D and general aliases, and the 3D ones so they are named): alias → command. */
export const ACAD_PGP: Record<string, string> = {
  "3A": "3DARRAY", "3DMIRROR": "MIRROR3D", "3DNavigate": "3DWALK", "3DO": "3DORBIT", "3DW": "3DWALK", "3F": "3DFACE", "3M": "3DMOVE", "3P": "3DPOLY", "3R": "3DROTATE", "3S": "3DSCALE",
  A: "ARC", AC: "BACTION", ADC: "ADCENTER", AECTOACAD: "-ExportToAutoCAD", AA: "AREA", AL: "ALIGN", "3AL": "3DALIGN", AP: "APPLOAD", APLAY: "ALLPLAY", AR: "ARRAY", "-AR": "-ARRAY",
  ARR: "ACTRECORD", ARM: "ACTUSERMESSAGE", "-ARM": "-ACTUSERMESSAGE", ARU: "ACTUSERINPUT", ARS: "ACTSTOP", "-ARS": "-ACTSTOP", ATI: "ATTIPEDIT", ATT: "ATTDEF", "-ATT": "-ATTDEF",
  ATE: "ATTEDIT", "-ATE": "-ATTEDIT", ATTE: "-ATTEDIT", B: "BLOCK", "-B": "-BLOCK", BC: "BCLOSE", BE: "BEDIT", BH: "HATCH", BO: "BOUNDARY", "-BO": "-BOUNDARY", BR: "BREAK",
  BS: "BSAVE", BVS: "BVSTATE", C: "CIRCLE", CAM: "CAMERA", CBAR: "CONSTRAINTBAR", CH: "PROPERTIES", "-CH": "CHANGE", CHA: "CHAMFER", CHK: "CHECKSTANDARDS", CLI: "COMMANDLINE",
  COL: "COLOR", COLOUR: "COLOR", CO: "COPY", CP: "COPY", CPARAM: "BCPARAMETER", CREASE: "MESHCREASE", CSETTINGS: "CONSTRAINTSETTINGS", CT: "CTABLESTYLE", CUBE: "NAVVCUBE",
  CURVATUREANALYSIS: "ANALYSISCURVATURE", CYL: "CYLINDER", D: "DIMSTYLE", DAN: "DIMANGULAR", DAR: "DIMARC", DBA: "DIMBASELINE", DBC: "DBCONNECT", DC: "ADCENTER", DCE: "DIMCENTER",
  DCENTER: "ADCENTER", DCO: "DIMCONTINUE", DCON: "DIMCONSTRAINT", DDA: "DIMDISASSOCIATE", DDI: "DIMDIAMETER", DED: "DIMEDIT", DELCON: "DELCONSTRAINT", DI: "DIST", DIV: "DIVIDE",
  DJL: "DIMJOGLINE", DJO: "DIMJOGGED", DL: "DATALINK", DLI: "DIMLINEAR", DLU: "DATALINKUPDATE", DO: "DONUT", DOR: "DIMORDINATE", DOV: "DIMOVERRIDE", DR: "DRAWORDER",
  DRA: "DIMRADIUS", DRE: "DIMREASSOCIATE", DRM: "DRAWINGRECOVERY", DS: "DSETTINGS", DT: "TEXT", DV: "DVIEW", DX: "DATAEXTRACTION", E: "ERASE", ED: "TEXTEDIT", EL: "ELLIPSE",
  EPDF: "EXPORTPDF", ER: "EXTERNALREFERENCES", ESHOT: "EDITSHOT", EX: "EXTEND", EXIT: "QUIT", EXP: "EXPORT", EXT: "EXTRUDE", F: "FILLET", FI: "FILTER", FREEPOINT: "POINTLIGHT",
  FSHOT: "FLATSHOT", G: "GROUP", "-G": "-GROUP", GCON: "GEOCONSTRAINT", GD: "GRADIENT", GENERATESECTION: "SECTIONPLANETOBLOCK", GEO: "GEOGRAPHICLOCATION", GR: "DDGRIPS",
  H: "HATCH", "-H": "-HATCH", HE: "HATCHEDIT", HB: "HATCHTOBACK", HI: "HIDE", I: "INSERT", "-I": "-INSERT", IAD: "IMAGEADJUST", IAT: "IMAGEATTACH", ICL: "IMAGECLIP",
  ID: "ID", IM: "IMAGE", "-IM": "-IMAGE", IMP: "IMPORT", IN: "INTERSECT", INF: "INTERFERE", IO: "INSERTOBJ", ISOLATE: "ISOLATEOBJECTS", QVD: "QVDRAWING", QVDC: "QVDRAWINGCLOSE",
  QVL: "QVLAYOUT", QVLC: "QVLAYOUTCLOSE", J: "JOIN", JOGSECTION: "SECTIONPLANEJOG", L: "LINE", LA: "LAYER", "-LA": "-LAYER", LAS: "LAYERSTATE", LE: "QLEADER", LEN: "LENGTHEN",
  LESS: "MESHSMOOTHLESS", LI: "LIST", LINEWEIGHT: "LWEIGHT", LMAN: "LAYERSTATE", LO: "-LAYOUT", LS: "LIST", LT: "LINETYPE", "-LT": "-LINETYPE", LTYPE: "LINETYPE",
  "-LTYPE": "-LINETYPE", LTS: "LTSCALE", LW: "LWEIGHT", M: "MOVE", MA: "MATCHPROP", MAT: "MATERIALS", ME: "MEASURE", MEA: "MEASUREGEOM", MI: "MIRROR", ML: "MLINE",
  MLA: "MLEADERALIGN", MLC: "MLEADERCOLLECT", MLD: "MLEADER", MLE: "MLEADEREDIT", MLS: "MLEADERSTYLE", MO: "PROPERTIES", MORE: "MESHSMOOTHMORE", MOTION: "NAVSMOTION",
  MOTIONCLS: "NAVSMOTIONCLOSE", MS: "MSPACE", MSM: "MARKUP", MT: "MTEXT", MV: "MVIEW", NETWORK: "SURFNETWORK", NORTH: "GEOGRAPHICLOCATION", NORTHDIR: "GEOGRAPHICLOCATION",
  NSHOT: "NEWSHOT", NVIEW: "NEWVIEW", O: "OFFSET", OFFSETSRF: "SURFOFFSET", OP: "OPTIONS", ORBIT: "3DORBIT", OS: "OSNAP", "-OS": "-OSNAP", P: "PAN", "-P": "-PAN",
  PA: "PASTESPEC", RAPIDPROTOTYPE: "3DPRINT", PAR: "PARAMETERS", "-PAR": "-PARAMETERS", PARAM: "BPARAMETER", PATCH: "SURFPATCH", PCATTACH: "POINTCLOUDATTACH",
  PE: "PEDIT", PL: "PLINE", PO: "POINT", POFF: "HIDEPALETTES", POL: "POLYGON", PON: "SHOWPALETTES", PR: "PROPERTIES", PRCLOSE: "PROPERTIESCLOSE", PROPS: "PROPERTIES",
  PRE: "PREVIEW", PRINT: "PLOT", PS: "PSPACE", PSOLID: "POLYSOLID", PTW: "PUBLISHTOWEB", PU: "PURGE", "-PU": "-PURGE", PYR: "PYRAMID", QC: "QUICKCALC", QCUI: "QUICKCUI",
  QP: "QUICKPROPERTIES", R: "REDRAW", RA: "REDRAWALL", RC: "RENDERCROP", RE: "REGEN", REA: "REGENALL", REC: "RECTANG", REG: "REGION", REN: "RENAME", "-REN": "-RENAME",
  REV: "REVOLVE", RO: "ROTATE", RP: "RENDERPRESETS", RR: "RENDER", RW: "RENDERWINDOW", S: "STRETCH", SC: "SCALE", SCR: "SCRIPT", SEC: "SECTION", SET: "SETVAR",
  SHA: "SHADEMODE", SL: "SLICE", SMOOTH: "MESHSMOOTH", SN: "SNAP", SO: "SOLID", SP: "SPELL", SPL: "SPLINE", SPLANE: "SECTIONPLANE", SPLAY: "SEQUENCEPLAY", SPLIT: "MESHSPLIT",
  SPE: "SPLINEDIT", SSM: "SHEETSET", ST: "STYLE", STA: "STANDARDS", SU: "SUBTRACT", T: "MTEXT", "-T": "-MTEXT", TA: "TABLET", TB: "TABLE", TEDIT: "TEXTEDIT", TH: "THICKNESS",
  TI: "TILEMODE", TO: "TOOLBAR", TOL: "TOLERANCE", TOR: "TORUS", TP: "TOOLPALETTES", TR: "TRIM", TS: "TABLESTYLE", UC: "UCSMAN", UN: "UNITS", "-UN": "-UNITS", UNCREASE: "MESHUNCREASE",
  UNHIDE: "UNISOLATEOBJECTS", UNI: "UNION", UNISOLATE: "UNISOLATEOBJECTS", V: "VIEW", "-V": "-VIEW", VGO: "VIEWGO", VP: "DDVPOINT", "-VP": "VPOINT", VPLAY: "VIEWPLAY",
  VS: "VSCURRENT", VSM: "VISUALSTYLES", "-VSM": "-VISUALSTYLES", W: "WBLOCK", "-W": "-WBLOCK", WE: "WEDGE", WHEEL: "NAVSWHEEL", X: "EXPLODE", XA: "XATTACH", XB: "XBIND",
  "-XB": "-XBIND", XC: "XCLIP", XL: "XLINE", XR: "XREF", "-XR": "-XREF", Z: "ZOOM", ZEBRA: "ANALYSISZEBRA",
};

/** Commands under other names that the drawing screen runs as one of its own (AutoCAD's own synonyms). */
const SAME: Record<string, string> = {
  "-ARRAY": "ARRAY", "-ATTDEF": "ATTDEF", "-ATTEDIT": "ATTEDIT", "-BLOCK": "BLOCK", "-HATCH": "HATCH", "-INSERT": "INSERT", "-LAYER": "LAYER", "-PAN": "PAN", "-PURGE": "PURGE",
  "-UNITS": "UNITS", "-LAYOUT": "LAYOUT", "-VPORTS": "MVIEW", VPORTS: "MVIEW", "-MTEXT": "MTEXT", "-OSNAP": "OSNAP", DDEDIT: "TEXTEDIT", REGENALL: "REGEN", REDRAWALL: "REDRAW", BHATCH: "HATCH", QUICKPROPERTIES: "PROPERTIES",
  PROPERTIESCLOSE: "PROPERTIES", ISOLATEOBJECTS: "LAYISO", UNISOLATEOBJECTS: "LAYUNISO", EXPORTPDF: "PLOT", MEASUREGEOM: "DIST", OOPS: "U", LAYERP: "U",
};

/** All the commands, keyed by AutoCAD's name. */
const MORE: Record<string, () => Cmd> = { ...DRAW, ...EDIT, ...BLOCKS, ...DIMS, ...LAYOUTS, ...EXTRA };


registerCommands({ ...MORE, PLOT }, {}, {});
// option letters as AutoCAD shows them
Object.assign(OPT_KEY, {
  open: "O", join: "J", width: "W", fit: "F", spline: "S", decurve: "D", delta: "DE", percent: "P", total: "T", distance: "D", first: "F", edge: "E", inscribed: "I",
  circumscribed: "C", selObjects: "S", hpattern: "P", hscale: "SC", hangle: "A", rect: "R", path: "PA", polar: "PO", rotateOpt: "R", scaleOpt: "S", height: "H", font: "F",
  wfactor: "W", dtxt: "T", dasz: "A", ddec: "D", dscale: "S", hor: "H", ver: "V", uMm: "MM", uCm: "CM", uM: "M", uIn: "I", uFt: "F", uNone: "U", lsSave: "S", lsRestore: "R", lsList: "?", aeCols: "COL", aeRows: "R", aeDx: "DX", aeDy: "DY", aeCount: "I", aeFill: "F", xrReload: "R", xrList: "?", landscape: "L", portrait: "P", display: "D", fitPaper: "F", loNew: "N", loList: "?",
});
// aliases: acad.pgp, then AutoCAD's synonyms; a target the drawing screen lacks is named as such
const aliases: Record<string, string> = {};
const missing: Record<string, string> = {};
for (const [a, cmd] of Object.entries({ ...ACAD_PGP, ...SAME })) {
  const c = cmd.toUpperCase();
  const to = COMMANDS[c] ? c : SAME[c] && COMMANDS[SAME[c]] ? SAME[c] : null;
  if (to) aliases[a.toUpperCase()] = to;
  else missing[a.toUpperCase()] = c;
}
for (const c of new Set(Object.values(ACAD_PGP).map((x) => x.toUpperCase()))) if (!COMMANDS[c] && !aliases[c]) missing[c] = c;
// the drawing screen's own extras
Object.assign(aliases, { DEL: "ERASE", DTEXT: "TEXT", RECTANGLE: "RECTANG", UNDO: "U", ARRAYCLASSIC: "ARRAY", LAYMRG: undefined as any });
delete aliases.LAYMRG;
registerCommands({}, aliases, missing);

// 명령 찾기 (Alt+Q) finds the drawing screen's commands by Korean name, AutoCAD name or alias while a drawing is shown
extraCommands.push(() =>
  cadScreenNow()
    ? Object.keys(COMMANDS)
        .filter((c) => !["GRIP", "REDO", "U"].includes(c))
        .map((c) => {
          const al = Object.entries(ACAD_PGP).filter(([, v]) => v === c).map(([a]) => a).filter((a) => !a.startsWith("-")).slice(0, 3);
          return { id: `cad.${c}`, label: () => `${t(`cadui.cmd.${c}`, undefined, c)} (${[c, ...al].join(" · ")})`, run: () => void runCmd(c) };
        })
    : [],
);

/** The command each alias now resolves to (tests). */
export const pgpTargets = () => ({ aliases, missing });
export const commandTitle = (c: string) => t(`cadui.cmd.${c}`, undefined, t(`cadui.cmd.${c}`, undefined, c));
