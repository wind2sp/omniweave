// Full legal texts built into the app, so the installer and the Store package both carry them (GPL-3.0 §4·§6 keep the
// license with every copy; BSD-3, Apache-2.0, MIT, OFL and zlib want their notices in binary distributions too).
// Loaded only when the About dialog asks for them (own chunk). docs/legal/IP_CHECKLIST.md 2장 #3·#5.
import license from "../../../LICENSE?raw";
import notice from "../../../NOTICE?raw";
import thirdParty from "../../../THIRD_PARTY_NOTICES.md?raw";
import trademarks from "../../../TRADEMARKS.md?raw";

export type LegalText = "license" | "notices" | "trademarks";

export const LEGAL_TEXTS: Record<LegalText, string> = {
  license,
  notices: `${notice}\n\n${thirdParty}`,
  trademarks,
};
