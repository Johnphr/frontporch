import { useCallback, useState } from "react";

// Runs a backend call while tracking busy state and the last message/error.
export function useBackendAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, success?: (result: T) => string) => {
      setBusy(key);
      setMessage(null);
      try {
        const result = await fn();
        if (success) setMessage({ kind: "ok", text: success(result) });
        return result;
      } catch (err) {
        setMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) });
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  return { busy, message, run, clear: () => setMessage(null) };
}
