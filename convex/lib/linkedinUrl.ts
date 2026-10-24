// Canonical LinkedIn post URLs, shared by apify.ts (scraped posts) and
// linkedapi.ts (posts we publish) so engagement rows match post rows.
// LinkedAPI returns ".../feed/update/urn:li:activity:<id>" while scrapers return
// ".../posts/<slug>-activity-<id>-<hash>"; both carry the same activity id.
// No runtime imports: unit-tested directly with Node.

/** The numeric activity id inside any LinkedIn post URL or URN, if present. */
export function linkedinActivityId(input?: string | null): string | undefined {
  if (!input) return undefined;
  let s = input;
  try {
    s = decodeURIComponent(input);
  } catch {
    // keep the raw string
  }
  const match = /(?:urn:li:activity:|[-/]activity[-:])(\d{6,})/i.exec(s);
  return match ? match[1] : undefined;
}

/**
 * One URL per post: https://www.linkedin.com/feed/update/urn:li:activity:<id>
 * when an activity id is found; otherwise the URL without query, hash or
 * trailing slash, on www.linkedin.com.
 */
export function canonicalLinkedInPostUrl(input?: string | null): string {
  const raw = (input ?? "").trim();
  if (!raw) return "";
  const id = linkedinActivityId(raw);
  if (id) return `https://www.linkedin.com/feed/update/urn:li:activity:${id}`;
  try {
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    url.hostname = url.hostname.replace(/^(?:[a-z]{2,3}\.)?linkedin\.com$/i, "www.linkedin.com");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return raw.replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}
