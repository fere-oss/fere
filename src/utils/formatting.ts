export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function getAuthAvatarFallback(label: string | null | undefined): string {
  const source = (label || "").trim();
  if (!source) return "?";

  const parts = source
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
  }

  const condensed = source.replace(/[^a-zA-Z0-9]/g, "");
  return (condensed.slice(0, 2) || source.slice(0, 2)).toUpperCase();
}
