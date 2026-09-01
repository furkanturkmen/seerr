import { MediaStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import type { User } from '@server/entity/User';
import logger from '@server/logger';
import { Not, IsNull } from 'typeorm';

/**
 * Who may see which titles, decided from the tags that blocklisted them.
 *
 * Lives in lib rather than beside the middleware because the request entity
 * needs the same answer, and an entity importing a middleware pulls express
 * into the entity graph - which broke the build and would have risked a
 * require cycle even when it did not.
 *
 * The original note follows.
 *
 * Hide, per user, the titles their blocked tags cover.
 *
 * The blocklist itself stays global and the job that fills it is untouched.
 * Every blocklist row already records which keyword ids matched it, so who a
 * title is hidden from is a set intersection over data the server has already
 * computed - no second crawl, and no per-user state beyond a list of ids.
 *
 * It runs as one middleware rather than at the call sites because the mappers
 * are invoked from about fourteen places in the discover routes alone, plus
 * search, watchlist, collections and the detail routes. Filtering there would
 * mean finding every one of them and finding each new one forever after. This
 * wraps `res.json` once, after `checkUser` has attached the user, and covers
 * every route mounted below it.
 *
 * Until the tag crawler has indexed anything - the state before any of this is
 * configured - every request short-circuits on one cached lookup.
 *
 * After that it runs for everyone, including unfiltered users, and that is
 * deliberate. A tag-driven title reads as BLOCKLISTED to the whole site, so
 * the people the tag does *not* apply to need their status put back or the
 * request button vanishes for them too. Gating on "is this user filtered"
 * alone hid the button from the administrator who set the filter up.
 */

/** How long the blocklist snapshot is trusted. It changes only when the job runs. */
const CACHE_TTL_MS = 60_000;

type Snapshot = { at: number; byKey: Map<string, number[]> };
let snapshot: Snapshot | null = null;

/** `movie:603` - mediaType is part of the key because a tmdb id is not unique across types. */
export const keyOf = (mediaType: string, tmdbId: number): string => `${mediaType}:${tmdbId}`;

/**
 * Which keyword ids blocklisted each title.
 *
 * Stored by the job as `,12,34,` - leading and trailing commas, so that a
 * substring test for `,12,` cannot match 123. Parsed the same way here.
 */
const parseTags = (raw?: string | null): number[] =>
  (raw ?? '')
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

export async function loadSnapshot(): Promise<Snapshot> {
  if (snapshot && Date.now() - snapshot.at < CACHE_TTL_MS) {
    return snapshot;
  }

  const rows = await getRepository(Blocklist).find({
    where: { blocklistedTags: Not(IsNull()) },
    select: { tmdbId: true, mediaType: true, blocklistedTags: true },
  });

  const byKey = new Map<string, number[]>();
  for (const row of rows) {
    const tags = parseTags(row.blocklistedTags);
    if (tags.length) {
      byKey.set(keyOf(row.mediaType, row.tmdbId), tags);
    }
  }

  snapshot = { at: Date.now(), byKey };
  return snapshot;
}

/** Drop the snapshot, so the next request sees a blocklist that has just changed. */
export const invalidateContentFilter = (): void => {
  snapshot = null;
};

/** The titles this user must not see, or null when they are unfiltered. */
export async function blockedFor(user?: User): Promise<Set<string> | null> {
  const wanted = (user?.settings?.blockedTags ?? [])
    .map((tag) => Number(tag))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!wanted.length) {
    return null;
  }

  const { byKey } = await loadSnapshot();
  const blocked = new Set<string>();
  for (const [key, tags] of byKey) {
    if (tags.some((tag) => wanted.includes(tag))) {
      blocked.add(key);
    }
  }
  return blocked;
}

/**
 * Whether one title is hidden from this user.
 *
 * For the places that decide rather than render - the request route above all.
 * Hiding a title in the lists and then accepting a POST for it would make the
 * filter a matter of not knowing the id.
 */
export async function isBlockedForUser(
  user: User | undefined,
  mediaType: string,
  tmdbId: number
): Promise<boolean> {
  const blocked = await blockedFor(user);
  return blocked ? blocked.has(keyOf(mediaType, tmdbId)) : false;
}

/**
 * Whether a blocklisted title was blocklisted by a *tag* rather than by hand.
 *
 * The distinction is the whole feature. A title the crawler picked up because
 * it carries a tag is only blocklisted for the people filtered on that tag -
 * otherwise turning the crawler on would take the library away from the
 * administrator who configured it, which is the global behaviour this fork
 * exists to escape.
 *
 * A title somebody blocklisted by hand has no tags recorded against it, and
 * stays blocked for everyone: that is what pressing the button meant.
 */
export async function isTagDriven(
  mediaType: string,
  tmdbId: number
): Promise<boolean> {
  const { byKey } = await loadSnapshot();
  return byKey.has(keyOf(mediaType, tmdbId));
}
