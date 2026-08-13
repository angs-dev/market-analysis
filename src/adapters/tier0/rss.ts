/**
 * RSS / Atom adapter — Tier 0.
 *
 * Secondary signal only. Per the project's own rules a news article never
 * triggers a signal on its own; it corroborates a primary exchange filing.
 * Every announcement produced here is tagged SECONDARY_NEWS, and downstream
 * scoring weights it accordingly.
 *
 * Fetching goes through the SourceGovernor, so cadence, rate limits, backoff
 * and the 403 hard-stop all apply. The fetcher is injected so the parsing and
 * symbol-matching logic is testable against fixtures with no network.
 */

import { findAll, findFirst, parseXml, childText, type XmlNode } from '../../parse/xml.ts';
import { tryParseTimestamp } from '../../parse/dates.ts';
import { HttpStatusError } from '../../sources/errors.ts';
import type { SourceGovernor } from '../../sources/governor.ts';
import type { RawAnnouncement } from '../../market/types.ts';

export const RSS_SOURCE_ID = 'rss_news';

export type Fetcher = (url: string) => Promise<string>;

export interface RssFeedConfig {
  url: string;
  /** Label recorded against items from this feed. */
  publisher: string;
}

export interface RssAdapterOptions {
  governor: SourceGovernor;
  feeds: RssFeedConfig[];
  fetcher?: Fetcher;
  sourceId?: string;
}

export interface RssItem {
  title: string;
  link?: string;
  description?: string;
  publishedAt: string | null;
  guid?: string;
}

/** Extracts items from RSS 2.0 (`<item>`) or Atom (`<entry>`) documents. */
export function parseFeed(xml: string): RssItem[] {
  const doc = parseXml(xml);
  const isAtom = findFirst(doc, 'entry') !== undefined && findFirst(doc, 'item') === undefined;
  const nodes = isAtom ? findAll(doc, 'entry') : findAll(doc, 'item');

  return nodes.map((node) => {
    const item: RssItem = {
      title: (childText(node, 'title') ?? '').replace(/\s+/g, ' ').trim(),
      publishedAt: tryParseTimestamp(
        childText(node, 'pubdate') ??
          childText(node, 'published') ??
          childText(node, 'updated') ??
          childText(node, 'date'),
      ),
    };

    const link = extractLink(node);
    const description = childText(node, 'description') ?? childText(node, 'summary');
    const guid = childText(node, 'guid') ?? childText(node, 'id');
    if (link) item.link = link;
    if (description) item.description = description.replace(/\s+/g, ' ').trim();
    if (guid) item.guid = guid;
    return item;
  });
}

function extractLink(node: XmlNode): string | undefined {
  const el = node.children.find((c) => c.name === 'link');
  if (!el) return undefined;
  // RSS puts the URL in the text; Atom puts it in an href attribute.
  return el.text.trim() || el.attrs['href'] || undefined;
}

/**
 * Matches known symbols in a headline.
 *
 * Deliberately conservative: whole-word, case-insensitive matches against the
 * supplied symbol and company-name list only. A headline that matches nothing
 * yields an announcement with a null symbol rather than a guess — attributing
 * news to the wrong company is worse than attributing it to none.
 */
export function matchSymbols(
  text: string,
  index: ReadonlyMap<string, string>,
): string[] {
  const haystack = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const hits = new Set<string>();
  for (const [needle, symbol] of index) {
    if (needle.length < 3) continue;
    if (haystack.includes(` ${needle} `)) hits.add(symbol);
  }
  return [...hits];
}

/** Builds the lookup used by matchSymbols. Keys are normalised lower-case. */
export function buildSymbolIndex(
  instruments: readonly { symbol: string; name?: string }[],
): Map<string, string> {
  const index = new Map<string, string>();
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  for (const { symbol, name } of instruments) {
    index.set(norm(symbol), symbol);
    if (!name) continue;
    // Drop common suffixes so "Astral Limited" matches a headline saying "Astral".
    const stripped = norm(name)
      .replace(/\b(limited|ltd|india|industries|enterprises|corporation|corp|inc|plc)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (stripped.length >= 3) index.set(stripped, symbol);
  }
  return index;
}

export async function defaultFetcher(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
    redirect: 'follow',
  });
  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after');
    const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
    throw new HttpStatusError(
      response.status,
      Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
    );
  }
  return response.text();
}

export class RssAdapter {
  readonly sourceId: string;
  readonly #governor: SourceGovernor;
  readonly #feeds: RssFeedConfig[];
  readonly #fetcher: Fetcher;

  constructor(opts: RssAdapterOptions) {
    this.sourceId = opts.sourceId ?? RSS_SOURCE_ID;
    this.#governor = opts.governor;
    this.#feeds = opts.feeds;
    this.#fetcher = opts.fetcher ?? defaultFetcher;
  }

  /**
   * Fetches every configured feed and returns announcements.
   *
   * A failing feed does not abort the others — one publisher being down should
   * not blind the whole run. Failures are returned alongside the results so the
   * caller can surface them rather than silently seeing fewer items.
   */
  async fetchAll(
    symbolIndex: ReadonlyMap<string, string>,
  ): Promise<{ announcements: RawAnnouncement[]; failures: { url: string; error: string }[] }> {
    const announcements: RawAnnouncement[] = [];
    const failures: { url: string; error: string }[] = [];

    for (const feed of this.#feeds) {
      try {
        const xml = await this.#governor.execute(
          this.sourceId,
          () => this.#fetcher(feed.url),
          { urlHash: feed.url },
        );
        announcements.push(...this.toAnnouncements(parseFeed(xml), feed, symbolIndex));
      } catch (err) {
        failures.push({ url: feed.url, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { announcements, failures };
  }

  toAnnouncements(
    items: readonly RssItem[],
    feed: RssFeedConfig,
    symbolIndex: ReadonlyMap<string, string>,
  ): RawAnnouncement[] {
    const detectedAt = new Date().toISOString();
    const out: RawAnnouncement[] = [];

    for (const item of items) {
      if (item.title === '') continue;
      const matches = matchSymbols(`${item.title} ${item.description ?? ''}`, symbolIndex);
      // One announcement per matched symbol; unmatched items are kept with a
      // null symbol so nothing is silently discarded.
      const symbols: (string | null)[] = matches.length > 0 ? matches : [null];

      for (const symbol of symbols) {
        const announcement: RawAnnouncement = {
          dedupeKey: `${this.sourceId}:${feed.publisher}:${item.guid ?? item.link ?? item.title}:${symbol ?? '-'}`,
          symbol,
          exchange: null,
          headline: item.title,
          filedAt: item.publishedAt,
          detectedAt,
          sourceId: this.sourceId,
          sourceTier: 'SECONDARY_NEWS',
        };
        if (item.link) announcement.url = item.link;
        if (item.description) announcement.body = item.description;
        out.push(announcement);
      }
    }
    return out;
  }
}
