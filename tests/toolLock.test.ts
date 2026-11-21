// Text and shape tools hand back to the select tool after one object; a double-clicked (locked) tool stays.
import { beforeEach, describe, expect, it } from "vitest";
import { chooseTool, toolDone, useStore } from "../src/core/store";

const S = () => useStore.getState();

describe("one-shot tools and tool lock", () => {
  beforeEach(() => chooseTool("select"));

  it("text / rect / ellipse return to select after one object", () => {
    for (const t of ["text", "rect", "ellipse"] as const) {
      chooseTool(t);
      toolDone(t);
      expect(S().tool).toBe("select");
    }
  });

  it("pen, brush and eraser keep going", () => {
    for (const t of ["pen", "brush", "eraser"] as const) {
      chooseTool(t);
      toolDone(t);
      expect(S().tool).toBe(t);
    }
  });

  it("a locked tool stays until clicked again", () => {
    chooseTool("text", true);
    toolDone("text");
    toolDone("text");
    expect(S().tool).toBe("text");
    chooseTool("text"); // click on the locked tool releases it
    expect(S().toolLocked).toBe(false);
    toolDone("text");
    expect(S().tool).toBe("select");
  });

  it("switching tools any other way (shortcut, panel button) ends the lock", () => {
    chooseTool("rect", true);
    S().set({ tool: "brush" });
    expect(S().toolLocked).toBe(false);
    S().set({ tool: "rect" });
    toolDone("rect");
    expect(S().tool).toBe("select");
  });

  it("a tool picked while a text box is open survives the box closing", () => {
    chooseTool("text");
    chooseTool("rect"); // toolbar click while editing (the editor stays open)
    toolDone("text"); // the next canvas press closes the editor
    expect(S().tool).toBe("rect");
  });
});
