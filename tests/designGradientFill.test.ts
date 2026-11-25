// 2026-11-24, features-ps-ai.md (Illustrator Gradient panel): a vector's fill turns linear / radial with colour stops
// and an angle; `fill` keeps the plain colour stand-in, and back to solid drops the gradient.
import { describe, expect, it } from "vitest";
import { angleOf, applyGradient, endsAt, gradientOf, newGradient } from "../src/ui/shell/GradientFill";
import { newVector } from "../src/core/types";
import { corner } from "../src/core/vector";

const rect = () => newVector([{ closed: true, nodes: [corner(0, 0), corner(100, 0), corner(100, 50), corner(0, 50)] }], "omni-rect");

describe("gradient fill", () => {
  it("a new gradient starts from the object's colour (white → black for white), left to right", () => {
    const g = newGradient("linear", "#e63946");
    expect(g.stops.map((s) => s.color.hex)).toEqual(["#e63946", "#ffffff"]);
    expect(angleOf(g)).toBe(0);
    expect(newGradient("linear", "#ffffff").stops.map((s) => s.color.hex)).toEqual(["#ffffff", "#000000"]);
    expect(newGradient("radial", null).from).toEqual([0.5, 0.5]);
  });

  it("the angle maps to the ends and back (counter-clockwise, Illustrator)", () => {
    for (const a of [0, 45, 90, -90, 135, 180]) expect(Math.abs(angleOf({ ...newGradient("linear", null), ...endsAt(a) }))).toBeCloseTo(Math.abs(a), 5);
    const up = endsAt(90);
    expect(up.to[1]).toBeLessThan(up.from[1]);
  });

  it("applying sets fills with sorted stops and a stand-in fill; null goes back to solid", () => {
    const v = rect();
    const g = newGradient("linear", "#000000");
    g.stops.reverse();
    applyGradient(v as never, g);
    const got = gradientOf(v)!;
    expect(got.stops.map((s) => s.at)).toEqual([0, 1]);
    expect(v.fill).toMatch(/^#[0-9a-f]{6}$/i);
    applyGradient(v as never, null, "#123456");
    expect(gradientOf(v)).toBeNull();
    expect(v.fill).toBe("#123456");
  });
});
