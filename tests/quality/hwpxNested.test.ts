// HWPX import: objects nested in objects (a table inside a text box) are read once, in reading order.
import { DOMParser } from "@xmldom/xmldom";
import { strToU8, zipSync } from "fflate";
import { beforeAll, expect, it } from "vitest";
import { parseHwpx } from "../../src/io/office";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

it("a table inside a text box is not read twice", () => {
  const NS = `xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"`;
  const cell = `<hp:tc><hp:subList><hp:p><hp:run><hp:t>CELL</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc>`;
  const sec =
    `<hs:sec ${NS}><hp:p><hp:run><hp:rect><hp:drawText><hp:subList><hp:p><hp:run><hp:t>BOX</hp:t>` +
    `<hp:tbl rowCnt="1" colCnt="1"><hp:tr>${cell}</hp:tr></hp:tbl></hp:run></hp:p></hp:subList></hp:drawText></hp:rect></hp:run></hp:p>` +
    `<hp:p><hp:run><hp:t>AFTER</hp:t></hp:run></hp:p></hs:sec>`;
  const bytes = zipSync({ mimetype: strToU8("application/hwp+zip"), "Contents/section0.xml": strToU8(sec) });
  const texts = parseHwpx(bytes).map((p) => p.runs.map((r) => r.text).join(""));
  expect(texts).toEqual(["BOX", "CELL", "AFTER"]);
});
