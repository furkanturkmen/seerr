import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The user's own "hide adult content" switch.
 *
 * Same table rebuild as AddBlockedTagsToUserSettings, for the same reason:
 * SQLite cannot add a column to a table carrying constraints without
 * recreating it. The column is nullable with no default, so every existing row
 * reads as "not asked for" and nobody's library changes on upgrade.
 */
export class AddHideAdultToUserSettings1788500000000
  implements MigrationInterface
{
  name = 'AddHideAdultToUserSettings1788500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "temporary_user_settings" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "locale" varchar NOT NULL DEFAULT (''), "discoverRegion" varchar, "streamingRegion" varchar, "originalLanguage" varchar, "pgpKey" varchar, "blockedTags" text, "hideAdult" boolean, "discordIds" text, "pushbulletAccessToken" varchar, "pushoverApplicationToken" varchar, "pushoverUserKey" varchar, "pushoverSound" varchar, "telegramChatId" varchar, "telegramSendSilently" boolean, "watchlistSyncMovies" boolean, "watchlistSyncTv" boolean, "notificationTypes" text, "userId" integer, "telegramMessageThreadId" varchar, CONSTRAINT "REL_986a2b6d3c05eb4091bb8066f7" UNIQUE ("userId"), CONSTRAINT "FK_986a2b6d3c05eb4091bb8066f78" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `INSERT INTO "temporary_user_settings"("id", "locale", "discoverRegion", "streamingRegion", "originalLanguage", "pgpKey", "blockedTags", "hideAdult", "discordIds", "pushbulletAccessToken", "pushoverApplicationToken", "pushoverUserKey", "pushoverSound", "telegramChatId", "telegramSendSilently", "watchlistSyncMovies", "watchlistSyncTv", "notificationTypes", "userId", "telegramMessageThreadId") SELECT "id", "locale", "discoverRegion", "streamingRegion", "originalLanguage", "pgpKey", "blockedTags", NULL, "discordIds", "pushbulletAccessToken", "pushoverApplicationToken", "pushoverUserKey", "pushoverSound", "telegramChatId", "telegramSendSilently", "watchlistSyncMovies", "watchlistSyncTv", "notificationTypes", "userId", "telegramMessageThreadId" FROM "user_settings"`
    );
    await queryRunner.query(`DROP TABLE "user_settings"`);
    await queryRunner.query(
      `ALTER TABLE "temporary_user_settings" RENAME TO "user_settings"`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" RENAME TO "temporary_user_settings"`
    );
    await queryRunner.query(
      `CREATE TABLE "user_settings" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "locale" varchar NOT NULL DEFAULT (''), "discoverRegion" varchar, "streamingRegion" varchar, "originalLanguage" varchar, "pgpKey" varchar, "blockedTags" text, "discordIds" text, "pushbulletAccessToken" varchar, "pushoverApplicationToken" varchar, "pushoverUserKey" varchar, "pushoverSound" varchar, "telegramChatId" varchar, "telegramSendSilently" boolean, "watchlistSyncMovies" boolean, "watchlistSyncTv" boolean, "notificationTypes" text, "userId" integer, "telegramMessageThreadId" varchar, CONSTRAINT "REL_986a2b6d3c05eb4091bb8066f7" UNIQUE ("userId"), CONSTRAINT "FK_986a2b6d3c05eb4091bb8066f78" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `INSERT INTO "user_settings"("id", "locale", "discoverRegion", "streamingRegion", "originalLanguage", "pgpKey", "blockedTags", "discordIds", "pushbulletAccessToken", "pushoverApplicationToken", "pushoverUserKey", "pushoverSound", "telegramChatId", "telegramSendSilently", "watchlistSyncMovies", "watchlistSyncTv", "notificationTypes", "userId", "telegramMessageThreadId") SELECT "id", "locale", "discoverRegion", "streamingRegion", "originalLanguage", "pgpKey", "blockedTags", "discordIds", "pushbulletAccessToken", "pushoverApplicationToken", "pushoverUserKey", "pushoverSound", "telegramChatId", "telegramSendSilently", "watchlistSyncMovies", "watchlistSyncTv", "notificationTypes", "userId", "telegramMessageThreadId" FROM "temporary_user_settings"`
    );
    await queryRunner.query(`DROP TABLE "temporary_user_settings"`);
  }
}
