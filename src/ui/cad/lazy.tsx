// The drawing screen's panels, loaded on first use (docs/design/CAD_SCREEN.md): the start-up bundle only holds these
// thin wrappers.
import { lazy, Suspense } from "react";

const load = () => import("./CadScreen");
const CommandLine = lazy(() => load().then((m) => ({ default: m.CadCommandLine })));
const Status = lazy(() => load().then((m) => ({ default: m.CadStatusBar })));
const Ribbon = lazy(() => load().then((m) => ({ default: m.CadRibbon })));
const Props = lazy(() => load().then((m) => ({ default: m.CadProps })));
const Layers = lazy(() => import("./LayerManager").then((m) => ({ default: m.CadLayerManager })));

export const CadCommandLine = () => (
  <Suspense fallback={null}>
    <CommandLine />
  </Suspense>
);
export const CadStatusBar = () => (
  <Suspense fallback={<footer className="statusbar" />}>
    <Status />
  </Suspense>
);
export const CadRibbon = ({ tab }: { tab: string }) => (
  <Suspense fallback={<div className="ribbon doc-ribbon" />}>
    <Ribbon tab={tab} />
  </Suspense>
);
export const CadProps = () => (
  <Suspense fallback={null}>
    <Props />
  </Suspense>
);
export const CadLayerManager = () => (
  <Suspense fallback={<div className="dock-body" />}>
    <Layers />
  </Suspense>
);
