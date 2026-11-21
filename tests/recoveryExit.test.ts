// The "recover your work?" offer comes only after a run that did not end normally (io/journal.ts startRun / endRun):
// quitting with 저장 안 함 gives up those changes and their recovery copy; a killed run is offered back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cleared: (string | undefined)[] = [];
vi.mock("../src/io/journal", async (orig) => {
  const real = await orig<typeof import("../src/io/journal")>();
  return {
    ...real,
    journalClear: async (key?: string) => void cleared.push(key),
  };
});

import { endRun, startRun } from "../src/io/journal";
import { useStore } from "../src/core/store";
import { resetSessionsForTest, useSessions } from "../src/core/sessions";
import { newDocument } from "../src/core/types";
import { answerUnsaved, confirmAllSaved, useTabPrompt } from "../src/ui/tabs";

const mem = new Map<string, string>();
beforeEach(() => {
  (globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  mem.clear();
  cleared.length = 0;
});
afterEach(() => {
  delete (globalThis as any).document;
});

describe("crash recovery only after an abnormal end", () => {
  it("a run that ended normally is not offered back; a killed one is", async () => {
    expect(startRun()).toBe(false); // first run ever
    await endRun(); // quit / window closed / update installed
    expect(startRun()).toBe(false);
    // killed: no endRun before the next start
    expect(startRun()).toBe(true);
  });

  it("quitting with 저장 안 함 drops the unsaved tabs' recovery copies", async () => {
    useStore.getState().load(newDocument());
    resetSessionsForTest();
    useStore.getState().commit("edit", (d) => void (d.title = "changed"));
    const id = useSessions.getState().active;
    (globalThis as any).document = {};
    const done = confirmAllSaved();
    expect(useTabPrompt.getState().pending).not.toBeNull();
    answerUnsaved("discard");
    expect(await done).toBe(true);
    expect(cleared).toContain(id);
  });
});
