import { MediaStatus } from '@server/constants/media';
import {
  blockedFor,
  keyOf,
  loadSnapshot,
} from '@server/lib/contentFilter';
import logger from '@server/logger';
import type { NextFunction, Request, Response } from 'express';

/**
 * Apply the content filter to every response that carries media.
 *
 * The deciding is in lib/contentFilter; this is only the express half - one
 * middleware wrapping res.json, mounted after checkUser and before every
 * content route, so the roughly fourteen mapper call sites in the discover
 * routes alone do not each need finding.
 *
 * Until the tag crawler has indexed anything, every request short-circuits on
 * one cached lookup. After that it runs for everyone, including unfiltered
 * users, and that is deliberate: a tag-driven title reads as BLOCKLISTED to
 * the whole site, so the people the tag does not apply to need their status
 * put back or the request button vanishes for them too.
 */

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
function filterPayload(
  body: unknown,
  blocked: Set<string>,
  tagDriven: Set<string>,
  target: string | null
): unknown {
  if (!body || typeof body !== 'object') {
    return body;
  }

  const payload = body as Record<string, unknown>;

  /*
   * A detail page this user is *not* filtered from, which the crawler
   * blocklisted for somebody else.
   *
   * MediaStatus.BLOCKLISTED is 6, and the frontend reads it as "nobody may
   * request this" - the request button disappears and a Blocklisted badge
   * takes its place. For a tag-driven entry that is only true of the people
   * filtered on the tag, so for everyone else the real status is restored.
   * Without this, turning the crawler on hides the request button from the
   * administrator too, and the filter reads as a broken site.
   */
  if (target && tagDriven.has(target) && !blocked.has(target)) {
    const info = payload.mediaInfo as Record<string, unknown> | undefined;
    if (info && info.status === MediaStatus.BLOCKLISTED) {
      return { ...payload, mediaInfo: { ...info, status: MediaStatus.UNKNOWN } };
    }
  }

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
 *
 * baseUrl and path are joined rather than either alone. This middleware is
 * mounted on the parent router, so express reports baseUrl as `/api/v1` and
 * path as `/movie/603` - reading baseUrl for the media type finds `/api/v1`
 * and matches nothing, which is exactly the bug this comment exists to stop
 * anyone reintroducing.
 */
function detailTarget(req: Request): string | null {
  const match = /\/(movie|tv)\/(\d+)\/?$/.exec(`${req.baseUrl}${req.path}`);
  return match ? keyOf(match[1], Number(match[2])) : null;
}

export const contentFilter = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  let tagDriven: Set<string>;
  let blocked: Set<string> | null = null;
  try {
    // Which titles the crawler blocklisted, as against blocklisted by hand.
    tagDriven = new Set((await loadSnapshot()).byKey.keys());
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

  /*
   * Nothing has been crawled, so there is nothing to hide and nothing whose
   * status needs correcting. This is the state before the tag list is
   * configured, and it costs one cached lookup.
   *
   * Note the gate is the crawl rather than the user: an *unfiltered* user
   * still needs this wrapper, because a tag-driven title reads as
   * BLOCKLISTED to everyone and its status has to be put back for the people
   * the tag does not apply to. Gating on `blocked` alone hid the request
   * button from the administrator.
   */
  if (tagDriven.size === 0) {
    return next();
  }

  // Captured as consts so they stay narrowed inside the closure below.
  const hidden = blocked ?? new Set<string>();
  const indexed = tagDriven;
  const target = detailTarget(req);
  const originalJson = res.json.bind(res);

  res.json = ((body: unknown) => {
    // Restored first, so the 404 below cannot re-enter this wrapper.
    res.json = originalJson;

    if (target && hidden.has(target)) {
      return res.status(404).json({ message: 'Not found' });
    }

    try {
      return originalJson(filterPayload(body, hidden, indexed, target));
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
