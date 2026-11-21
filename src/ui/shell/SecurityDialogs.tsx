// Masked password prompt and the "how should this export be protected?" choice.
// Both are promise-based so io/ and actions code can await them.

import { useEffect, useState } from "react";
import { create } from "zustand";
import { setPasswordAsker, type PasswordRequest } from "../../io/crypto/session";
import { useT } from "../../i18n";
import { Icon } from "./Icons";
import { Modal } from "./Dialogs";

export type ProtectChoice = { mode: "same" } | { mode: "none" } | { mode: "new"; password: string };

export interface ProtectRequest {
  ext: string;
  /** the content came from a password-protected file */
  wasProtected: boolean;
  /** the original password is still known in this session */
  canReuse: boolean;
  /** the target format can carry a password */
  supported: boolean;
}

type Pending =
  | { kind: "password"; req: PasswordRequest; resolve: (v: string | null) => void }
  | { kind: "protect"; req: ProtectRequest; resolve: (v: ProtectChoice | null) => void };

const useSec = create<{ pending: Pending | null }>(() => ({ pending: null }));

/** number of mounted <SecurityDialogs/>; with none (tests, headless use) every request is cancelled */
let mounted = 0;

/** Show one request; a request that replaces an unanswered one cancels it instead of leaving it pending forever. */
function show(next: Pending) {
  if (!mounted) return next.resolve(null);
  const prev = useSec.getState().pending;
  useSec.setState({ pending: next });
  prev?.resolve(null);
}

export function askPasswordDialog(req: PasswordRequest): Promise<string | null> {
  return new Promise((resolve) => show({ kind: "password", req, resolve }));
}

export function askProtection(req: ProtectRequest): Promise<ProtectChoice | null> {
  return new Promise((resolve) => show({ kind: "protect", req, resolve }));
}

setPasswordAsker(askPasswordDialog);

function close() {
  useSec.setState({ pending: null });
}

function PasswordFields({ confirm, onSubmit, submitLabel }: { confirm?: boolean; onSubmit: (pw: string) => void; submitLabel: string }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [show, setShow] = useState(false);
  const t = useT();
  const mismatch = confirm && pw2.length > 0 && pw !== pw2;
  const ok = pw.length > 0 && (!confirm || pw === pw2);
  return (
    <form
      className="pw-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onSubmit(pw);
      }}
    >
      <label className="pw-field">
        <span>{t("shell.pw.password")}</span>
        <input type={show ? "text" : "password"} value={pw} autoComplete={confirm ? "new-password" : "current-password"} data-autofocus autoFocus onChange={(e) => setPw(e.target.value)} />
        <button type="button" className="ibtn ibtn-sm" aria-label={show ? t("shell.pw.hide") : t("shell.pw.show")} onClick={() => setShow(!show)}>
          <Icon name={show ? "eyeOff" : "eye"} size={14} />
        </button>
      </label>
      {confirm && (
        <label className="pw-field">
          <span>{t("shell.pw.confirmField")}</span>
          <input type={show ? "text" : "password"} value={pw2} autoComplete="new-password" onChange={(e) => setPw2(e.target.value)} />
        </label>
      )}
      {mismatch && <p className="pw-error">{t("shell.pw.mismatch")}</p>}
      {confirm && pw.length > 0 && pw.length < 8 && <p className="modal-sub">{t("shell.pw.minLength")}</p>}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={() => onSubmit("\u0000cancel")}>
          {t("shell.cancel")}
        </button>
        <button type="submit" className="btn btn-primary" disabled={!ok}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

