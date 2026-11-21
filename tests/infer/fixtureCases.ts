// The pictures behind tests/fixtures/matte/u2netp-ref.bin (regenerated with tests/infer/fixture.dev.test.ts).
import type { Img } from "../../src/core/image/pixels";
import { portraitCase, productCase, animalCase } from "../matte/synth";

export const FIXTURE_CASES = (): Img[] => [portraitCase(5, 160, 180).img, productCase(7, 200, 200).img, animalCase(9, 210, 170).img];
