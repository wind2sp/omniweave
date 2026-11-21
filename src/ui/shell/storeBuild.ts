// Microsoft Store build (MSIX package, packaging/msix): the Store installs and updates the app, so the app's own
// updater is off there — no update checks, no update pill, no "Check for updates" in the Help menu. The desktop
// side answers from the package identity (src-tauri/src/lib.rs is_store_package); the installer and portable builds
// (GitHub releases) keep the updater.

type Invoke = <T>(cmd: string) => Promise<T>;

let answer: Promise<boolean> | null = null;
let known = false;

const tauriInvoke: Invoke = async <T,>(cmd: string) => (await import("@tauri-apps/api/core")).invoke<T>(cmd);

/** Whether this desktop app runs from its Store package (asked once; false outside the desktop app or on error). */
export function storePackaged(invoke: Invoke = tauriInvoke): Promise<boolean> {
  if (!answer)
    answer = invoke<boolean>("is_store_package")
      .then((v) => v === true)
      .catch(() => false)
      .then((v) => (known = v));
  return answer;
}

/** The last answer of storePackaged() (false until it has answered) — for menus, which are built synchronously. */
export function isStorePackaged(): boolean {
  return known;
}

/** Tests: forget the answer. */
export function resetStorePackaged() {
  answer = null;
  known = false;
}
