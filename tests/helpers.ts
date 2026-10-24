import { readFileSync } from "node:fs";

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
}

/** Fixed clock for every test: 2026-10-24 12:00 UTC */
export const NOW = Date.parse("2026-10-24T12:00:00.000Z");
