// One text question at a time for the phone shell: passwords (io/crypto/session's asker), a text memo, a page
// number. A bottom sheet with a field and two 48 px buttons; the Android back gesture cancels it (useBackClose).

import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useBackClose } from "./back";

export interface Ask {
  title: string;
  message?: string;
  password?: boolean;
  initial?: string;
  /** numeric keyboard */
  number?: boolean;
  multiline?: boolean;
  /** extra quick answers shown as chips (e.g. today's date for a memo) */
  chips?: string[];
  error?: string;
  /** a yes / no question: no field, OK answers "" */
  confirm?: boolean;
  /** the OK button's own words */
  okLabel?: string;
  /** buttons of their own instead of Cancel / OK (the first primary): the answer is the chosen one's value */
  choices?: { label: string; value: string; danger?: boolean }[];
}

let show: ((a: Ask | null, done?: (v: string | null) => void) => void) | null = null;

export function ask(a: Ask): Promise<string | null> {
  return new Promise((resolve) => {
    if (!show) return resolve(typeof prompt === "function" ? prompt(a.title) : null);
    show(a, resolve);
  });
}

export function PromptHost() {
  const tr = useT();
  const [q, setQ] = useState<{ a: Ask; done: (v: string | null) => void } | null>(null);
  const [value, setValue] = useState("");
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  useEffect(() => {
    show = (a, done) => {
      if (!a) return setQ(null);
      setValue(a.initial ?? "");
      setQ({ a, done: done! });
    };
    return () => {
      show = null;
    };
  }, []);
  useEffect(() => {
    if (q && !q.a.confirm) window.setTimeout(() => field.current?.focus(), 60);
  }, [q]);

  const finish = (v: string | null) => {
    q?.done(v);
    setQ(null);
  };
  useBackClose(!!q, () => finish(null));
  if (!q) return null;
  const { a } = q;
  const Field = a.multiline ? "textarea" : "input";
  return (
    <div className="m-sheet-scrim" onClick={() => finish(null)}>
      <form
        className="m-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={a.title}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          finish(value);
        }}
      >
        <h2>{a.title}</h2>
        {a.message && <p className="m-sheet-msg">{a.message}</p>}
        {a.error && <p className="m-sheet-error">{a.error}</p>}
        {!a.confirm && !a.choices && (
        <Field
          ref={field as any}
          className="m-field"
          type={a.password ? "password" : a.number ? "number" : "text"}
          inputMode={a.number ? "numeric" : undefined}
          autoComplete={a.password ? "off" : undefined}
          value={value}
          rows={a.multiline ? 3 : undefined}
          aria-label={a.title}
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValue(e.target.value)}
        />
        )}
        {a.chips && (
          <div className="m-chips">
            {a.chips.map((c) => (
              <button type="button" key={c} className="m-chip" onClick={() => setValue((v) => (v ? v + " " : "") + c)}>
                {c}
              </button>
            ))}
          </div>
        )}
        {a.choices ? (
          <div className="m-sheet-btns m-sheet-choices">
            {a.choices.map((c, i) => (
              <button key={c.value} type="button" className={"m-btn" + (i === 0 ? " m-btn-primary" : "") + (c.danger ? " m-btn-danger" : "")} onClick={() => finish(c.value)}>
                {c.label}
              </button>
            ))}
            <button type="button" className="m-btn" onClick={() => finish(null)}>
              {tr("mobile.cancel")}
            </button>
          </div>
        ) : (
          <div className="m-sheet-btns">
            <button type="button" className="m-btn" onClick={() => finish(null)}>
              {tr("mobile.cancel")}
            </button>
            <button type="submit" className="m-btn m-btn-primary">
              {a.okLabel ?? tr("mobile.ok")}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

let offered: string | null = null;
/** The next password question (a first try, not a retry) is answered with `pw` without asking: the file the viewer
 *  already unlocked, opened again by the editor. A wrong one falls back to asking. */
export function offerPassword(pw: string | null) {
  offered = pw;
}

/** io/crypto/session's password asker for the phone (installed by MobileApp). */
export function phonePasswordAsker(tr: (k: string) => string) {
  return (req: { title: string; message: string; retry?: boolean }) => {
    if (offered != null && !req.retry) {
      const pw = offered;
      offered = null;
      return Promise.resolve(pw);
    }
    offered = null;
    return ask({ title: req.title, message: req.message, password: true, error: req.retry ? tr("mobile.pwWrong") : undefined });
  };
}
