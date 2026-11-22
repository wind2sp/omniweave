// Types for scripts/web-pwa.mjs (vite.config.ts and tests import it; tsc has no Node types).
import type { Plugin } from "vite";

export const WEB_DIR: string;
export function precacheList(files: string[]): string[];
export function swSource(template: string, build: string, precache: string[], models: string): string;
export function splashLink(file: string): { href: string; media: string } | null;
export function webPwa(enabled?: boolean): Plugin;
