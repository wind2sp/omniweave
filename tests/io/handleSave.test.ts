// The web build's 저장 (Ctrl+S) into the file it was opened from: Chrome / Edge give the file's handle (open picker,
// drop), and the bytes go back into it with no save picker; without a handle, or when writing is refused, the
// save picker is used as before.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Written = { parts: unknown[]; closed: boolean };

function handle(name: string, perm: PermissionState = "prompt", answer: PermissionState = "granted") {
  const writes: Written[] = [];
  let state = perm;
  let asked = 0;
  const h = {
    kind: "file" as const,
    name,
    getFile: async () => new File([new Uint8Array([1, 2, 3])], name),
    queryPermission: async () => state,
    requestPermission: async () => {
      asked++;
      state = answer;
      return state;
    },
    createWritable: async () => {
      if (state !== "granted") throw new DOMException("no", "NotAllowedError");
      const w: Written = { parts: [], closed: false };
      writes.push(w);
      return { write: async (d: unknown) => void w.parts.push(d), close: async () => void (w.closed = true) };
    },
  };
  return { h, writes, asked: () => asked };
}

let pickerCalls = 0;
beforeEach(() => {
  pickerCalls = 0;
  vi.resetModules();
  vi.stubGlobal("window", {
    showSaveFilePicker: async () => {
      pickerCalls++;
      return handle("picked.docx", "granted").h;
    },
  });
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/131", maxTouchPoints: 0, platform: "Win32" });
});
afterEach(() => vi.unstubAllGlobals());

describe("web save into the opened file's handle", () => {
  it("writes into the handle, with no save picker", async () => {
    const { saveFile, handleWritable } = await import("../../src/io/platform");
    const f = handle("report.docx");
    expect(await handleWritable(f.h)).toBe(true);
    expect(f.asked()).toBe(1);
    const name = await saveFile("report.docx", new Uint8Array([9, 9]), [{ name: "Word", extensions: ["docx"] }], null, f.h);
    expect(name).toBe("report.docx");
    expect(pickerCalls).toBe(0);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].closed).toBe(true);
    // a second save: written again, the browser is not asked again
    expect(await handleWritable(f.h)).toBe(true);
    expect(f.asked()).toBe(1);
  });

  it("leave to write refused: the save picker as before", async () => {
    const { saveFile, handleWritable } = await import("../../src/io/platform");
    const f = handle("report.docx", "prompt", "denied");
    expect(await handleWritable(f.h)).toBe(false);
    await saveFile("report.docx", new Uint8Array([9]), [{ name: "Word", extensions: ["docx"] }], null, f.h);
    expect(f.writes).toHaveLength(0);
    expect(pickerCalls).toBe(1);
  });

  it("no handle: the save picker", async () => {
    const { saveFile } = await import("../../src/io/platform");
    await saveFile("report.docx", new Uint8Array([9]), [{ name: "Word", extensions: ["docx"] }]);
    expect(pickerCalls).toBe(1);
  });

  it("a drop keeps each file's handle (getAsFileSystemHandle), a folder or a missing one is none", async () => {
    const { droppedFiles } = await import("../../src/ui/fileDrop");
    const a = handle("a.pptx").h;
    const files = [new File([new Uint8Array([1])], "a.pptx"), new File([new Uint8Array([2])], "b.hwpx"), new File([new Uint8Array([3])], "c.xlsx")];
    const gets = [async () => a, async () => ({ kind: "directory", name: "b" }), undefined];
    const dt = { files, items: files.map((_, i) => ({ kind: "file", getAsFileSystemHandle: gets[i] })) } as unknown as DataTransfer;
    const out = await droppedFiles(dt);
    expect(out.map((f) => f.name)).toEqual(["a.pptx", "b.hwpx", "c.xlsx"]);
    expect(out[0].handle).toBe(a);
    expect(out[1].handle).toBeNull();
    expect(out[2].handle).toBeNull();
    expect(Array.from(out[1].bytes)).toEqual([2]);
  });
});
