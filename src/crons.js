import 'dotenv/config';
import {
  getActiveMonthlyMembers,
  getMembershipsForReminder,
  getMembershipsToCleanup,
  getLatestPeriodEnd,
  extendMonthly,
  setMembershipStatus,
  markReminderSent,
  logAdminAction,
} from './db.js';
import { kickFromChannel, dmUser } from './tg.js';
import { logger } from './logger.js';

const FANSKY_SUBSCRIBE_URL =
  process.env.FANSKY_SUBSCRIBE_URL || 'https://www.fansky.net/';

function formatDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// ============================================================
// 1. 续费自动检测
//    对每个 active monthly 会员, 查最新的 period_end_at.
//    比当前 expires_at 新就更新 (= 用户已在 Fansky 续费, 自动延期, 静默)
// ============================================================
export async function runRenewalCheck() {
  const members = await getActiveMonthlyMembers();
  let extended = 0;
  for (const m of members) {
    try {
      const latest = await getLatestPeriodEnd(m.current_subscription_no);
      if (!latest) continue;
      if (new Date(latest) > new Date(m.expires_at)) {
        await extendMonthly(m.tg_user_id, latest);
        await logAdminAction(
          'auto_renewal',
          m.tg_user_id,
          `expires ${m.expires_at} → ${latest}`
        );
        logger.info(
          {
            tgUserId: m.tg_user_id,
            from: m.expires_at,
            to: latest,
          },
          'Auto-renewed monthly membership'
        );
        extended++;
      }
    } catch (err) {
      logger.error(
        { err: err.message, tgUserId: m.tg_user_id },
        'Renewal check failed for user'
      );
    }
  }
  logger.info({ checked: members.length, extended }, 'Renewal check done');
  return { checked: members.length, extended };
}

// ============================================================
// 2. 到期提醒
//    距离过期 7/3/1 天且本周期没发过该提醒的用户
// ============================================================
export async function runReminderCheck() {
  const members = await getMembershipsForReminder();
  let sent = 0;
  for (const m of members) {
    const days = m.days_until;
    // 本次 expires_at 是否已经发过 (>= days_until) 的提醒了
    if (
      m.last_reminder_for_expires_at &&
      new Date(m.last_reminder_for_expires_at).getTime() ===
        new Date(m.expires_at).getTime() &&
      m.last_reminder_days !== null &&
      m.last_reminder_days <= days
    ) {
      continue;
    }

    const text =
      `⏰ 会员到期提醒\n\n` +
      `你的月度会员还有 <b>${days}</b> 天到期 (${formatDate(m.expires_at)})。\n\n` +
      `在 Fansky 续费即可,系统会自动检测并延期,你不用再来 bot 这边。\n\n` +
      `🔗 续费入口: ${FANSKY_SUBSCRIBE_URL}`;

    const ok = await dmUser(m.tg_user_id, text);
    if (ok) {
      await markReminderSent(m.tg_user_id, days, m.expires_at);
      sent++;
    }
  }
  logger.info({ candidates: members.length, sent }, 'Reminder check done');
  return { candidates: members.length, sent };
}

// ============================================================
// 3. 过期清理
//    过期超过 24h 的 active monthly 会员: 踢出 + 标记 expired
// ============================================================
export async function runCleanup() {
  const members = await getMembershipsToCleanup();
  let kicked = 0;
  for (const m of members) {
    try {
      const ok = await kickFromChannel(m.tg_user_id);
      await setMembershipStatus(m.tg_user_id, 'expired');
      await logAdminAction(
        'auto_expire',
        m.tg_user_id,
        `expired at ${m.expires_at}, kicked=${ok}`
      );

      // DM 通知
      await dmUser(
        m.tg_user_id,
        `❌ 你的月度会员已到期,已从频道移出。\n\n` +
          `如需继续,请在 Fansky 重新订阅,然后把新订单号发给我。\n\n` +
          `🔗 ${FANSKY_SUBSCRIBE_URL}`
      );
      if (ok) kicked++;
    } catch (err) {
      logger.error(
        { err: err.message, tgUserId: m.tg_user_id },
        'Cleanup failed for user'
      );
    }
  }
  logger.info({ candidates: members.length, kicked }, 'Cleanup done');
  return { candidates: members.length, kicked };
}

// ============================================================
// 串行跑全部日常任务
// 顺序很重要: 先续费检测 (可能延期) → 再算到期提醒 (用最新 expires_at) → 再清理过期
// ============================================================
export async function runDailyJobs() {
  logger.info('Starting daily jobs');
  const startedAt = Date.now();
  try {
    const renewal = await runRenewalCheck();
    const reminder = await runReminderCheck();
    const cleanup = await runCleanup();
    logger.info(
      { renewal, reminder, cleanup, durationMs: Date.now() - startedAt },
      'Daily jobs complete'
    );
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Daily jobs failed');
  }
}
