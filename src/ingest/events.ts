/**
 * Event ingest and deduplication.
 *
 * The same filing routinely arrives from more than one source — an exchange
 * announcement and a news article about it. Deduplication is by explicit key,
 * and a primary exchange filing always wins over a secondary news item for the
 * same event, because the filing is the fact and the article is a report of it.
 */

import type { Db } from '../db/driver.ts';
import type { RawAnnouncement } from '../market/types.ts';

export interface EventIngestStats {
  inserted: number;
  duplicates: number;
  upgraded: number;
}

/**
 * Coarse identity for cross-source matching: symbol plus filing date plus a
 * normalised headline prefix. Deliberately conservative — collapsing two
 * genuinely different events is worse than storing one twice.
 */
export function crossSourceKey(a: RawAnnouncement): string | null {
  if (!a.symbol) return null;
  const day = (a.filedAt ?? a.detectedAt).slice(0, 10);
  const words = a.headline
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 6)
    .join('-');
  return `${a.symbol}:${day}:${words}`;
}

export function ingestAnnouncements(
  db: Db,
  announcements: readonly RawAnnouncement[],
): EventIngestStats {
  const stats: EventIngestStats = { inserted: 0, duplicates: 0, upgraded: 0 };

  db.transaction(() => {
    for (const a of announcements) {
      const existing = db.get<{ id: number; source_tier: string }>(
        'SELECT id, source_tier FROM events WHERE dedupe_key = ?',
        a.dedupeKey,
      );
      if (existing) {
        stats.duplicates++;
        continue;
      }

      // Cross-source: has this same event already arrived from another source?
      const key = crossSourceKey(a);
      if (key) {
        const related = db.get<{ id: number; source_tier: string }>(
          `SELECT id, source_tier FROM events
            WHERE symbol = ?
              AND substr(COALESCE(filed_at, detected_at), 1, 10) = ?
              AND lower(headline) LIKE ?`,
          a.symbol,
          (a.filedAt ?? a.detectedAt).slice(0, 10),
          `${a.headline.slice(0, 30).toLowerCase()}%`,
        );

        if (related) {
          // A primary filing replaces a secondary report of the same event.
          if (
            a.sourceTier === 'PRIMARY_EXCHANGE' &&
            related.source_tier === 'SECONDARY_NEWS'
          ) {
            db.run(
              `UPDATE events
                  SET source_id = ?, source_tier = ?, dedupe_key = ?,
                      filed_at = ?, headline = ?, attachment_url = ?
                WHERE id = ?`,
              a.sourceId,
              a.sourceTier,
              a.dedupeKey,
              a.filedAt,
              a.headline,
              a.attachmentUrl ?? null,
              related.id,
            );
            stats.upgraded++;
          } else {
            stats.duplicates++;
          }
          continue;
        }
      }

      const lagSec =
        a.filedAt !== null
          ? Math.round(
              (new Date(a.detectedAt).getTime() - new Date(a.filedAt).getTime()) / 1000,
            )
          : null;

      db.run(
        `INSERT INTO events
           (symbol, exchange, filed_at, detected_at, detection_lag_sec,
            headline, attachment_url, source_id, source_tier, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.symbol,
        a.exchange,
        a.filedAt,
        a.detectedAt,
        lagSec,
        a.headline,
        a.attachmentUrl ?? a.url ?? null,
        a.sourceId,
        a.sourceTier,
        a.dedupeKey,
      );
      stats.inserted++;
    }
  });

  return stats;
}
