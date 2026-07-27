import { Brief, Classification } from "./types";

/**
 * Process-lifetime caches. They survive across requests within a running
 * server and across Next dev HMR (via globalThis). This is deliberately
 * simple: a single-user desk tool doesn't need Redis. Everything resets on
 * a full server restart, which is fine.
 */
interface Store {
  classifications: Map<string, Classification>;
  brief: { data: Brief; at: number } | null;
}

const g = globalThis as unknown as { __goldpulse?: Store };

export const store: Store =
  g.__goldpulse ??
  (g.__goldpulse = {
    classifications: new Map(),
    brief: null,
  });
