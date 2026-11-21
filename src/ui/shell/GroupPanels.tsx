// Layer group properties (right dock) and the clipping-mask switch for selected layers.

import { draftPage, useStore } from "../../core/store";
import type { GroupBlend, LayerGroup, SceneNode } from "../../core/types";
import { useT, t } from "../../i18n";
import { clippable, toggleClipping, updateGroup, useLayersUI } from "../groups";
import { Field, NumField, Section, Select } from "./controls";
import { Icon } from "./Icons";
import { BLEND_OPTIONS } from "./Ribbon";
import type { Live } from "./ops";

const S = () => useStore.getState();

/** Group blend modes: Pass Through first (Photoshop's default for groups), then the layer modes. */
export const groupBlendOptions = (): { value: GroupBlend; label: string }[] => [{ value: "PASS_THROUGH", label: t("layers.blend.passThrough") }, ...BLEND_OPTIONS];

function groupLive(gid: string, label: string, apply: (g: LayerGroup, v: number) => void): Live<number> {
  return {
    set: (v) => updateGroup(gid, label, (g) => apply(g, v)),
    begin: () => S().beginGesture(),
    live: (v) =>
      S().updateGesture((d) => {
        const g = draftPage(d, S().pageId)?.groups?.find((x) => x.id === gid);
        if (g) apply(g as LayerGroup, v);
      }),
    end: () => S().endGesture(label),
  };
}

export function GroupProps({ group, count }: { group: LayerGroup; count: number }) {
  const t = useT();
  return (
    <Section title={t("layers.props.group")} actions={<Icon name="folder" size={14} />}>
      <Field label={t("layers.props.name")} wide>
        <input
          className="text-input"
          key={group.id + group.name}
          defaultValue={group.name}
          aria-label={t("layers.props.name")}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== group.name) updateGroup(group.id, t("layers.hist.rename"), (g) => (g.name = v));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            e.stopPropagation();
          }}
        />
      </Field>
      <div className="grid2">
        <NumField icon="opacity" tip={t("layers.props.opacity")} value={group.opacity} scale={100} min={0} max={100} unit="%" width={0} live={groupLive(group.id, t("layers.props.opacity"), (g, v) => (g.opacity = v))} />
        <Select icon="blend" tip={t("layers.props.blend")} value={group.blendMode} options={groupBlendOptions()} onChange={(v) => updateGroup(group.id, t("layers.props.blend"), (g) => (g.blendMode = v))} />
      </div>
      <div className="check-row">
        <label className="check">
          <input type="checkbox" checked={group.visible} onChange={(e) => updateGroup(group.id, t("layers.props.visibility"), (g) => (g.visible = e.target.checked))} />
          <span>{t("layers.props.show")}</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={group.locked} onChange={(e) => updateGroup(group.id, t("layers.props.lock"), (g) => (g.locked = e.target.checked))} />
          <span>{t("layers.props.lock")}</span>
        </label>
      </div>
      <p className="empty-note">{t(count === 1 ? "layers.props.members_one" : "layers.props.members", { n: count })}</p>
    </Section>
  );
}

/** "Clipping mask" switch for the selected layers (shown when at least one of them can be clipped). */
export function ClipSwitch({ nodes }: { nodes: SceneNode[] }) {
  const t = useT();
  const page = useStore((s) => s.doc.pages.find((p) => p.id === s.pageId) ?? s.doc.masters.find((p) => p.id === s.pageId));
  if (!page) return null;
  const ok = clippable(page, nodes.map((n) => n.id));
  const usable = nodes.filter((n) => ok.has(n.id));
  if (!usable.length) return null;
  const on = usable.every((n) => n.clip);
  return (
    <label className="check" data-tip={t("layers.props.clipTip")}>
      <input type="checkbox" checked={on} onChange={() => toggleClipping(usable.map((n) => n.id))} />
      <span>{t("layers.props.clip")}</span>
    </label>
  );
}

/** The group picked in the layers panel, while the selection is its members. */
export function usePickedGroup(): { group: LayerGroup; count: number } | null {
  const active = useLayersUI((s) => s.activeGroup);
  const page = useStore((s) => s.doc.pages.find((p) => p.id === s.pageId) ?? s.doc.masters.find((p) => p.id === s.pageId));
  const selection = useStore((s) => s.selection);
  const g = active ? page?.groups?.find((x) => x.id === active) : undefined;
  if (!g || !page) return null;
  // members of g (any depth)
  const inside = new Set<string>([g.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const x of page.groups ?? []) if (x.parentId && inside.has(x.parentId) && !inside.has(x.id)) (inside.add(x.id), (grew = true));
  }
  const members = page.nodes.filter((n) => n.groupId && inside.has(n.groupId)).map((n) => n.id);
  if (members.length !== selection.length || !members.every((m) => selection.includes(m))) return null;
  return { group: g, count: members.length };
}
