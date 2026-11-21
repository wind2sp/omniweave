// Compound File Binary writer for the Office password encryption ([MS-OFFCRYPTO] EncryptionInfo / EncryptedPackage in
// a compound file): a plain name → bytes tree checked here (names in the UI language), written by the one CFB writer
// the program has, io/formats/cfb.ts writeCfb (version 3, 512-byte sectors, mini stream under 4096 bytes, DIFAT past
// 109 FAT sectors, red-black sibling trees in [MS-CFB] 2.6.4 name order). It had a second, separate writer until
// 2026-11-16 (docs/design/INSTALLER_SIZE.md §12: the HWP save brought the other one).

import { t as tr } from "../../i18n";
import { cfbCompare, writeCfb as writeCfbTree, type CfbNode } from "../formats/cfb";

export type CfbTree = { [name: string]: Uint8Array | CfbTree };

/** [MS-CFB] 2.6.4: shorter names sort first; equal lengths compare upper-cased code units. */
export const compareCfbNames = cfbCompare;

const NO_TIME = new Uint8Array(8), NO_CLSID = new Uint8Array(16);

function node(name: string, v: Uint8Array | CfbTree): CfbNode {
  if (name.length > 31) throw new Error(tr("engine.crypto.cfbNameTooLong", { name }));
  if (/[/\\:!]/.test(name)) throw new Error(tr("engine.crypto.cfbNameBadChar", { name }));
  const base = { name, clsid: NO_CLSID, stateBits: 0, created: NO_TIME, modified: NO_TIME };
  return v instanceof Uint8Array ? { ...base, kind: "stream", data: v } : { ...base, kind: "storage", kids: kids(v) };
}

function kids(t: CfbTree): CfbNode[] {
  const names = Object.keys(t).sort(compareCfbNames);
  for (let i = 1; i < names.length; i++) if (compareCfbNames(names[i - 1], names[i]) === 0) throw new Error(tr("engine.crypto.cfbNameDuplicate", { name: names[i] }));
  return names.map((n) => node(n, t[n]));
}

export function writeCfb(tree: CfbTree): Uint8Array {
  return writeCfbTree({ root: { name: "Root Entry", kind: "storage", clsid: NO_CLSID, stateBits: 0, created: NO_TIME, modified: NO_TIME, kids: kids(tree) } });
}
