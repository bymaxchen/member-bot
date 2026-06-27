import 'dotenv/config';
import cron from 'node-cron';
import { runScrape, CookieExpiredError } from './scraper.js';
import { initSchema, getStats, closePool } from './db.js';
import { logger } from './logger.js';

const ONCE = process.argv.includes('--once');
const SCHEDULE = process.env.SCRAPE_CRON || '*/5 * * * *';

let consecutiveFailures = 0;
const ALERT_THRESHOLD = 3;
let cookiePaused = false;

async function safeScrape() {
  if (cookiePaused) {
    logger.warn('Cookies marked expired — skipping scrape until refreshed');
    return;
  }

  try {
    await runScrape();
    if (consecutiveFailures > 0) {
      logger.info({ recoveredAfter: consecutiveFailures }, 'Scraper recovered');
    }
    consecutiveFailures = 0;
  } catch (err) {
    if (err instanceof CookieExpiredError) {
      logger.fatal(
        { err: err.message },
        '!!! COOKIES EXPIRED — refresh `fansky_cookies` row in app_config and restart !!!'
      );
      // TODO: TG bot 上线后,这里 DM 自己
      cookiePaused = true;
      return;
    }

    consecutiveFailures++;
    logger.error(
      { err: err.message, stack: err.stack, consecutiveFailures },
      'Scrape failed'
    );

    if (consecutiveFailures >= ALERT_THRESHOLD) {
      logger.fatal({ consecutiveFailures }, '!!! Scraper failed repeatedly — investigate');
      // TODO: TG bot DM
    }
  }
}

async function main() {
  await initSchema();
  const stats = await getStats();
  logger.info({ stats }, 'membership-sync starting');

  if (ONCE) {
    logger.info('Running in --once mode');
    await safeScrape();
    const after = await getStats();
    logger.info({ stats: after }, 'Done');
    await closePool();
    process.exit(consecutiveFailures > 0 || cookiePaused ? 1 : 0);
  }

  logger.info({ schedule: SCHEDULE }, 'Scheduling recurring scrape');
  await safeScrape();
  cron.schedule(SCHEDULE, safeScrape);

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      logger.info({ sig }, 'Shutting down');
      await closePool().catch(() => {});
      process.exit(0);
    });
  }
}

main().catch(async (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'Fatal error');
  await closePool().catch(() => {});
  process.exit(1);
});
