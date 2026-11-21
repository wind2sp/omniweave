// Slide ribbon (docs/design/UI_TOP_REDESIGN.md §3, PowerPoint): 홈 · 삽입 · 디자인 · 전환 · 애니메이션 · 슬라이드 쇼 ·
// 보기, the contextual 도형 서식 / 그림 서식 / 표 tab, and ▶ 발표 at the right of the tab row (TopBar.tsx).
import { findPage, useStore } from "../../core/store";
import type { Page, TransitionType } from "../../core/types";
import { useT } from "../../i18n";
import { setPageProps } from "../actions";
import { toggleGrid, toggleGuides, toggleRulers } from "../aids";
import { useSlideUI } from "../slideActions";
import { ColorField, Menu, NumField, Select } from "./controls";
import { BigBtn, CmdBig, CmdSmall, CtxPanel, Group, HomePanel, SmallBtn, run } from "./DocRibbon";
import { Icon } from "./Icons";
import { pageLive, zoomStep } from "./ops";
import { TRANSITIONS } from "./Ribbon";
import type { RibbonContext } from "./ribbonContext";
import { ChartDataButton, SlideStructureTools } from "./SlideMode";
import { useUI } from "./uiStore";

const S = () => useStore.getState();

function SlideGroup({ page }: { page: Page }) {
  const t = useT();
  return (
    <Group label={t("topui.slide.g.slides")}>
      <div className="rrow rrow-wrap">
        <SlideStructureTools page={page} />
      </div>
    </Group>
  );
}

function InsertPanel() {
  const t = useT();
  useStore((s) => s.pageId);
  return (
    <div className="rpanel">
      <Group label={t("topui.slide.g.slides")}>
        <CmdBig id="slide.new" icon="slide" />
        <CmdSmall id="insert.slidePage" />
      </Group>
      <Group label={t("docmode.group.tables")}>
        <CmdBig id="insert.table" icon="table" />
      </Group>
      <Group label={t("docmode.group.illustrations")}>
        <CmdBig id="insert.image" icon="image" />
        <Menu
          className="rbig"
          tip={t("docmode.shapesTip")}
          button={
            <>
              <Icon name="rect" size={20} />
              <span>{t("docmode.shapes")}</span>
            </>
          }
          items={[
            { label: t("ribbon.tool.rect"), icon: "rect", onSelect: () => run("insert.rect") },
            { label: t("ribbon.tool.ellipse"), icon: "ellipse", onSelect: () => run("insert.ellipse") },
            { label: t("ribbon.tool.pen"), icon: "pen", onSelect: () => run("insert.pen") },
          ]}
        />
        <ChartDataButton />
      </Group>
      <Group label={t("docmode.group.text")}>
        <CmdBig id="insert.text" icon="textBox" />
        <CmdBig id="insert.symbol" icon="symbol" />
      </Group>
      <Group label={t("menu.head.media")}>
        <CmdBig id="insert.media" icon="media" />
        <CmdSmall id="file.importPages" />
      </Group>
    </div>
  );
}

function DesignPanel({ page }: { page: Page }) {
  const t = useT();
  return (
    <div className="rpanel">
      <Group label={t("topui.slide.g.customize")}>
        <CmdBig id="page.setup" icon="doc" label={t("topui.slide.size")} />
        <div className="rcol">
          <ColorField label={t("ribbon.page.background")} tip={t("ribbon.page.bgTip")} value={page.background} live={pageLive<string>((p, v) => (p.background = v), t("ribbon.page.bgUndo"))} />
        </div>
      </Group>
      <Group label={t("topui.slide.g.master")}>
        <CmdBig id="page.addMaster" icon="master" />
        <CmdSmall id="page.properties" />
      </Group>
    </div>
  );
}

function TransitionsPanel({ page }: { page: Page }) {
  const t = useT();
  return (
    <div className="rpanel">
      <Group label={t("ribbon.slide.transition")}>
        <div className="rcol">
          <Select<TransitionType> icon="transition" tip={t("ribbon.slide.transition")} value={page.transition.type} options={TRANSITIONS} width={150} onChange={(v) => setPageProps({ transition: { ...page.transition, type: v } })} />
          <NumField icon="clock" tip={t("ribbon.slide.duration")} value={page.transition.duration} min={0} max={5000} step={50} unit="ms" width={110} disabled={page.transition.type === "NONE"} live={pageLive<number>((p, v) => (p.transition = { ...page.transition, duration: v }), t("ribbon.slide.duration"))} />
        </div>
      </Group>
      <Group label={t("topui.slide.g.timing")}>
        <BigBtn
          icon="check"
          label={t("ribbon.slide.applyAll")}
          tip={t("ribbon.slide.applyAllTip")}
          onClick={() =>
            S().commit(t("ribbon.slide.applyAllUndo"), (d) => {
              d.pages.forEach((p) => p.kind === "SLIDE" && (p.transition = { ...page.transition }));
            })
          }
        />
        <CmdBig id="slide.transition" icon="sliders" />
      </Group>
    </div>
  );
}

