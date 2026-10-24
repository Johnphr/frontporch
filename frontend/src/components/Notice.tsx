export default function Notice({
  message,
}: {
  message: { kind: "ok" | "error"; text: string } | null;
}) {
  if (!message) return null;
  return (
    <p className={`notice notice-${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>
      {message.text}
    </p>
  );
}
