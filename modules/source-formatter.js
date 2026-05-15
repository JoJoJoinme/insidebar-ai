const PRIVATE_IPV4_RANGES = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./
];

export function shouldIncludeSourceUrl(pageUrl) {
  if (!pageUrl || typeof pageUrl !== 'string') {
    return false;
  }

  try {
    const url = new URL(pageUrl);
    const hostname = url.hostname.toLowerCase();

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return false;
    }

    if (hostname === 'localhost' || hostname === '[::1]' || hostname.endsWith('.localhost')) {
      return false;
    }

    if (PRIVATE_IPV4_RANGES.some((pattern) => pattern.test(hostname))) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export function formatContentWithSource(text, pageUrl, placement = 'end') {
  if (!shouldIncludeSourceUrl(pageUrl) || placement === 'none') {
    return text;
  }

  if (placement === 'beginning') {
    return `Source: ${pageUrl}\n\n${text}`;
  }

  return `${text}\n\nSource: ${pageUrl}`;
}

export function formatExtractedContentWithSource(extracted, placement = 'end') {
  const titleLine = `[${extracted.title}]`;
  const content = `${titleLine}\n\n${extracted.content}`;
  return formatContentWithSource(content, extracted.url, placement);
}
