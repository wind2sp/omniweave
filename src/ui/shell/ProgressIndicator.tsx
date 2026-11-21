// Status-bar progress (progress.ts → withProgress). Mounted from the moment a task starts but invisible: the CSS shows
// the bar after 0.3 s and the line with Cancel after 2 s (.progress-slot animations), so quick work never flickers
// and slow synchronous work still shows it. Same visual family as the update pill (UpdateBanner.tsx).

import { useT } from "../../i18n";
import { currentTask, useProgress } from "../progress";

/** A bar on its own (dialogs that run work in place can show it too): `fraction` null = indeterminate. */
export function ProgressBar({ fraction, className }: { fraction: number | null; className?: string }) {
  const pct = fraction == null ? undefined : Math.round(fraction * 100);
  return (
    <span className={"progress-track" + (fraction == null ? " indeterminate" : "") + (className ? " " + className : "")} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <i className="progress-fill" style={fraction == null ? undefined : { transform: `scaleX(${fraction})` }} />
    </span>
  );
}

export function ProgressIndicator() {
  const task = useProgress((s) => currentTask(s.tasks));
  const t = useT();
  if (!task) return null;
  const pct = task.fraction == null ? null : Math.round(task.fraction * 100);
  return (
    <span key={task.id} className="progress-slot" aria-live="polite" aria-busy="true">
      {/* row-reverse: shown right to left as  label 42% · Cancel · ▬▬▬ */}
      <ProgressBar fraction={task.fraction} />
      {task.cancel && (
        <button type="button" className="progress-cancel" onClick={task.cancel}>
          {t("progress.cancel")}
        </button>
      )}
      <span className="progress-text">
        {task.label}
        {pct != null && <b>{pct}%</b>}
      </span>
    </span>
  );
}
