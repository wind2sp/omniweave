// Files dragged from the desktop (or Explorer) and dropped anywhere on the window (실사용 점검 2026-11-23: with a
// document open, a file dropped on a sheet, the title bar, the speaker notes or a dock did nothing — no notice).
// One rule everywhere, web and desktop alike (the desktop window keeps Tauri's native drag-drop off, so it gets the
// same HTML drop, src-tauri/tauri.conf.json dragDropEnabled false):
//   - on the page canvas, a picture / clip is placed on the page (as Insert ▸ Picture does);
//   - anything else, anywhere, opens as a document of its own (a new tab, or the active untouched new document).
// Places with a drop of their own (page organizer, tab strip, start screen, tools dialog) claim the event first.

import { formatForExt } from "../io/formats";
import type { FileHandle, OpenedFile } from "../io/platform";

const CLAIMED = "__omwDropClaimed";

/** Marks a drop as handled by the element it landed on (the window-wide rule then leaves it alone). */
export function claimDrop(e: { nativeEvent?: Event } | Event) {
  const ev = ("nativeEvent" in e && e.nativeEvent ? e.nativeEvent : e) as Event & { [CLAIMED]?: boolean };
  ev[CLAIMED] = true;
}
export const dropClaimed = (e: Event) => !!(e as Event & { [CLAIMED]?: boolean })[CLAIMED];

/** A file the page canvas places on the page (pictures, video, audio) rather than opening it as a document. */
export function placesOnPage(name: string): boolean {
  const id = formatForExt(name.split(".").pop() ?? "")?.id;
  return id === "image" || id === "video" || id === "audio";
}

/** The dropped files read into memory (no path in the browser). Chrome / Edge also hand each file's handle
 *  (getAsFileSystemHandle), so 저장 (Ctrl+S) can write that same file. Call it in the drop event itself, before any
 *  await: the browser empties the drop's items once the event is over. */
export async function droppedFiles(dt: DataTransfer | null): Promise<OpenedFile[]> {
  const list = Array.from(dt?.files ?? []);
  const items = Array.from(dt?.items ?? []).filter((i) => i.kind === "file");
  const handles: Promise<FileHandle | null>[] =
    items.length === list.length
      ? items.map((i) => {
          const get = (i as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileHandle | null> }).getAsFileSystemHandle;
          if (typeof get !== "function") return Promise.resolve(null);
          try {
            return Promise.resolve(get.call(i)).then((h) => (h && h.kind === "file" ? h : null), () => null);
          } catch {
            return Promise.resolve(null);
          }
        })
      : list.map(() => Promise.resolve(null));
  return Promise.all(list.map(async (f, i) => ({ name: f.name, path: null, bytes: new Uint8Array(await f.arrayBuffer()), handle: await handles[i] })));
}
