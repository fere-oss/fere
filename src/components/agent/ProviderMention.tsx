import React, { useEffect, useState } from "react";
import type { ProviderMentionHit } from "./providerLogos";
import { findProviderMentionHits, getLogoUrl, PROVIDER_ALIAS_MAP } from "./providerLogos";

export function ProviderMention({ text, logoUrl }: { text: string; logoUrl: string }) {
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
  }, [logoUrl]);

  return (
    <span className="agp-provider-ref">
      {!imgFailed && (
        <img
          src={logoUrl}
          alt=""
          className="agp-provider-logo"
          loading="lazy"
          decoding="async"
          referrerPolicy="origin"
          onError={() => setImgFailed(true)}
        />
      )}
      <strong>{text}</strong>
    </span>
  );
}

export function renderProviderMentionsInText(
  text: string,
  providerDomains: Record<string, string>,
): React.ReactNode {
  const hits = findProviderMentionHits(text, providerDomains);
  if (hits.length === 0) return text;

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  hits.forEach((hit: ProviderMentionHit, idx: number) => {
    if (hit.start > cursor) nodes.push(text.slice(cursor, hit.start));
    const logoUrl = getLogoUrl(hit.text, providerDomains);
    if (logoUrl) {
      nodes.push(
        <ProviderMention key={`provider-${idx}-${hit.start}`} text={hit.text} logoUrl={logoUrl} />,
      );
    } else {
      nodes.push(hit.text);
    }
    cursor = hit.end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

export function renderProviderMentionsInChildren(
  children: React.ReactNode,
  providerDomains: Record<string, string>,
): React.ReactNode {
  if (typeof children === "string") {
    return renderProviderMentionsInText(children, providerDomains);
  }
  if (children == null) return children;
  if (Array.isArray(children)) {
    return children.map((child, index) => (
      <React.Fragment key={index}>
        {renderProviderMentionsInChildren(child, providerDomains)}
      </React.Fragment>
    ));
  }
  if (!React.isValidElement(children)) return children;

  const element = children as React.ReactElement<{ children?: React.ReactNode }>;
  const elementType = typeof element.type === "string" ? element.type : "";
  if (
    elementType === "code" ||
    elementType === "pre" ||
    elementType === "a" ||
    elementType === "strong"
  ) {
    return element;
  }

  if (!("children" in element.props)) return element;
  return React.cloneElement(element, {
    ...element.props,
    children: renderProviderMentionsInChildren(element.props.children, providerDomains),
  });
}

// Re-export for consumers that need to call findProviderMentionHits + PROVIDER_ALIAS_MAP
export { findProviderMentionHits, PROVIDER_ALIAS_MAP };
