// Structure signature of a PSD page: what besides the layers themselves changes its look — folders (structure,
// opacity, visibility, blend, effects; not names, locks or collapse), page size and background, and the order of the
// imported layers. psd.ts stores it at import (PsdSourceMeta.importSig); overlay.ts compares it to tell whether a
// page is still exactly as imported (pristinePsdView).

import { hashString } from "../hash";
import type { Page } from "../types";

export const groupsSig = (page: Page) => hashString(JSON.stringify((page.groups ?? []).map(({ name: _n, locked: _l, collapsed: _c, ...g }) => g)));
export const pageSig = (page: Page) => hashString(`${page.width}x${page.height}|${page.background}`);
export const orderSig = (page: Page, ids: Set<string>) => hashString(page.nodes.filter((n) => ids.has(n.id)).map((n) => n.id).join(","));

/** groups + page + order of the nodes `ids`, as one hash */
export const structureSig = (page: Page, ids: Set<string>) => hashString(`${groupsSig(page)}|${pageSig(page)}|${orderSig(page, ids)}`);
