// Mode tool lists (src/ui/modeTools/*): the profiles take them as they are, in order, with no tool twice and no
// tool key pointing at a tool the mode does not offer.
import { describe, expect, it } from "vitest";
import { PROFILES, CAD_PROFILE } from "../src/ui/editModes";
import { DOCUMENT_TOOLS } from "../src/ui/modeTools/document";
import { SLIDE_TOOLS } from "../src/ui/modeTools/slide";
import { IMAGE_KEYS, IMAGE_TOOLS } from "../src/ui/modeTools/image";
import { DESIGN_KEYS, DESIGN_TOOLS } from "../src/ui/modeTools/design";
import { PEN_GROUP } from "../src/ui/modeTools/penGroup";

describe("mode tool lists", () => {
  it("each profile uses its mode's list and keys, in order", () => {
    expect(PROFILES.DOCUMENT.tools).toEqual(DOCUMENT_TOOLS);
    expect(PROFILES.SLIDE.tools).toEqual(SLIDE_TOOLS);
    expect(PROFILES.IMAGE.tools).toEqual(IMAGE_TOOLS);
    expect(PROFILES.DESIGN.tools).toEqual(DESIGN_TOOLS);
    expect(PROFILES.IMAGE.keys).toEqual(IMAGE_KEYS);
    expect(PROFILES.DESIGN.keys).toEqual(DESIGN_KEYS);
    expect(PROFILES.DOCUMENT.keys).toEqual({});
    expect(PROFILES.SLIDE.keys).toEqual({});
    // the CAD screen is the design profile without tool letters
    expect(CAD_PROFILE.tools).toEqual(DESIGN_TOOLS);
    expect(CAD_PROFILE.keys).toEqual({});
  });
  it("the pen group sits whole in the image and design strips", () => {
    for (const list of [IMAGE_TOOLS, DESIGN_TOOLS]) {
      const i = list.indexOf(PEN_GROUP[0]);
      expect(list.slice(i, i + PEN_GROUP.length)).toEqual(PEN_GROUP);
    }
  });
  it("no tool twice in a mode, and every tool key opens a tool of that mode", () => {
    for (const p of Object.values(PROFILES)) {
      expect(new Set(p.tools).size, p.id).toBe(p.tools.length);
      for (const [k, t] of Object.entries(p.keys)) expect(p.tools, `${p.id} key ${k}`).toContain(t);
    }
  });
});
