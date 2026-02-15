import { useEffect, useState } from "react";
import type { GraphNode } from "../../types/electron";
const BRAND_DOMAIN_BY_KEY: Record<string, string> = {
  openai: "openai.com",
  anthropic: "anthropic.com",
  groq: "groq.com",
  "google gemini": "ai.google.dev",
  gemini: "ai.google.dev",
  "azure openai": "azure.microsoft.com",
  "aws bedrock": "aws.amazon.com",
  cohere: "cohere.com",
  mistral: "mistral.ai",
  together: "together.ai",
  replicate: "replicate.com",
  "hugging face": "huggingface.co",
  huggingface: "huggingface.co",
  openrouter: "openrouter.ai",
  perplexity: "perplexity.ai",
  deepgram: "deepgram.com",
  elevenlabs: "elevenlabs.io",
  pinecone: "pinecone.io",
  weaviate: "weaviate.io",
  supabase: "supabase.com",
  firebase: "firebase.google.com",
  stripe: "stripe.com",
  twilio: "twilio.com",
  sendgrid: "sendgrid.com",
  mailgun: "mailgun.com",
  sentry: "sentry.io",
  posthog: "posthog.com",
  segment: "segment.com",
  amplitude: "amplitude.com",
  mixpanel: "mixpanel.com",
  algolia: "algolia.com",
  cloudflare: "cloudflare.com",
  vercel: "vercel.com",
  "storefront-web": "vercel.com",
  "storefront web": "vercel.com",
  "google chrome": "google.com",
  chrome: "google.com",
  onedrive: "onedrive.com",
  "one drive": "onedrive.com",
  raycast: "raycast.com",
  ollama: "ollama.com",
  github: "github.com",
  gitlab: "gitlab.com",
  "vs code": "code.visualstudio.com",
  vscode: "code.visualstudio.com",
  "visual studio code": "code.visualstudio.com",
  slack: "slack.com",
  discord: "discord.com",
  notion: "notion.so",
  cartesia: "cartesia.ai",
  deepseek: "deepseek.com",
  "x.ai": "x.ai",
  mongodb: "mongodb.com",
  postgres: "postgresql.org",
  postgresql: "postgresql.org",
  postman: "postman.com",
  mysql: "mysql.com",
  redis: "redis.io",
  rabbitmq: "rabbitmq.com",
  kafka: "kafka.apache.org",
  nats: "nats.io",
  nginx: "nginx.org",
  apache: "apache.org",
  docker: "docker.com",
  podman: "podman.io",
  "node.js": "nodejs.org",
  node: "nodejs.org",
  python: "python.org",
};

const RAW_LOGO_DEV_TOKEN = (process.env.REACT_APP_LOGO_DEV_TOKEN || "").trim();
const LOGO_DEV_TOKEN = RAW_LOGO_DEV_TOKEN.startsWith("pk_")
  ? RAW_LOGO_DEV_TOKEN
  : "";

if (
  process.env.NODE_ENV !== "production" &&
  RAW_LOGO_DEV_TOKEN &&
  !RAW_LOGO_DEV_TOKEN.startsWith("pk_")
) {
  // Logo.dev image CDN expects publishable keys in query param.
  // Secret keys should stay server-side only and are ignored here.
  // eslint-disable-next-line no-console
  console.warn(
    "[BrandIcon] REACT_APP_LOGO_DEV_TOKEN should be a publishable key (pk_...).",
  );
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function inferServiceBrand(
  node: Pick<GraphNode, "name" | "command" | "containerImage">,
): string | null {
  // Prefer service name and image over command to avoid
  // "docker: ..." strings forcing a Docker logo.
  const samples = [node.name, node.containerImage, node.command].filter(
    Boolean,
  ) as string[];
  for (const sample of samples) {
    const key = normalize(sample);
    if (BRAND_DOMAIN_BY_KEY[key]) return sample;
    for (const lookup of Object.keys(BRAND_DOMAIN_BY_KEY)) {
      if (key.includes(lookup)) return sample;
    }
    const host = extractDomainLike(sample);
    if (host) return host;
  }
  return null;
}

function toLogoDevUrl(domain: string): string {
  const params = new URLSearchParams({
    size: "64",
    format: "png",
    fallback: "monogram",
  });
  if (LOGO_DEV_TOKEN) {
    params.set("token", LOGO_DEV_TOKEN);
  }
  return `https://img.logo.dev/${domain}?${params.toString()}`;
}

function toLogoDevNameUrl(name: string): string {
  const params = new URLSearchParams({
    size: "64",
    format: "png",
    fallback: "monogram",
  });
  if (LOGO_DEV_TOKEN) {
    params.set("token", LOGO_DEV_TOKEN);
  }
  return `https://img.logo.dev/name/${encodeURIComponent(name)}?${params.toString()}`;
}

function isHostLike(value: string): boolean {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value);
}

function isReverseDnsBundleId(value: string): boolean {
  return /^(com|org|net|io|dev|app|ai)\.[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(
    value,
  );
}

function extractDomainLike(value: string): string | null {
  const match = value.match(/([a-z0-9.-]+\.[a-z]{2,})/i);
  return match ? match[1].toLowerCase() : null;
}

function getBrandImageUrl(value?: string | null): string | null {
  if (!value) return null;
  const key = normalize(value);
  if (BRAND_DOMAIN_BY_KEY[key]) {
    return toLogoDevUrl(BRAND_DOMAIN_BY_KEY[key]);
  }
  for (const [lookup, domain] of Object.entries(BRAND_DOMAIN_BY_KEY)) {
    if (key.includes(lookup)) return toLogoDevUrl(domain);
  }
  const extracted = extractDomainLike(key);
  if (extracted && isHostLike(extracted) && !isReverseDnsBundleId(extracted)) {
    return toLogoDevUrl(extracted);
  }
  if (isHostLike(key) && !isReverseDnsBundleId(key)) {
    return toLogoDevUrl(key);
  }
  if (key.length <= 80) {
    return toLogoDevNameUrl(key);
  }
  return null;
}

export function BrandIcon({
  value,
  className,
  size = 14,
}: {
  value?: string | null;
  className?: string;
  size?: number;
}) {
  const imageUrl = getBrandImageUrl(value);
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
  }, [imageUrl]);

  if (imageUrl && !imgFailed) {
    return (
      <span
        className={`brand-icon${className ? ` ${className}` : ""}`}
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <img
          src={imageUrl}
          alt=""
          className="brand-icon-image"
          loading="lazy"
          decoding="async"
          referrerPolicy="origin"
          onError={() => setImgFailed(true)}
        />
      </span>
    );
  }

  const fallback = value?.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className={`brand-icon brand-icon-fallback${className ? ` ${className}` : ""}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.floor(size * 0.62)),
      }}
      aria-hidden="true"
    >
      {fallback}
    </span>
  );
}
