import type { ExternalApiProvider } from "../../types/electron";

export const PROVIDER_ALIAS_MAP: Record<string, string> = {
  gemini: "google gemini",
  aws: "aws bedrock",
  bedrock: "aws bedrock",
};

const RAW_LOGO_TOKEN = (window.electronAPI.logoDevToken || "").trim();
export const LOGO_TOKEN = RAW_LOGO_TOKEN.startsWith("pk_") ? RAW_LOGO_TOKEN : "";

export function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeDomain(domain: string): string | null {
  const cleaned = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .split(":")[0];
  if (!cleaned || !cleaned.includes(".")) return null;
  const parts = cleaned.split(".").filter(Boolean);
  if (parts.length < 2) return null;
  const secondLevelSuffixes = new Set(["co", "com", "org", "net", "gov", "ac"]);
  if (parts.length >= 3) {
    const tld = parts[parts.length - 1];
    const sld = parts[parts.length - 2];
    if (tld.length === 2 && secondLevelSuffixes.has(sld)) {
      return parts.slice(-3).join(".");
    }
  }
  return parts.slice(-2).join(".");
}

export function buildProviderDomainMap(
  providers: ExternalApiProvider[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const provider of providers) {
    const key = normalizeLabel(provider.name);
    const domains = Array.isArray(provider.domains) ? provider.domains : [];
    let selected = "";
    for (const domain of domains) {
      const normalized = normalizeDomain(domain);
      if (!normalized) continue;
      if (!selected) selected = normalized;
      if (!domain.toLowerCase().startsWith("api.")) {
        selected = normalized;
        break;
      }
    }
    if (selected) map[key] = selected;
  }
  return map;
}

export type ProviderMentionHit = {
  start: number;
  end: number;
  text: string;
};

function isWordChar(char: string): boolean {
  return /[a-z0-9]/i.test(char);
}

function hasTokenBoundaries(text: string, start: number, length: number): boolean {
  const before = start > 0 ? text[start - 1] : "";
  const after = start + length < text.length ? text[start + length] : "";
  return (!before || !isWordChar(before)) && (!after || !isWordChar(after));
}

export function findProviderMentionHits(
  text: string,
  providerDomains: Record<string, string>,
): ProviderMentionHit[] {
  if (!text.trim()) return [];
  const lookupTerms = Array.from(
    new Set([...Object.keys(providerDomains), ...Object.keys(PROVIDER_ALIAS_MAP)]),
  ).sort((a, b) => b.length - a.length);
  if (lookupTerms.length === 0) return [];

  const lower = text.toLowerCase();
  const hits: ProviderMentionHit[] = [];
  let cursor = 0;

  while (cursor < lower.length) {
    let bestStart = -1;
    let bestEnd = -1;
    for (const term of lookupTerms) {
      let idx = lower.indexOf(term, cursor);
      while (idx !== -1 && !hasTokenBoundaries(lower, idx, term.length)) {
        idx = lower.indexOf(term, idx + 1);
      }
      if (idx === -1) continue;
      const end = idx + term.length;
      if (bestStart === -1 || idx < bestStart || (idx === bestStart && end > bestEnd)) {
        bestStart = idx;
        bestEnd = end;
      }
    }
    if (bestStart === -1) break;
    hits.push({ start: bestStart, end: bestEnd, text: text.slice(bestStart, bestEnd) });
    cursor = bestEnd;
  }

  return hits;
}

export function getLogoUrl(
  name: string,
  providerDomains: Record<string, string>,
): string | null {
  const normalizedName = normalizeLabel(name);
  const aliased = PROVIDER_ALIAS_MAP[normalizedName];
  const domain =
    providerDomains[normalizedName] ||
    (aliased ? providerDomains[aliased] : "");
  if (!domain) return null;
  const params = new URLSearchParams({
    size: "32",
    format: "png",
    fallback: "monogram",
  });
  params.set("token", LOGO_TOKEN || "pk_free");
  return `https://img.logo.dev/${encodeURIComponent(domain)}?${params.toString()}`;
}
