// QA doc-gaps-1: 쪽 설정 "이 구역" / "문서 전체" acts on pages of the current page's kind only (slides, design and PDF
// pages of the same document keep their size).
import { describe, expect, it } from "vitest";
import { newPage } from "../src/core/types";
import { scopePages } from "../src/ui/pageSetupActions";

describe("page setup scope", () => {
  const pages = [newPage("DOCUMENT", 794, 1123), newPage("SLIDE", 1920, 1080), newPage("DOCUMENT", 794, 1123), newPage("DESIGN", 1000, 1000)];
  it("whole document = every page of this kind", () => {
    expect(scopePages(pages, 0, "document")).toEqual([0, 2]);
    expect(scopePages(pages, 1, "document")).toEqual([1]);
  });
  it("this section skips other kinds; this page is just the page", () => {
    expect(scopePages(pages, 2, "section")).toEqual([0, 2]);
    expect(scopePages(pages, 3, "page")).toEqual([3]);
  });
});
