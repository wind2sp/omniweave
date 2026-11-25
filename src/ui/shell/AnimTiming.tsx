// 애니메이션 › 타이밍 (PowerPoint's Timing group): 시작, 재생 시간 and 지연 of the selected object's effects, set on the
// ribbon as in PowerPoint instead of only on the rows of the animation pane (RightDock AnimTab).
import { animDuration } from "../../core/anim";
import { draftPage, findPage, useStore } from "../../core/store";
import type { AnimTrigger, KeyframeAnimation } from "../../core/types";
import { useT, t as tx } from "../../i18n";
import { NumField, Select } from "./controls";
import { Group } from "./DocRibbon";

const S = () => useStore.getState();
const TRIGGERS: AnimTrigger[] = ["ON_CLICK", "WITH_PREVIOUS", "AFTER_PREVIOUS"];

/** The first row of each effect on the selected objects (an effect is its start row and the with-previous rows on the same object after it). */
function effectStarts(list: readonly KeyframeAnimation[], sel: readonly string[]): number[] {
  const out: number[] = [];
  list.forEach((a, i) => {
    if (!sel.includes(a.targetNodeId)) return;
    const cont = i > 0 && a.trigger === "WITH_PREVIOUS" && list[i - 1].targetNodeId === a.targetNodeId;
    if (!cont) out.push(i);
  });
  return out;
}

/** The rows of the effect starting at `i`. */
function rowsOf(list: readonly KeyframeAnimation[], i: number): number[] {
  const rows = [i];
  for (let k = i + 1; k < list.length && list[k].trigger === "WITH_PREVIOUS" && list[k].targetNodeId === list[i].targetNodeId; k++) rows.push(k);
  return rows;
}

function edit(label: string, fn: (list: KeyframeAnimation[], starts: number[]) => void) {
  const s = S();
  s.commit(label, (d) => {
    const pg = draftPage(d, s.pageId);
    if (!pg) return;
    const list = pg.animations as KeyframeAnimation[];
    fn(list, effectStarts(list, s.selection));
  });
}

export function AnimTimingGroup() {
  const t = useT();
  const page = useStore((s) => findPage(s.doc, s.pageId));
  const selection = useStore((s) => s.selection);
  const list = (page?.animations ?? []) as KeyframeAnimation[];
  const starts = effectStarts(list, selection);
  const first = starts.length ? list[starts[0]] : null;
  const off = !first;
  // an effect's length: the longest of its rows (a fly-in's move and fade)
  const dur = first ? Math.max(...rowsOf(list, starts[0]).map((k) => animDuration(list[k]))) : 0;
  return (
    <Group label={t("slideppt.anim.timing")}>
      <div className="rcol anim-timing">
        <label className="anim-timing-start">
          <span>{t("dock.anim.start")}</span>
          <Select<AnimTrigger>
            tip={t("dock.anim.start")}
            value={first?.trigger ?? ""}
            width={110}
            options={TRIGGERS.map((value) => ({ value, label: t(`dock.anim.trigger.${value}`) }))}
            onChange={(v) => !off && edit(tx("dock.anim.changeTrigger"), (l, st) => st.forEach((i) => (l[i].trigger = v)))}
          />
        </label>
        <NumField
          label={t("slideppt.anim.duration")}
          tip={t("slideppt.anim.duration")}
          value={off ? null : dur / 1000}
          min={0.01}
          max={59.99}
          step={0.25}
          precision={2}
          unit="s"
          width={150}
          disabled={off}
          live={{
            set: (v) => {
              if (!(v > 0)) return;
              edit(tx("slideppt.anim.duration"), (l, st) =>
                st.forEach((i) => {
                  const rows = rowsOf(l, i);
                  const old = Math.max(...rows.map((k) => animDuration(l[k])));
                  if (old > 0) for (const k of rows) l[k].keyframes = l[k].keyframes.map((f) => ({ ...f, time: (f.time * v * 1000) / old }));
                }),
              );
            },
          }}
        />
        <NumField
          label={t("slideppt.anim.delay")}
          tip={t("slideppt.anim.delay")}
          value={first ? (first.delay ?? 0) / 1000 : null}
          min={0}
          max={59.99}
          step={0.25}
          precision={2}
          unit="s"
          width={150}
          disabled={off}
          live={{ set: (v) => edit(tx("slideppt.anim.delay"), (l, st) => st.forEach((i) => (v > 0 ? (l[i].delay = Math.round(v * 1000)) : delete l[i].delay))) }}
        />
      </div>
    </Group>
  );
}