export function SecurityDialogs() {
  const pending = useSec((s) => s.pending);
  const [mode, setMode] = useState<"same" | "none" | "new">("same");
  const t = useT();
  useEffect(() => {
    mounted++;
    return () => {
      mounted--;
      if (!mounted) {
        useSec.getState().pending?.resolve(null);
        useSec.setState({ pending: null });
      }
    };
  }, []);
  if (!pending) return null;

  if (pending.kind === "password") {
    const { req, resolve } = pending;
    const done = (v: string | null) => {
      close();
      resolve(v);
    };
    return (
      <Modal labelledBy="pw-title" className="modal-sm" onClose={() => done(null)}>
        <div className="modal-icon">
          <Icon name="lock" size={22} />
        </div>
        <h2 id="pw-title">{req.title}</h2>
        <p className="modal-text">{req.message}</p>
        {req.retry && <p className="pw-error">{t("shell.pw.wrong")}</p>}
        <PasswordFields confirm={req.confirm} submitLabel={t("shell.ok")} onSubmit={(pw) => done(pw === "\u0000cancel" ? null : pw)} />
        <p className="modal-sub">{t("shell.pw.memoryOnly")}</p>
      </Modal>
    );
  }

  const { req, resolve } = pending;
  const done = (v: ProtectChoice | null) => {
    close();
    setMode("same");
    resolve(v);
  };
  // asked only when the source was protected or the person chose "암호 걸어 저장": default to keeping a password
  const effective = (!req.wasProtected || !req.canReuse) && mode === "same" ? "new" : mode;

  if (!req.supported) {
    // the format name is shown in bold inside the translated sentence
    const [before, after] = t(req.wasProtected ? "shell.pr.unsupportedWasProtected" : "shell.pr.unsupported").split("{ext}");
    return (
      <Modal labelledBy="pr-title" className="modal-sm" onClose={() => done(null)}>
        <div className="modal-icon">
          <Icon name="unlock" size={22} />
        </div>
        <h2 id="pr-title">{t("shell.pr.unprotectedTitle")}</h2>
        <p className="modal-text">
          {before}
          <b>.{req.ext}</b>
          {after}
        </p>
        <p className="modal-sub">{t("shell.pr.keepHint")}</p>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" data-autofocus onClick={() => done(null)}>
            {t("shell.cancel")}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => done({ mode: "none" })}>
            {t("shell.pr.saveUnprotected")}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal labelledBy="pr-title" className="modal-sm" onClose={() => done(null)}>
      <div className="modal-icon">
        <Icon name="shield" size={22} />
      </div>
      <h2 id="pr-title">{req.wasProtected ? t("shell.pr.howTitle") : t("shell.pr.setTitle")}</h2>
      {req.wasProtected && <p className="modal-text">{t("shell.pr.wasProtected")}</p>}
      <div className="pr-options" role="radiogroup">
        {req.wasProtected && req.canReuse && (
          <label className="pr-option">
            <input type="radio" name="pr" checked={effective === "same"} onChange={() => setMode("same")} />
            <span>
              <b>{t("shell.pr.same")}</b>
              <small>{t("shell.pr.sameHint")}</small>
            </span>
          </label>
        )}
        <label className="pr-option">
          <input type="radio" name="pr" checked={effective === "new"} onChange={() => setMode("new")} />
          <span>
            <b>{t("shell.pr.new")}</b>
            <small>{t(req.ext === "pdf" ? "shell.pr.newHintPdf" : req.ext === "omw" ? "shell.pr.newHintOmw" : "shell.pr.newHintOffice")}</small>
          </span>
        </label>
        <label className={`pr-option${req.wasProtected ? " warn" : ""}`}>
          <input type="radio" name="pr" checked={effective === "none"} onChange={() => setMode("none")} />
          <span>
            <b>{t("shell.pr.none")}</b>
            <small>{req.wasProtected ? t("shell.pr.noneHintWas") : t("shell.pr.noneHint")}</small>
          </span>
        </label>
      </div>
      {effective === "new" ? (
        <PasswordFields confirm submitLabel={t("shell.pr.saveWithPassword")} onSubmit={(pw) => done(pw === "\u0000cancel" ? null : { mode: "new", password: pw })} />
      ) : (
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={() => done(null)}>
            {t("shell.cancel")}
          </button>
          <button type="button" className="btn btn-primary" data-autofocus onClick={() => done(effective === "same" ? { mode: "same" } : { mode: "none" })}>
            {t("cmd.file.save")}
          </button>
        </div>
      )}
    </Modal>
  );
}
