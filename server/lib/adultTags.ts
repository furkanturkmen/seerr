/**
 * The TMDB keyword ids that count as adult, for the "hide adult content"
 * switch on a user's own settings.
 *
 * Written down here rather than derived from settings.main.blocklistedTags,
 * and that is not an oversight. jellylab-push builds the global blocklist as
 * the *union of what every user has blocked*, so a set defined as "whatever is
 * globally blocklisted" would be circular: a user who only ever opts in
 * contributes nothing to the union, the crawler stops indexing those keywords,
 * the blocklist empties, and the switch quietly stops hiding anything. The
 * switch needs a set that exists whether or not anybody is filtered on it.
 *
 * These six are what the server was already crawling on 2026-09-04 - erotic,
 * softcore, ecchi, hentai, porn, soft porn. TMDB keyword ids are stable, so
 * this list ages well, but ADULT_TAG_IDS overrides it without a rebuild.
 */
const DEFAULT_ADULT_TAG_IDS = [256466, 155477, 195669, 198385, 356759, 341367];

export const ADULT_TAGS: number[] = (() => {
  const raw = process.env.ADULT_TAG_IDS;
  if (!raw) {
    return DEFAULT_ADULT_TAG_IDS;
  }
  const parsed = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  // An override that parses to nothing is a typo, not a request to stop
  // hiding anything. Fall back rather than silently disabling the switch.
  return parsed.length ? parsed : DEFAULT_ADULT_TAG_IDS;
})();

export default ADULT_TAGS;
