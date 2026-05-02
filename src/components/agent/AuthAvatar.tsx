import React, { useEffect, useState } from "react";

function getAvatarFallbackText(label: string | null | undefined): string {
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

export function AuthAvatar({
  avatarUrl,
  label,
}: {
  avatarUrl: string | null;
  label: string | null;
}): React.ReactElement {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [avatarUrl]);

  if (!avatarUrl || failed) {
    return (
      <div className="agp-auth-avatar agp-auth-avatar-fallback" aria-hidden="true">
        {getAvatarFallbackText(label)}
      </div>
    );
  }

  return (
    <img
      src={avatarUrl}
      alt=""
      className="agp-auth-avatar"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
