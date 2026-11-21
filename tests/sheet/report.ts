// Engine half of scripts/fidelity-xlsx.mjs (run with vite-node): the measure of tests/sheet/measure.ts as JSON on stdout.
import { measure } from "./measure";

const book = process.argv[2] ?? "qa/interop/excel-made/omni-xlsx-fidelity.xlsx";
const truth = process.argv[3] ?? book.replace(/\.xlsx$/, ".truth.json");
process.stdout.write("@@JSON" + JSON.stringify(measure(book, truth, "ko")) + "\n");
