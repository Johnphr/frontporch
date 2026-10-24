// Convex exposes deployment env vars on process.env. Declared here so the
// functions typecheck without @types/node.
declare const process: { env: Record<string, string | undefined> };

/**
 * Writes (and private reads) come only from the Python backend, which sends
 * `secret`. Set the matching value once with:
 *   npx convex env set BACKEND_SECRET <value>
 */
export function assertBackend(secret: string): void {
  const expected = process.env.BACKEND_SECRET;
  if (!expected || secret !== expected) {
    throw new Error("Unauthorized");
  }
}

/** "+14155550123" -> "•••• 0123" */
export function maskPhone(phone: string): string {
  return `•••• ${phone.slice(-4)}`;
}

export function firstName(name: string | undefined): string {
  return (name ?? "A neighbor").trim().split(/\s+/)[0] || "A neighbor";
}
