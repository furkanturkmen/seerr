import type { SortOptions } from '@server/api/themoviedb';
import { SortOptionsIterable } from '@server/api/themoviedb';
import type {
  TmdbSearchMovieResponse,
  TmdbSearchTvResponse,
} from '@server/api/themoviedb/interfaces';
import { MediaStatus, MediaType } from '@server/constants/media';
import dataSource from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import Media from '@server/entity/Media';
import type {
  RunnableScanner,
  StatusBase,
} from '@server/lib/scanners/baseScanner';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { createTmdbWithBlocklistSettings } from '@server/routes/discover';
import type { EntityManager } from 'typeorm';

const TMDB_API_DELAY_MS = 250;
class AbortTransaction extends Error {}

class BlocklistedTagProcessor implements RunnableScanner<StatusBase> {
  private running = false;
  private progress = 0;
  private total = 0;

  public async run() {
    this.running = true;

    try {
      await dataSource.transaction(async (em) => {
        await this.cleanBlocklist(em);
        await this.createBlocklistEntries(em);
      });
    } catch (err) {
      if (err instanceof AbortTransaction) {
        logger.info('Aborting job: Process Blocklisted Tags', {
          label: 'Jobs',
        });
      } else {
        throw err;
      }
    } finally {
      this.reset();
    }
  }

  public status(): StatusBase {
    return {
      running: this.running,
      progress: this.progress,
      total: this.total,
    };
  }

  public cancel() {
    this.running = false;
    this.progress = 0;
    this.total = 0;
  }

  private reset() {
    this.cancel();
  }

  private async createBlocklistEntries(em: EntityManager) {
    const tmdb = createTmdbWithBlocklistSettings();

    const settings = getSettings();
    const blocklistedTags = settings.main.blocklistedTags;
    const blocklistedTagsArr = blocklistedTags.split(',');

    const pageLimit = settings.main.blocklistedTagsLimit;
    const invalidKeywords = new Set<string>();

    if (blocklistedTags.length === 0) {
      return;
    }

    // The maximum number of queries we're expected to execute
    this.total =
      2 * blocklistedTagsArr.length * pageLimit * SortOptionsIterable.length;

    for (const type of [MediaType.MOVIE, MediaType.TV]) {
      const getDiscover =
        type === MediaType.MOVIE ? tmdb.getDiscoverMovies : tmdb.getDiscoverTv;

      // Iterate for each tag
      for (const tag of blocklistedTagsArr) {
        const keywordDetails = await tmdb.getKeywordDetails({
          keywordId: Number(tag),
        });

        if (keywordDetails === null) {
          logger.warn('Skipping invalid keyword in blocklisted tags', {
            label: 'Blocklisted Tags Processor',
            keywordId: tag,
          });
          invalidKeywords.add(tag);
          continue;
        }

        let queryMax = pageLimit * SortOptionsIterable.length;
        let fixedSortMode = false; // Set to true when the page limit allows for getting every page of tag

        for (let query = 0; query < queryMax; query++) {
          const page: number = fixedSortMode
            ? query + 1
            : (query % pageLimit) + 1;
          const sortBy: SortOptions | undefined = fixedSortMode
            ? undefined
            : SortOptionsIterable[query % SortOptionsIterable.length];

          if (!this.running) {
            throw new AbortTransaction();
          }

          try {
            const response = await getDiscover({
              page,
              sortBy,
              keywords: tag,
            });

            await this.processResults(response, tag, type, em);
            await new Promise((res) => setTimeout(res, TMDB_API_DELAY_MS));

            this.progress++;
            if (page === 1 && response.total_pages <= queryMax) {
              // We will finish the tag with less queries than expected, move progress accordingly
              this.progress += queryMax - response.total_pages;
              fixedSortMode = true;
              queryMax = response.total_pages;
            }
          } catch (error) {
            logger.error('Error processing keyword in blocklisted tags', {
              label: 'Blocklisted Tags Processor',
              keywordId: tag,
              errorMessage: error.message,
            });
          }
        }
      }
    }

    if (invalidKeywords.size > 0) {
      const currentTags = blocklistedTagsArr.filter(
        (tag) => !invalidKeywords.has(tag)
      );
      const cleanedTags = currentTags.join(',');

      if (cleanedTags !== blocklistedTags) {
        settings.main.blocklistedTags = cleanedTags;
        await settings.save();

        logger.info('Cleaned up invalid keywords from settings', {
          label: 'Blocklisted Tags Processor',
          removedKeywords: Array.from(invalidKeywords),
          newBlocklistedTags: cleanedTags,
        });
      }
    }
  }

  private async processResults(
    response: TmdbSearchMovieResponse | TmdbSearchTvResponse,
    keywordId: string,
    mediaType: MediaType,
    em: EntityManager
  ) {
    const blocklistRepository = em.getRepository(Blocklist);

    for (const entry of response.results) {
      const blocklistEntry = await blocklistRepository.findOne({
        where: { tmdbId: entry.id, mediaType },
      });

      if (blocklistEntry) {
        // Don't mark manual blocklists with tags
        // If media wasn't previously blocklisted for this tag, add the tag to the media's blocklist
        if (
          blocklistEntry.blocklistedTags &&
          !blocklistEntry.blocklistedTags.includes(`,${keywordId},`)
        ) {
          await blocklistRepository.update(blocklistEntry.id, {
            blocklistedTags: `${blocklistEntry.blocklistedTags}${keywordId},`,
          });
        }
      } else {
        // Media wasn't previously blocklisted, add it to the blocklist
        await Blocklist.addToBlocklist(
          {
            blocklistRequest: {
              mediaType,
              title: 'title' in entry ? entry.title : entry.name,
              tmdbId: entry.id,
              blocklistedTags: `,${keywordId},`,
            },
          },
          em
        );
      }
    }
  }

  private async cleanBlocklist(em: EntityManager) {
    /*
     * Clear what the crawler wrote last time, and nothing a person did.
     *
     * Upstream removes the *media* rows and lets the blocklist entries go with
     * them by cascade. Under stock semantics that follows - blocklisted means
     * banned outright, so purging the title's history is consistent. Here it
     * is not: a tag decides who a title is hidden from, not whether it may
     * exist, and media_request cascades off media. Crawling a tag that matched
     * something already requested silently destroyed five requests, including
     * ones made by the administrator the filter does not even apply to.
     *
     * So the blocklist rows go directly, and a media row is removed only when
     * the crawler is the reason it exists - nothing has ever been requested
     * against it. That still clears the thousands of rows a crawl creates for
     * titles nobody owns, without touching a request.
     */
    await em
      .getRepository(Blocklist)
      .createQueryBuilder()
      .delete()
      .where('blocklistedTags IS NOT NULL')
      .execute();

    const mediaRepository = em.getRepository(Media);
    const orphans = await mediaRepository
      .createQueryBuilder('media')
      .where('media.status = :status', { status: MediaStatus.BLOCKLISTED })
      .andWhere(
        'NOT EXISTS (SELECT 1 FROM media_request r WHERE r.mediaId = media.id)'
      )
      .getMany();

    // Batch removes so the query doesn't get too large
    for (let i = 0; i < orphans.length; i += 500) {
      await mediaRepository.remove(orphans.slice(i, i + 500));
    }
  }
}

const blocklistedTagsProcessor = new BlocklistedTagProcessor();

export default blocklistedTagsProcessor;
