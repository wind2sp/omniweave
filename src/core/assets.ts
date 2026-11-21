// Content-addressed blob threads (images, PDFs, fonts). Immutable, so they never take part in undo.
import { hashBytes } from "./hash";
import { uid, type AssetRef } from "./types";

const blobs = new Map<string, Uint8Array>();
const listeners = new Set<() => void>();

export function putBlob(bytes: Uint8Array): string {
  const h = hashBytes(bytes);
  if (!blobs.has(h)) blobs.set(h, bytes);
  return h;
}

export function getBlob(hash: string): Uint8Array | undefined {
  return blobs.get(hash);
}

export function hasBlob(hash: string): boolean {
  return blobs.has(hash);
}

export function makeAsset(bytes: Uint8Array, mime: string, name: string): AssetRef {
  const hash = putBlob(bytes);
  listeners.forEach((l) => l());
  return { id: uid("as"), hash, mime, name, size: bytes.length };
}

export function onBlobsChanged(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function extForMime(mime: string): string {
  return (
    {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
      "image/gif": "gif",
      "image/svg+xml": "svg",
      "application/pdf": "pdf",
      "font/ttf": "ttf",
      "font/woff2": "woff2",
    } as Record<string, string>
  )[mime] ?? "bin";
}
