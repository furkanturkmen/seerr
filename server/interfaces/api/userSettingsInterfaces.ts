import type { NotificationAgentKey } from '@server/lib/settings';

export interface UserSettingsGeneralResponse {
  username?: string;
  email?: string;
  locale?: string;
  discoverRegion?: string;
  streamingRegion?: string;
  originalLanguage?: string;
  movieQuotaLimit?: number;
  movieQuotaDays?: number;
  tvQuotaLimit?: number;
  tvQuotaDays?: number;
  globalMovieQuotaDays?: number;
  globalMovieQuotaLimit?: number;
  globalTvQuotaLimit?: number;
  globalTvQuotaDays?: number;
  watchlistSyncMovies?: boolean;
  watchlistSyncTv?: boolean;
  /**
   * TMDB keyword ids hidden from this user, comma delimited.
   *
   * A string rather than an array because that is the shape the keyword
   * selector and the global blocklist setting already speak, so one control
   * serves both. Only an administrator may write it.
   */
  blockedTags?: string;
  /**
   * Whether the user has asked not to be shown adult content.
   *
   * Unlike blockedTags this is the user's own, so it is writable on your own
   * profile. It only ever adds to what an administrator hid.
   */
  hideAdult?: boolean;
  /**
   * Which keyword ids the switch above stands for, comma delimited.
   *
   * Read only, and sent so that the things acting on this - the app, and the
   * service that stamps the Jellyfin library - do not each need their own copy
   * of the list to drift from.
   */
  adultTags?: string;
}

export type NotificationAgentTypes = Record<NotificationAgentKey, number>;
export interface UserSettingsNotificationsResponse {
  emailEnabled?: boolean;
  pgpKey?: string;
  discordEnabled?: boolean;
  discordEnabledTypes?: number;
  discordIds?: string[];
  pushbulletAccessToken?: string;
  pushoverApplicationToken?: string;
  pushoverUserKey?: string;
  pushoverSound?: string;
  telegramEnabled?: boolean;
  telegramBotUsername?: string;
  telegramChatId?: string;
  telegramMessageThreadId?: string;
  telegramSendSilently?: boolean;
  webPushEnabled?: boolean;
  notificationTypes: Partial<NotificationAgentTypes>;
}
