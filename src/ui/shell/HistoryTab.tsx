// History timeline panel: every command since the document started, newest first.
// Click = preview that moment on the canvas; "이 시점으로 복원" makes it current (undoable).

import { useMemo } from "react";
import { cancelPreview, clearHistory, historyStats, previewEntry, restoreEntry, useHistory } from "../../core/history";
import { Section, cx } from "./controls";
import { Icon } from "./Icons";
import { useT } from "../../i18n";

function fmtTime(t: number) {
  const d = new Date(t);
  const today = new Date();
  const time = d.toLocaleTimeString("ko-KR", { hour12: false });
  return d.toDateString() === today.toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export function HistoryTab() {
  const t = useT();
  const entries = useHistory((s) => s.entries);
  const previewId = useHistory((s) => s.previewId);
  const recording = useHistory((s) => s.recording);
  const includeInFile = useHistory((s) => s.includeInFile);
  const set = useHistory((s) => s.set);
  const stats = useMemo(() => historyStats(entries), [entries]);
  const list = [...entries].reverse();
  const current = entries[entries.length - 1]?.id;
  const previewing = entries.find((e) => e.id === previewId);

  return (
    <div className="dock-scroll pad">
      {previewing && (
        <div className="history-preview">
          <div>
            <strong>{t("dock.history.preview")}</strong> {fmtTime(previewing.time)} · {previewing.label}
            <p className="muted-note">{t("dock.history.previewNote")}</p>
          </div>
          <div className="history-preview-actions">
            <button type="button" className="btn btn-primary" onClick={() => restoreEntry(previewing.id)}>
              {t("dock.history.restoreHere")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={cancelPreview}>
              {t("dock.history.backToCurrent")}
            </button>
          </div>
        </div>
      )}

      <Section
        title={t("dock.history.title", { n: entries.length })}
        actions={
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              if (confirm(t("dock.history.clearConfirm"))) clearHistory();
            }}
          >
            {t("dock.history.clear")}
          </button>
        }
      >
        <p className="muted-note">{t("dock.history.stats", { nodes: stats.nodes, tiles: stats.tiles, size: fmtBytes(stats.approxBytes) })}</p>
        <ol className="history-list">
          {list.map((e, i) => {
            const isCurrent = e.id === current;
            const isPreview = e.id === previewId;
            return (
              <li
                key={e.id}
                className={cx("anim-row", "history-row", isPreview && "active", isCurrent && "current")}
                onClick={() => (isCurrent ? cancelPreview() : previewEntry(e.id))}
                title={isCurrent ? t("dock.history.currentState") : t("dock.history.clickPreview")}
              >
                <span className={cx("history-dot", isCurrent && "on")} aria-hidden />
                <div className="anim-main">
                  <span className="anim-name">{e.label}</span>
                  <span className="anim-sub">
                    {isCurrent ? t("dock.history.timeNow", { time: fmtTime(e.time) }) : t("dock.history.timeAgo", { time: fmtTime(e.time), n: i })}
                  </span>
                </div>
                {!isCurrent && (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      restoreEntry(e.id);
                    }}
                  >
                    {t("dock.history.restore")}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </Section>

      <Section title={t("dock.history.settings")}>
        <label className="check-row">
          <input type="checkbox" checked={recording} onChange={(e) => set({ recording: e.target.checked })} />
          <span>{t("dock.history.record")}</span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={includeInFile} onChange={(e) => set({ includeInFile: e.target.checked })} />
          <span>{t("dock.history.includeInFile")}</span>
        </label>
        <p className="muted-note">
          <Icon name="clock" size={12} /> {t("dock.history.fileNote")}
        </p>
      </Section>
    </div>
  );
}
