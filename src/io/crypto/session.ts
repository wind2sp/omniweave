// Passwords for protected documents live only in memory for the running session.
// They are never written to .omw files, history, the autosave journal, logs or exceptions.

import { uid } from "../../core/types";

const secrets = new Map<string, string>();

export function rememberSecret(password: string): string {
  for (const [id, pw] of secrets) if (pw === password) return id;
  const id = uid("sec");
  secrets.set(id, password);
  return id;
}

export function getSecret(id: string | undefined): string | undefined {
  return id ? secrets.get(id) : undefined;
}

export function forgetAllSecrets() {
  secrets.clear();
}

export interface PasswordRequest {
  title: string;
  message: string;
  /** previous attempt was wrong */
  retry?: boolean;
  /** ask twice (setting a new password) */
  confirm?: boolean;
}

export type PasswordAsker = (req: PasswordRequest) => Promise<string | null>;

// default for non-UI environments; the app installs a masked dialog (ui/shell/SecurityDialogs.tsx)
let asker: PasswordAsker = async (req) => (typeof prompt === "function" ? prompt(`${req.title}\n${req.message}`) : null);

export function setPasswordAsker(fn: PasswordAsker) {
  asker = fn;
}

export function askPassword(req: PasswordRequest): Promise<string | null> {
  return asker(req);
}

/** Ask until `tryOpen` accepts the password (or the person cancels / 5 attempts). */
export async function withPassword<T>(req: Omit<PasswordRequest, "retry">, tryOpen: (pw: string) => Promise<T>, isWrong: (e: unknown) => boolean): Promise<{ value: T; password: string } | null> {
  let retry = false;
  for (let i = 0; i < 5; i++) {
    const pw = await askPassword({ ...req, retry });
    if (pw == null) return null;
    try {
      return { value: await tryOpen(pw), password: pw };
    } catch (e) {
      if (!isWrong(e)) throw e;
      retry = true;
    }
  }
  return null;
}
