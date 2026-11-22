// Browser (web) app: update check by version.json, other tabs at startup, the version.json the build writes.
import { describe, expect, it } from "vitest";
import { currentBuild, isNewBuild } from "../src/ui/shell/WebUpdate";
import { otherPagesOpen } from "../src/io/journal";
import { webVersion } from "../vite.config";
import { DICTS } from "../src/i18n";

const docWith = (src: string | null) => ({ querySelector: () => (src === null ? null : { getAttribute: () => src }) }) as any;

describe("web update", () => {
  it("reads the running entry script from the page", () => {
    expect(currentBuild(docWith("./assets/index-DH0_tt_Z.js"))).toBe("index-DH0_tt_Z.js");
    expect(currentBuild(docWith("/omniweave/app/assets/index-AbC-12.js"))).toBe("index-AbC-12.js");
    expect(currentBuild(docWith(null))).toBeNull(); // dev server: /src/main.tsx
  });

  it("offers a reload only when the server names another build", () => {
    expect(isNewBuild({ version: "0.2.2", build: "index-NEW.js" }, "index-OLD.js")).toBe(true);
    expect(isNewBuild({ version: "0.2.1", build: "index-OLD.js" }, "index-OLD.js")).toBe(false);
    expect(isNewBuild({ version: "0.2.2" }, "index-OLD.js")).toBe(false); // no build named: say nothing
    expect(isNewBuild(null, "index-OLD.js")).toBe(false); // offline
    expect(isNewBuild({ build: "index-NEW.js" }, null)).toBe(false); // dev server
  });

  it("the build writes version.json naming the entry script", () => {
    const emitted: any[] = [];
    const plugin = webVersion("9.8.7") as any;
    plugin.generateBundle.call(
      { emitFile: (f: any) => emitted.push(f) },
      {},
      {
        "assets/worker-image-x.js": { type: "chunk", isEntry: false, name: "worker-image", fileName: "assets/worker-image-x.js" },
        "assets/index-ABC.js": { type: "chunk", isEntry: true, name: "index", fileName: "assets/index-ABC.js" },
      },
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0].fileName).toBe("version.json");
    const j = JSON.parse(emitted[0].source);
    expect(j.version).toBe("9.8.7");
    expect(j.build).toBe("index-ABC.js");
  });

  it("strings for the web screens exist in every language", () => {
    for (const k of ["web.update.reload", "web.start.sample", "web.start.privacy", "web.recover.journal", "web.mobile.text"])
      for (const l of ["ko", "en", "zh", "ja"] as const) expect(DICTS[l][k], `${l} ${k}`).toBeTruthy();
  });
});

describe("other browser tabs at startup", () => {
  const fakeLocks = (heldNames: string[]) => {
    const requested: string[] = [];
    return {
      requested,
      query: async () => ({ held: heldNames.map((name) => ({ name })) }),
      request: (name: string) => (requested.push(name), new Promise(() => {})),
    };
  };

  it("no other tab: not open, and this page takes the run lock", async () => {
    const l = fakeLocks([]);
    expect(await otherPagesOpen(l)).toBe(false);
    expect(l.requested).toEqual(["omniweave-run"]);
  });

  it("another tab holds the run lock: its mark is not a crash", async () => {
    expect(await otherPagesOpen(fakeLocks(["omniweave-run"]))).toBe(true);
  });

  it("no Web Locks (old browser, tests): false as before", async () => {
    expect(await otherPagesOpen(undefined)).toBe(false);
    expect(await otherPagesOpen({ query: async () => Promise.reject(new Error("x")), request: () => Promise.resolve() })).toBe(false);
  });
});
