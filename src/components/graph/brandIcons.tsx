import type { GraphNode } from "../../types/electron";
import {
  siAlgolia,
  siAnthropic,
  siApache,
  siApachekafka,
  siCloudflare,
  siDeepgram,
  siDiscord,
  siDocker,
  siElevenlabs,
  siFirebase,
  siGithub,
  siGitlab,
  siGooglegemini,
  siHuggingface,
  siMailgun,
  siMistralai,
  siMixpanel,
  siMongodb,
  siMysql,
  siNatsdotio,
  siNginx,
  siNodedotjs,
  siNotion,
  siOpenaigym,
  siOpenrouter,
  siPerplexity,
  siPodman,
  siPostgresql,
  siPosthog,
  siPython,
  siRabbitmq,
  siRedis,
  siReplicate,
  siSentry,
  siStripe,
  siSupabase,
} from "simple-icons";

type IconData = { title: string; hex: string; path: string };

const ICONS_BY_KEY: Record<string, IconData> = {
  algolia: siAlgolia,
  anthropic: siAnthropic,
  apache: siApache,
  kafka: siApachekafka,
  cloudflare: siCloudflare,
  deepgram: siDeepgram,
  discord: siDiscord,
  docker: siDocker,
  elevenlabs: siElevenlabs,
  firebase: siFirebase,
  github: siGithub,
  gitlab: siGitlab,
  gemini: siGooglegemini,
  "google gemini": siGooglegemini,
  "hugging face": siHuggingface,
  huggingface: siHuggingface,
  mailgun: siMailgun,
  mistral: siMistralai,
  "mistral ai": siMistralai,
  mixpanel: siMixpanel,
  mongodb: siMongodb,
  mysql: siMysql,
  nats: siNatsdotio,
  "nats.io": siNatsdotio,
  nginx: siNginx,
  node: siNodedotjs,
  "node.js": siNodedotjs,
  notion: siNotion,
  openai: siOpenaigym,
  openrouter: siOpenrouter,
  perplexity: siPerplexity,
  podman: siPodman,
  postgresql: siPostgresql,
  postgres: siPostgresql,
  posthog: siPosthog,
  python: siPython,
  rabbitmq: siRabbitmq,
  redis: siRedis,
  replicate: siReplicate,
  sentry: siSentry,
  stripe: siStripe,
  supabase: siSupabase,
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function getBrandIconData(value?: string | null): IconData | null {
  if (!value) return null;
  const key = normalize(value);
  if (ICONS_BY_KEY[key]) return ICONS_BY_KEY[key];

  for (const [lookup, icon] of Object.entries(ICONS_BY_KEY)) {
    if (key.includes(lookup)) return icon;
  }
  return null;
}

export function inferServiceBrand(node: Pick<GraphNode, "name" | "command" | "containerImage">): string | null {
  const samples = [node.name, node.command, node.containerImage].filter(Boolean) as string[];
  for (const sample of samples) {
    const icon = getBrandIconData(sample);
    if (icon) return icon.title;
  }
  return null;
}

export function BrandIcon({
  value,
  className,
  size = 14,
  useBrandColor = true,
}: {
  value?: string | null;
  className?: string;
  size?: number;
  useBrandColor?: boolean;
}) {
  const icon = getBrandIconData(value);
  if (!icon) {
    const fallback = value?.trim().charAt(0).toUpperCase() || "?";
    return (
      <span
        className={`brand-icon brand-icon-fallback${className ? ` ${className}` : ""}`}
        style={{ width: size, height: size, fontSize: Math.max(9, Math.floor(size * 0.62)) }}
        aria-hidden="true"
      >
        {fallback}
      </span>
    );
  }

  return (
    <span
      className={`brand-icon${className ? ` ${className}` : ""}`}
      style={{
        width: size,
        height: size,
        color: useBrandColor ? `#${icon.hex}` : undefined,
      }}
      title={icon.title}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" fill="currentColor" role="img" aria-hidden="true">
        <path d={icon.path} />
      </svg>
    </span>
  );
}
