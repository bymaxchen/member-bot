import 'dotenv/config';
import cron from 'node-cron';
import { runScrape, CookieExpiredError } from './scraper.js';
import { initSchema, getStats, closePool } from './db.js';
import { logger } from './logger.js';
import { bot, dmAdmins } from './tg.js';
import './bot.js'; // 注册 bot handlers
import { runDailyJobs } from './crons.js';

const SCRAPE_ONLY_ONCE = process.argv.includes('--scrape-once');
const SCRAPE_CRON = process.env.SCRAPE_CRON || '*/5 * * * *';
const DAILY_CRON = process.env.DAILY_CRON || '0 10 * * *';

let consecutiveFailures = 0;
const ALERT_THRESHOLD = 3;
let cookiePaused = false;
let alertedCookieExpired = false;

async function safeScrape() {
  if (cookiePaused) return;
  try {
    await runScrape();
    if (consecutiveFailures > 0) {
      logger.info({ recoveredAfter: consecutiveFailures }, 'Scraper recovered');
    }
    consecutiveFailures = 0;
  } catch (err) {
    if (err instanceof CookieExpiredError) {
      cookiePaused = true;
      logger.fatal({ err: err.message }, 'Cookies expired — pausing scraper');
      if (!alertedCookieExpired) {
        alertedCookieExpired = true;
        // DM admin
        await dmAdmins(
          `🚨 <b>Fansky cookies 已失效</b>\n\n` +
            `爬虫已暂停。修复:\n` +
            `1. 浏览器重新登录 Fansky\n` +
            `2. F12 复制新 session 和 session.sig\n` +
            `3. 更新 app_config 表的 fansky_cookies\n` +
            `4. 重启 Railway service`
        ).catch(() => {});
      }
      return;
    }
    consecutiveFailures++;
    logger.error(
      { err: err.message, consecutiveFailures },
      'Scrape failed'
    );
    if (consecutiveFailures === ALERT_THRESHOLD) {
      await dmAdmins(
        `⚠️ 爬虫连续 ${ALERT_THRESHOLD} 次失败\n` +
          `最近错误: ${err.message.slice(0, 200)}\n` +
          `请检查 Railway logs`
      ).catch(() => {});
    }
  }
}

async function main() {
  await initSchema();
  const stats = await getStats();
  logger.info({ stats }, 'membership-sync starting');

  // --scrape-once 模式: 只跑一次爬虫, 不启动 bot 和 cron
  if (SCRAPE_ONLY_ONCE) {
    logger.info('--scrape-once mode');
    await safeScrape();
    const after = await getStats();
    logger.info({ stats: after }, 'Done');
    await closePool();
    process.exit(0);
  }

  // 启动 bot polling (非阻塞, 后台跑)
  bot.launch().catch((err) => {
    logger.fatal({ err: err.message }, 'Bot polling failed to start');
    process.exit(1);
  });
  logger.info('Bot launched (polling)');

  // 立即跑一次爬虫
  await safeScrape();

  // 5 分钟爬虫
  cron.schedule(SCRAPE_CRON, safeScrape);
  logger.info({ schedule: SCRAPE_CRON }, 'Scrape cron scheduled');

  // 日常任务 (续费/提醒/清理)
  cron.schedule(DAILY_CRON, () => runDailyJobs(), {
    timezone: 'Asia/Shanghai',
  });
  logger.info(
    { schedule: DAILY_CRON, tz: 'Asia/Shanghai' },
    'Daily cron scheduled'
  );

  // 优雅退出
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      logger.info({ sig }, 'Shutting down');
      bot.stop(sig);
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
