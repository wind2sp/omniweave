// Work-mode switch — the one place that says "how am I editing" and "what is this page" (docs/design/SHELL_LAYOUT.md §12).
//
//   [◎ 자동] │ [▤ 문서] [▷ 슬라이드] [▨ 이미지] [⌒ 디자인]
//
// · the chosen mode is selected (accent fill + accent edge, the only blue in the command bar besides the main action);
// · a short bar under one of the four marks *this page's kind* — the way 자동 edits it. Under 자동 that is the mode in
//   use; under a manual mode it shows only when the page is of another kind ("this is a document page, edited as design").
// The menus to its left are a list of commands; this is a state switch, so it looks like one: a framed segment with
// icons, set apart from the menus by space and a divider. It never moves with the ribbon below.
import type { Mode } from "../../core/store";
import { findPage, useStore } from "../../core/store";
import { t, useT } from "../../i18n";
import { editModeOf, fixedFormatOf, useCadScreen, useEditMode, type EditMode } from "../editModes";
import { Menu, cx } from "./controls";
import { kbdFor } from "../keymap";
import { Icon, type IconName } from "./Icons";

/** Work modes in switch order; Ctrl+Shift+1…5 picks them (shell/shortcuts.ts). */
export const MODES: Mode[] = ["AUTO", "DOCUMENT", "SLIDE", "IMAGE", "DESIGN"];

/** The shared mode / page-kind icons (Icons.tsx "mode*"). */
export const MODE_ICON: Record<Mode, IconName> = { AUTO: "modeAuto", DOCUMENT: "modeDoc", SLIDE: "modeSlide", IMAGE: "modeImage", DESIGN: "modeDesign" };

/** Ctrl+Shift+1…5 — not in a sheet grid, where they are Excel's number formats (keymap.ts SHEET rows): no mode key there. */
export const modeKbd = (m: Mode): string | undefined => kbdFor(`mode.${m}`);

export function setWorkMode(m: Mode) {
  const s = useStore.getState();
  // a PDF / a drawing on the drawing screen keeps its tabs whatever the work mode (fixedFormatOf): a work mode key or
  // command search there would change nothing visible — say why instead of switching silently
  const fixed = fixedFormatOf(findPage(s.doc, s.pageId));
  if (fixed && m !== "AUTO") return s.notify(t(`topui.fixedTip.${fixed}`));
  if (s.mode !== m) s.set({ mode: m });
}

/** The kind of the current page as 자동 reads it (its source format, kind and content). */
export function usePageKindMode(): EditMode {
  return useStore((s) => editModeOf("AUTO", findPage(s.doc, s.pageId)));
}

/**
 * How the switch is drawn (docs/design/UI_TOP_REDESIGN.md, 제품 결정 2026-11-20: all five stay visible; only a window too
 * narrow for them shrinks them): full = icon and name, icons = icons only (names in the tips), menu = one
 * '작업 방식 ▾' button with the five in a drop-down.
 */
export type ModeSwitchForm = "full" | "icons" | "menu";

/** The fixed mark a PDF page or a drawing shows instead of the switch (its format decides the tabs). */
function FixedMode({ kind }: { kind: "PDF" | "CAD" }) {
  const t = useT();
  return (
    <div className="mode-fixed" role="status" aria-label={`${t("shell.workMode")}: ${t(`topui.fixed.${kind}`)}`} data-tip={t(`topui.fixedTip.${kind}`)}>
      <Icon name={kind === "PDF" ? "pdf" : "modeDraw"} size={15} />
      <span>{t(`topui.fixed.${kind}`)}</span>
    </div>
  );
}

export function ModeSwitch({ form = "full" }: { form?: ModeSwitchForm }) {
  const t = useT();
  const mode = useStore((s) => s.mode);
  const eff = useEditMode();
  const native = usePageKindMode();
  // a drawing page (DXF / DWG) on the drawing screen: the design slot reads 도면 with its own icon (CAD_SCREEN.md §1)
  const drawingPage = useStore((s) => !!findPage(s.doc, s.pageId)?.source?.cad);
  const cadOn = useCadScreen((s) => s.on);
  const drawing = drawingPage && cadOn;
  // re-read when the drawing screen is turned on / off (cadOn above subscribes to it)
  const fixed = useStore((s) => fixedFormatOf(findPage(s.doc, s.pageId)));
  const kindName = (m: EditMode) => (m === "DESIGN" && drawing ? t("cadui.mode") : t(`shell.mode.${m}`));
  if (fixed) return <FixedMode kind={fixed} />;
  if (form === "menu")
    return (
      <Menu
        className="mode-menu-btn"
        tip={t("shell.workMode")}
        align="right"
        button={
          <>
            <span className="mode-menu-cap">{t("topui.workStyle")}</span>
            <Icon name={MODE_ICON[mode]} size={15} />
            <span className="mode-label">{t(`shell.mode.${mode}`)}</span>
            <Icon name="chevron" size={11} />
          </>
        }
        items={() =>
          MODES.map((m) => ({
            label: m === "AUTO" && mode === "AUTO" ? `${t("shell.mode.AUTO")} · ${kindName(eff)}` : t(`shell.mode.${m}`),
            icon: mode === m ? undefined : MODE_ICON[m],
            checked: mode === m,
            kbd: modeKbd(m),
            onSelect: () => setWorkMode(m),
          }))
        }
      />
    );
  return (
    <div className={cx("mode-switch", form === "icons" && "mode-icons")} role="radiogroup" aria-label={t("shell.workMode")}>
      {MODES.map((m) => {
        const on = mode === m;
        // the page-kind mark: under 자동 = the mode in use; under a manual mode only when the page is of another kind
        const kind = m !== "AUTO" && m === native && !on;
        let tip = m === "DESIGN" && drawing ? t("cadui.modeTip") : t(`shell.modeTip.${m}`);
        if (m === "AUTO" && on) tip = t("modeswitch.autoOn", { mode: kindName(eff) });
        else if (kind) tip = `${tip} · ${mode === "AUTO" ? t("modeswitch.autoUses", { mode: kindName(m) }) : t("modeswitch.pageIs", { mode: kindName(m) })}`;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={form === "icons" ? t(`shell.mode.${m}`) : undefined}
            aria-description={kind ? t("modeswitch.pageIs", { mode: kindName(m) }) : undefined}
            className={cx("mode-btn", on && "on", kind && "kind", kind && mode === "AUTO" && "auto-eff", m === "AUTO" && "mode-auto")}
            data-tip={tip}
            data-kbd={modeKbd(m)}
            onClick={() => setWorkMode(m)}
          >
            <Icon name={m === "DESIGN" && drawing ? "modeDraw" : MODE_ICON[m]} size={16} />
            <span className="mode-label">{m === "DESIGN" && drawing ? t("cadui.mode") : t(`shell.mode.${m}`)}</span>
          </button>
        );
      })}
    </div>
  );
}