function AnimationsPanel({ page }: { page: Page }) {
  const t = useT();
  return (
    <div className="rpanel">
      <Group label={t("ribbon.slide.anim")}>
        <BigBtn icon="sparkle" label={page.animations.length ? t("ribbon.slide.animCount", { n: page.animations.length }) : t("ribbon.slide.anim")} tip={t("ribbon.slide.animTip")} onClick={() => run("slide.animation")} />
      </Group>
      <span className="ctx-hint">{t("topui.slide.animHint")}</span>
    </div>
  );
}

function ShowPanel() {
  const t = useT();
  return (
    <div className="rpanel">
      <Group label={t("topui.slide.g.start")}>
        <CmdBig id="slide.showFromStart" icon="play" />
        <CmdBig id="slide.showFromCurrent" icon="play" />
      </Group>
    </div>
  );
}

function ViewPanel() {
  const t = useT();
  const ui = useUI();
  const sorter = useSlideUI((s) => s.sorter);
  const notes = useSlideUI((s) => s.notes);
  return (
    <div className="rpanel">
      <Group label={t("topui.slide.g.views")}>
        <BigBtn icon="slide" label={t("topui.slide.normal")} on={!sorter} onClick={() => useSlideUI.setState({ sorter: false })} />
        <BigBtn icon="pages" label={t("topui.slide.sorter")} on={sorter} onClick={() => useSlideUI.setState({ sorter: true })} />
        <BigBtn icon="text" label={t("topui.slide.notes")} on={notes} onClick={() => useSlideUI.setState({ notes: !notes })} />
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
          <label className="rcheck" data-tip={t("cmd.view.guides")}>
            <input type="checkbox" checked={ui.guides} onChange={toggleGuides} />
            <span>{t("cmd.view.guides")}</span>
          </label>
        </div>
      </Group>
      <Group label={t("docmode.group.zoom")}>
        <CmdBig id="view.fit" icon="fit" />
        <div className="rcol">
          <SmallBtn icon="zoomIn" label={t("cmd.view.zoomIn")} kbd="Ctrl+=" onClick={() => zoomStep(1)} />
          <SmallBtn icon="minus" label={t("cmd.view.zoomOut")} kbd="Ctrl+-" onClick={() => zoomStep(-1)} />
        </div>
      </Group>
      <Group label={t("docmode.group.panes")}>
        <BigBtn icon="layers" label={t("cmd.view.layersPanel")} on={ui.leftOpen && ui.leftTab === "layers"} onClick={() => run("view.layersPanel")} />
        <BigBtn icon="sliders" label={t("docmode.formatPane")} on={ui.rightOpen} onClick={() => ui.set({ rightOpen: !ui.rightOpen })} />
      </Group>
    </div>
  );
}

export function SlideRibbon({ tab, ctx }: { tab: string; ctx: RibbonContext | null }) {
  const t = useT();
  const page = useStore((s) => findPage(s.doc, s.pageId));
  if (!page) return <div className="ribbon doc-ribbon slide-ribbon" />;
  return (
    <div className="ribbon doc-ribbon slide-ribbon">
      <div className="rbody" role="tabpanel" aria-label={tab === "ctx" ? ctx?.label : t(`topui.tab.slide.${tab}`)}>
        {tab === "home" ? (
          <HomePanel slide={<SlideGroup page={page} />} />
        ) : tab === "insert" ? (
          <InsertPanel />
        ) : tab === "design" ? (
          <DesignPanel page={page} />
        ) : tab === "transitions" ? (
          <TransitionsPanel page={page} />
        ) : tab === "animations" ? (
          <AnimationsPanel page={page} />
        ) : tab === "show" ? (
          <ShowPanel />
        ) : tab === "view" ? (
          <ViewPanel />
        ) : (
          <CtxPanel ctx={ctx} />
        )}
      </div>
    </div>
  );
}
