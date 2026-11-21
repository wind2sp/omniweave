// Workbooks opened the way Omniweave did before the sheet grid (2026-11-13): every sheet a table on document pages,
// with the Office Surgeon row map. Documents saved then still open that way (.omw), so the table-path surgeon stays tested.
import { makeAsset } from "../../src/core/assets";
import { importXlsx } from "../../src/io/formats/xlsx";
import { xlsxMeta } from "../../src/io/officesurgeon";

export function legacyOpen(bytes: Uint8Array, name = "omw-오메장부.xlsx") {
  const { pages, sheets } = importXlsx(bytes, name);
  const asset = makeAsset(bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", name);
  const office = xlsxMeta(pages, sheets, asset);
  if (office && pages[0]?.source) pages[0].source = { ...pages[0].source, office };
  return { pages, assets: office ? { [asset.id]: asset } : {} };
}
