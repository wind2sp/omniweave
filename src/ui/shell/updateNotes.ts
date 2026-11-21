// Release notes of an update (latest.json "notes" = the GitHub release text) → what the update dialog shows.
// docs/UPDATES.md §2: a first line starting with [중요] or [important] marks an important update — the app asks at
// once and shows it emphasised. The marker itself is not shown.

const MARK = /^\s*\[(중요|important)\]\s*/i;

export interface UpdateNotes {
  important: boolean;
  /** note lines without list bullets or heading marks, empty lines dropped */
  lines: string[];
}

export function parseNotes(body: string | null | undefined): UpdateNotes {
  const raw = (body ?? "").replace(/\r\n?/g, "\n").split("\n");
  const first = raw.findIndex((l) => l.trim() !== "");
  let important = false;
  if (first >= 0 && MARK.test(raw[first])) {
    important = true;
    raw[first] = raw[first].replace(MARK, "");
  }
  const lines = raw.map((l) => l.replace(/^[#*\-\s]+/, "").trim()).filter(Boolean);
  return { important, lines };
}

/** The portable entry latest.json carries for this platform (release.yml adds it), or null when absent or malformed. */
export interface PortableAsset {
  url: string;
  size: number;
  sha256: string;
  signature: string;
}

export function portableAsset(raw: unknown, platform = "windows-x86_64"): PortableAsset | null {
  const p = (raw as { portable?: Record<string, unknown> } | null)?.portable?.[platform] as Partial<PortableAsset> | undefined;
  if (!p || typeof p !== "object") return null;
  const { url, size, sha256, signature } = p;
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) return null;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(sha256)) return null;
  if (typeof signature !== "string" || !signature.trim()) return null;
  return { url, size, sha256: sha256.toLowerCase(), signature: signature.trim() };
}
