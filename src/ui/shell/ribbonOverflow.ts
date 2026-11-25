// A ribbon wider than the window (a laptop at 1024–1280 px: CAD's 유틸리티, two buttons of the document ribbon cut
// off — QA 11-24 basic-ux common #14) scrolls sideways instead of hiding its last groups: the wheel scrolls it, and
// » / « buttons at its edges show what is past them (Office folds groups; here nothing is hidden for good).

const MORE = "ribbon-more";

/** The ribbon and the part of it that scrolls sideways (its body under the tab row, else itself). */
function parts(): { rib: HTMLElement; box: HTMLElement } | null {
  const rib = document.querySelector<HTMLElement>(".ribbon.doc-ribbon");
  if (!rib) return null;
  return { rib, box: rib.querySelector<HTMLElement>(":scope > .rbody") ?? rib };
}

function sync(): void {
  const pr = parts();
  const rib = pr?.box;
  const btns = [...document.querySelectorAll<HTMLButtonElement>(`.${MORE}`)];
  const over = !!rib && rib.scrollWidth > rib.clientWidth + 2;
  if (!rib || !over) {
    for (const b of btns) b.hidden = true;
    return;
  }
  const r = pr!.rib.getBoundingClientRect();
  const [left, right] = btns.length === 2 ? btns : make();
  left.hidden = rib.scrollLeft <= 1;
  right.hidden = rib.scrollLeft + rib.clientWidth >= rib.scrollWidth - 1;
  // (over the ribbon's body, below its tab row)
  const tabs = pr!.rib.querySelector<HTMLElement>(".rtabs");
  const top = tabs ? tabs.getBoundingClientRect().bottom : r.top;
  for (const [b, x] of [
    [left, r.left],
    [right, r.right - 18],
  ] as const) {
    b.style.left = `${x}px`;
    b.style.top = `${top}px`;
    b.style.height = `${Math.max(20, r.bottom - top)}px`;
  }
}

function make(): [HTMLButtonElement, HTMLButtonElement] {
  for (const b of document.querySelectorAll(`.${MORE}`)) b.remove();
  const mk = (dir: -1 | 1) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = MORE;
    b.textContent = dir > 0 ? "»" : "«";
    b.setAttribute("aria-label", dir > 0 ? "»" : "«");
    b.addEventListener("click", () => {
      const rib = parts()?.box;
      rib?.scrollBy({ left: dir * rib.clientWidth * 0.6, behavior: "smooth" });
    });
    document.body.appendChild(b);
    return b;
  };
  return [mk(-1), mk(1)];
}

let installed = false;
/** Watch the ribbon's width (once, at start). */
export function installRibbonOverflow(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  let raf = 0;
  const later = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(sync);
  };
  window.addEventListener("resize", later);
  document.addEventListener("scroll", later, true);
  // the wheel over an overflowing ribbon scrolls it sideways
  document.addEventListener(
    "wheel",
    (e) => {
      const inRib = (e.target as Element | null)?.closest?.(".ribbon.doc-ribbon");
      const rib = inRib ? parts()?.box : null;
      if (!rib || rib.scrollWidth <= rib.clientWidth + 2 || e.ctrlKey) return;
      rib.scrollLeft += e.deltaY || e.deltaX;
      later();
    },
    { passive: true },
  );
  new MutationObserver(later).observe(document.body, { childList: true, subtree: true });
  later();
}
