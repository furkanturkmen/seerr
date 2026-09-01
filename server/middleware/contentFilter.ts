import { getRepository } from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import type { User } from '@server/entity/User';
import logger from '@server/logger';
import type { NextFunction, Request, Response } from 'express';
import { Not, IsNull } from 'typeorm';

/**
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
 * A user with no blocked tags - which is everyone until somebody sets one -
 * short-circuits before any of this, so the cost for an unfiltered account is
 * one property read.
 */

/** How long the blocklist snapshot is trusted. It changes only when the job runs. */
const CACHE_TTL_MS = 60_000;

type Snapshot = { at: number; byKey: Map<string, number[]> };
let snapshot: Snapshot | null = null;

/** `movie:603` - mediaType is part of the key because a tmdb id is not unique across types. */
const keyOf = (mediaType: string, tmdbId: number): string => `${mediaType}:${tmdbId}`;

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

async function loadSnapshot(): Promise<Snapshot> {
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
async function blockedFor(user?: User): Promise<Set<string> | null> {
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

const isBlocked = (blocked: Set<string>, item: unknown): boolean => {
  if (!item || typeof item !== 'object') {
    return false;
  }
  const { id, mediaType } = item as { id?: unknown; mediaType?: unknown };
  if (typeof id !== 'number' || typeof mediaType !== 'string') {
    return false;
  }
  return blocked.has(keyOf(mediaType, id));
};

/**
 * Strip blocked entries from a payload, or report the whole thing blocked.
 *
 * Only the two shapes that carry media are touched - `results` from every
 * paginated list, and `parts` from a collection. Anything else is returned as
 * it came: this middleware sits in front of settings, issues and user routes
 * too, and must not rewrite payloads it does not understand.
 *
 * The counts beside `results` are left alone deliberately. They describe the
 * TMDB query rather than this page, the pagination is TMDB's, and rewriting
 * them to match a filtered page would make "page 2 of 500" disagree with
 * itself. A short page is the honest result.
 */
function filterPayload(body: unknown, blocked: Set<string>): unknown {
  if (!body || typeof body !== 'object') {
    return body;
  }

  const payload = body as Record<string, unknown>;

  if (Array.isArray(payload.results)) {
    return {
      ...payload,
      results: payload.results.filter((item) => !isBlocked(blocked, item)),
    };
  }

  if (Array.isArray(payload.parts)) {
    return {
      ...payload,
      parts: payload.parts.filter((item) => !isBlocked(blocked, item)),
    };
  }

  return body;
}

/**
 * Whether this request is asking for one title, and which.
 *
 * Taken from the route rather than the payload: a detail response does not
 * always carry a mediaType, and the route always knows. `/movie/603` and
 * `/tv/1399` are the two that matter; their sub-paths - recommendations,
 * similar, ratings - answer with a `results` list and are handled above.
 */
function detailTarget(req: Request): string | null {
  const type = req.baseUrl.endsWith('/movie')
    ? 'movie'
    : req.baseUrl.endsWith('/tv')
      ? 'tv'
      : null;
  if (!type) {
    return null;
  }
  const match = /^\/(\d+)\/?$/.exec(req.path);
  return match ? keyOf(type, Number(match[1])) : null;
}

export const contentFilter = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  let blocked: Set<string> | null = null;
  try {
    blocked = await blockedFor(req.user);
  } catch (e) {
    // A filter that cannot load must not take the site down with it. It fails
    // open and says so - the alternative is an empty library for everyone the
    // moment a query goes wrong.
    logger.error('Failed to load content filter; showing everything', {
      label: 'Content Filter',
      errorMessage: e instanceof Error ? e.message : 'Unknown error',
    });
    return next();
  }

  if (!blocked || blocked.size === 0) {
    return next();
  }

  // Captured as a const so it stays narrowed inside the closure below.
  const hidden = blocked;
  const target = detailTarget(req);
  const originalJson = res.json.bind(res);

  res.json = ((body: unknown) => {
    // Restored first, so the 404 below cannot re-enter this wrapper.
    res.json = originalJson;

    if (target && hidden.has(target)) {
      return res.status(404).json({ message: 'Not found' });
    }

    try {
      return originalJson(filterPayload(body, hidden));
    } catch (e) {
      logger.error('Content filter failed on a response; passing it through', {
        label: 'Content Filter',
        errorMessage: e instanceof Error ? e.message : 'Unknown error',
      });
      return originalJson(body);
    }
  }) as typeof res.json;

  return next();
};

export default contentFilter;
