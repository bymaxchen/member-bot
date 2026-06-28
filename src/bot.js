import 'dotenv/config';
import {
  bot,
  isAdmin,
  createInviteLink,
  kickFromChannel,
  dmUser,
  parseUserArg,
} from './tg.js';
import {
  getOrderByExternalId,
  claimOrder,
  getMembership,
  upsertMembership,
  setMembershipStatus,
  getLatestPeriodEnd,
  recordVerifyAttempt,
  countRecentVerifyFailures,
  recordTgUser,
  findTgUserByUsername,
  logAdminAction,
  getMembershipStats,
} from './db.js';
import { logger } from './logger.js';

const FANSKY_SUBSCRIBE_URL =
    process.env.FANSKY_SUBSCRIBE_URL || 'https://www.fansky.net/';

const ORDER_NO_RE = /^(FS|FSM)-\d+$/;
const VERIFY_RATE_LIMIT = 5; // 10 分钟内最多 5 次错误
const VERIFY_RATE_WINDOW_MIN = 10;

const LIFETIME_FAR_FUTURE = new Date('2099-01-01T00:00:00Z');

// ============================================================
// 工具
// ============================================================
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

async function replyOrderAlreadyClaimedBySelf(ctx, tgUserId, orderId, membership) {
  await recordVerifyAttempt(tgUserId, orderId, false, 'already_claimed_by_self');

  if (membership?.status === 'active') {
    const typeLabel = membership.type === 'lifetime' ? '永久会员' : '月度会员';
    const expiryLine =
        membership.type === 'lifetime'
            ? '永久有效'
            : `有效期至 ${formatDate(membership.expires_at)}`;
    await ctx.reply(
        `此订单已经被你认领过了，不能重复验证。\n\n` +
        `当前会员：<b>${typeLabel}</b>\n📅 ${expiryLine}`,
        { parse_mode: 'HTML' }
    );
    return;
  }

  await ctx.reply(
      '此订单已经被你认领过了，不能重复验证。\n' +
      '如果会员状态不正确，请联系管理员核对。'
  );
}

// ============================================================
// 中间件: 记录 TG 用户
// ============================================================
bot.use(async (ctx, next) => {
  if (ctx.from && !ctx.from.is_bot) {
    try {
      await recordTgUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
    } catch (err) {
      logger.warn({ err: err.message }, 'recordTgUser failed');
    }
  }
  return next();
});

// ============================================================
// /start
// ============================================================
bot.start(async (ctx) => {
  await ctx.reply(
      `你好,我是会员管理 bot 👋\n\n` +
      `你的用户 ID: <code>${ctx.from.id}</code>\n\n` +
      `<b>购买会员</b>\n` +
      `  永久会员 119 元：\n` +
      `  https://www.fansky.co/aiglobalclass/18\n\n` +
      `  月度会员 29 元：\n` +
      `  https://www.fansky.co/aiglobalclass/membership\n\n` +
      `<b>购买后如何开通</b>\n` +
      `  付款完成后,在 Fansky 订单列表复制订单号,直接发给我即可自动开通。\n` +
      `  开通成功后,我会把进群链接发给你。\n` +
      `  永久会员订单号通常以 <code>FS-</code> 开头\n` +
      `  月度会员订单号通常以 <code>FSM-</code> 开头\n\n` +
      `<b>也可以使用命令</b>\n` +
      `  /verify &lt;订单号&gt;\n` +
      `  例如: <code>/verify FS-2026********</code>\n\n` +
      `<b>常用命令</b>\n` +
      `  /status — 查看自己的会员状态\n` +
      `  /help — 显示帮助`,
      { parse_mode: 'HTML' }
  );
});

bot.help(async (ctx) => {
  await ctx.reply(
      `<b>会员相关</b>\n` +
      `  直接发送 <code>FS-xxx</code> 或 <code>FSM-xxx</code> 自动识别认领\n` +
      `  /verify &lt;订单号&gt; — 认领会员\n` +
      `  /status — 查看自己的会员状态\n\n` +
      `<b>如何获取订单号</b>\n` +
      `  在 Fansky 你的订单列表里复制订单号 (FS- 或 FSM- 开头)\n\n` +
      `<b>月度会员续费</b>\n` +
      `  到期前直接在 Fansky 续费即可,系统会自动延期,不用再发任何消息`,
      { parse_mode: 'HTML' }
  );
});

// ============================================================
// 核心: 智能识别订单号
// ============================================================
bot.hears(ORDER_NO_RE, async (ctx) => {
  await handleVerify(ctx, ctx.message.text.trim());
});

// ============================================================
// /verify <订单号>
// ============================================================
bot.command('verify', async (ctx) => {
  const parts = ctx.message.text.split(/\s+/);
  const orderId = parts[1]?.trim();
  if (!orderId) {
    await ctx.reply('用法: /verify <订单号>\n例: /verify FS-2026*********');
    return;
  }
  await handleVerify(ctx, orderId);
});

async function handleVerify(ctx, rawOrderId) {
  const tgUserId = ctx.from.id;
  const orderId = rawOrderId.trim();

  // 防扫号
  const failures = await countRecentVerifyFailures(tgUserId, VERIFY_RATE_WINDOW_MIN);
  if (failures >= VERIFY_RATE_LIMIT) {
    await ctx.reply('请求过于频繁,请稍后再试 🚫');
    return;
  }

  // 格式校验
  if (!ORDER_NO_RE.test(orderId)) {
    await recordVerifyAttempt(tgUserId, orderId, false, 'invalid_format');
    await ctx.reply(
        '订单号格式不对,应该是 <code>FS-xxx</code> 或 <code>FSM-xxx</code>',
        { parse_mode: 'HTML' }
    );
    return;
  }

  // 查订单
  const order = await getOrderByExternalId(orderId);
  if (!order) {
    await recordVerifyAttempt(tgUserId, orderId, false, 'not_found');
    await ctx.reply(
        '没找到这个订单 🔍\n' +
        '可能是订单还没同步 (1-2 分钟后再试),或者订单号有误。'
    );
    return;
  }

  if (order.status_enum !== 'Paid') {
    await recordVerifyAttempt(tgUserId, orderId, false, 'not_paid');
    await ctx.reply(`此订单状态为 ${order.status_enum},未完成支付。`);
    return;
  }

  const claimedBySelf =
      order.claimed_by_tg_user_id &&
      Number(order.claimed_by_tg_user_id) === Number(tgUserId);
  let existing = null;

  // 已被认领?
  if (order.claimed_by_tg_user_id && !claimedBySelf) {
    await recordVerifyAttempt(tgUserId, orderId, false, 'already_claimed');
    await ctx.reply('此订单已被其他用户使用 ⚠️\n如果是误操作,请联系管理员。');
    return;
  }

  if (claimedBySelf) {
    existing = await getMembership(tgUserId);
    if (existing) {
      await replyOrderAlreadyClaimedBySelf(ctx, tgUserId, orderId, existing);
      return;
    }

    logger.warn(
        { tgUserId, order: orderId, membershipStatus: existing?.status ?? null },
        'Order already claimed by same user but membership is missing; recovering verify flow'
    );
  }

  // 检查现有会员状态: 防止已是会员的人重复认领订单 (订单被锁但用户没获益)
  // 永久 → 任何认领都拒
  // 月度 → 拒月度 (会自动续费, 不需要), 允许永久 (升级)
  // 过期/撤销 → 允许 (复活路径)
  existing = existing || await getMembership(tgUserId);
  const isUpgrade =
      existing &&
      existing.status === 'active' &&
      existing.type === 'monthly' &&
      order.type === 'lifetime';
  if (existing && existing.status === 'active' && !isUpgrade) {
    if (existing.type === 'lifetime') {
      await recordVerifyAttempt(tgUserId, orderId, false, 'already_lifetime');
      await ctx.reply(
          '你已是 <b>永久会员</b> 🎉\n无需再认领其他订单。\n\n' +
          (order.type === 'lifetime'
              ? '⚠️ 如果你不小心买了两份永久会员,请联系管理员处理退款。'
              : ''),
          { parse_mode: 'HTML' }
      );
      return;
    }
    if (existing.type === 'monthly' && order.type === 'monthly') {
      await recordVerifyAttempt(tgUserId, orderId, false, 'already_monthly');
      await ctx.reply(
          '你已是 <b>月度会员</b> ✅\n' +
          `📅 当前有效期至: ${formatDate(existing.expires_at)}\n\n` +
          '💡 在 Fansky 续费后系统会自动延期,不需要再来这里认领。',
          { parse_mode: 'HTML' }
      );
      return;
    }
  }

  // 原子认领
  const claim = claimedBySelf ? { affectedRows: 1 } : await claimOrder(orderId, tgUserId);
  if (claim.affectedRows === 0) {
    let recoveredConcurrentSelfClaim = false;
    const latestOrder = await getOrderByExternalId(orderId);
    if (
      latestOrder?.claimed_by_tg_user_id &&
      Number(latestOrder.claimed_by_tg_user_id) === Number(tgUserId)
    ) {
      const m = await getMembership(tgUserId);
      if (m) {
        await replyOrderAlreadyClaimedBySelf(ctx, tgUserId, orderId, m);
        return;
      }

      existing = m || existing;
      recoveredConcurrentSelfClaim = true;
      logger.warn(
          { tgUserId, order: orderId, membershipStatus: m?.status ?? null },
          'Concurrent verify claimed by same user before membership became active; recovering verify flow'
      );
    }

    if (!recoveredConcurrentSelfClaim) {
      // 极端并发场景: 1 ms 内被别人抢了
      await recordVerifyAttempt(tgUserId, orderId, false, 'race_lost');
      await ctx.reply('此订单已被其他用户认领,请联系管理员核对。');
      return;
    }
  }

  // 决定 expires_at
  let expiresAt, subscriptionNo;
  if (order.type === 'lifetime') {
    expiresAt = LIFETIME_FAR_FUTURE;
    subscriptionNo = null;
  } else if (order.type === 'monthly') {
    subscriptionNo = order.subscription_no;
    // 用该订阅最新的 period_end (可能这个用户已经续过几次了, 取最大)
    const latest = await getLatestPeriodEnd(subscriptionNo);
    expiresAt = latest || order.period_end_at;
  } else {
    await ctx.reply('订单类型未识别,请联系管理员。');
    return;
  }

  // 写 membership
  let inviteLink = null;
  try {
    inviteLink = await createInviteLink();
  } catch (err) {
    logger.error({ err: err.message }, 'createInviteLink failed');
  }

  await upsertMembership({
    tgUserId,
    type: order.type,
    startedAt: new Date(),
    expiresAt,
    currentOrderId: order.external_order_id,
    currentSubscriptionNo: subscriptionNo,
    lastInviteLink: inviteLink,
  });

  await recordVerifyAttempt(tgUserId, orderId, true, null);
  await logAdminAction('verify', tgUserId, `${order.type} ${orderId}`);

  // 回复
  const typeLabel = order.type === 'lifetime' ? '永久会员' : '月度会员';
  const actionLabel = isUpgrade ? '升级' : '开通成功';
  const expiryLine =
      order.type === 'lifetime'
          ? '🎉 永久有效'
          : `📅 有效期至 ${formatDate(expiresAt)}`;
  const monthlyHint =
      order.type === 'monthly'
          ? `\n\n💡 续费提示:到期前在 Fansky 续费即可,系统会自动检测并延期,无需再发任何消息。`
          : '';

  if (inviteLink) {
    await ctx.reply(
        `✅ <b>${typeLabel}</b> ${actionLabel}\n${expiryLine}\n\n` +
        `🔗 频道邀请链接 (24 小时有效,仅限本人):\n${inviteLink}${monthlyHint}`,
        { parse_mode: 'HTML' }
    );
  } else {
    await ctx.reply(
        `✅ <b>${typeLabel}</b> ${actionLabel}\n${expiryLine}\n\n` +
        `但生成频道邀请链接失败,请联系管理员。${monthlyHint}`,
        { parse_mode: 'HTML' }
    );
  }
}

// ============================================================
// /status
// ============================================================
bot.command('status', async (ctx) => {
  const m = await getMembership(ctx.from.id);
  if (!m) {
    await ctx.reply(
        `你的用户 ID: <code>${ctx.from.id}</code>\n\n` +
        '你还不是会员。\n如已购买,发订单号给我自助开通 (FS-xxx 或 FSM-xxx)。',
        { parse_mode: 'HTML' }
    );
    return;
  }
  const typeLabel = m.type === 'lifetime' ? '永久会员' : '月度会员';
  const statusLabel =
      m.status === 'active' ? '✅ 有效' : m.status === 'expired' ? '⏰ 已过期' : '🚫 已撤销';

  let msg =
      `<b>会员状态</b>\n  用户 ID: <code>${ctx.from.id}</code>\n  类型: ${typeLabel}\n  状态: ${statusLabel}\n`;
  if (m.type === 'monthly') {
    msg += `  到期: ${formatDate(m.expires_at)}\n`;
    if (m.status === 'active') {
      msg += `\n💡 到期前在 Fansky 续费即可自动延期。`;
    }
  }
  await ctx.reply(msg, { parse_mode: 'HTML' });
});

// ============================================================
// /grant @user [monthly [YYYY-MM-DD] | lifetime]
//   不传类型 → 弹 inline 按钮 (月度 / 永久) 让 admin 选
//   monthly 不传日期 → 默认今天
// ============================================================
async function resolveGrantTarget(userArg) {
  const parsed = parseUserArg(userArg);
  if (parsed.error) return { error: parsed.error };
  if (parsed.tgUserId) return { tgUserId: parsed.tgUserId };
  if (parsed.username) {
    const u = await findTgUserByUsername(parsed.username);
    if (!u) {
      return {
        error:
            `用户 @${parsed.username} 未与 bot 互动过,无法解析。\n` +
            `请让 ta 先私聊 bot 发 /start,或直接传数字 user_id。`,
      };
    }
    return { tgUserId: u.tg_user_id };
  }
  return { error: '无法解析用户' };
}

async function performGrant({ adminId, targetUserId, type, paidAt, dateLabel }) {
  const existing = await getMembership(targetUserId);
  let expiresAt;
  let calcExplain = '';
  if (type === 'lifetime') {
    expiresAt = LIFETIME_FAR_FUTURE;
  } else {
    const isRenewal =
        existing && existing.type === 'monthly' && existing.status === 'active';
    if (isRenewal) {
      const existingExpires = new Date(existing.expires_at);
      const useExisting = existingExpires > paidAt;
      const baseDate = useExisting ? existingExpires : paidAt;
      expiresAt = new Date(baseDate.getTime() + 30 * 24 * 3600 * 1000);
      calcExplain = useExisting
          ? `续费 (原到期 ${formatDate(existingExpires)} 比付款日晚) → ${formatDate(expiresAt)}`
          : `续费 (付款日 ${dateLabel} 比原到期日晚) → ${formatDate(expiresAt)}`;
    } else {
      expiresAt = new Date(paidAt.getTime() + 30 * 24 * 3600 * 1000);
      calcExplain = `付款日 ${dateLabel} + 30 天 → ${formatDate(expiresAt)}`;
    }
  }

  const manualOrderId = `MANUAL-${Date.now()}-${targetUserId}`;

  let inviteLink = null;
  try {
    inviteLink = await createInviteLink();
  } catch (err) {
    logger.error({ err: err.message }, 'createInviteLink failed');
  }

  await upsertMembership({
    tgUserId: targetUserId,
    type,
    startedAt: new Date(),
    expiresAt,
    currentOrderId: manualOrderId,
    currentSubscriptionNo: null,
    lastInviteLink: inviteLink,
  });

  await logAdminAction(
      'grant',
      targetUserId,
      `by_admin=${adminId} type=${type} paid=${dateLabel || '-'} expires=${expiresAt.toISOString()}`
  );

  const typeLabel = type === 'lifetime' ? '永久会员' : '月度会员';
  const userExpiryLine =
      type === 'lifetime' ? '永久有效' : `有效期至 ${formatDate(expiresAt)}`;
  let userMsg = `✅ 管理员已为你开通 <b>${typeLabel}</b>\n📅 ${userExpiryLine}`;
  if (inviteLink) userMsg += `\n\n🔗 频道邀请链接 (24h):\n${inviteLink}`;
  const dmOk = await dmUser(targetUserId, userMsg);

  let adminMsg = `✅ user_id=${targetUserId} → ${typeLabel}\n📅 ${calcExplain || '永久有效'}`;
  if (!dmOk) adminMsg += `\n⚠️ 无法 DM 用户 (ta 没 /start 过 bot),你需要手动告知`;
  if (!inviteLink) adminMsg += `\n⚠️ 邀请链接生成失败`;
  return adminMsg;
}

function todayShanghaiMidnight() {
  // 上海时区今天 00:00, 跟手动传 YYYY-MM-DD 时的语义保持一致
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()); // -> "YYYY-MM-DD"
  return { date: parts, paidAt: new Date(`${parts}T00:00:00+08:00`) };
}

bot.command('grant', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const parts = ctx.message.text.split(/\s+/);
  const userArg = parts[1];
  const typeArg = parts[2];
  const dateArg = parts[3];

  if (!userArg) {
    await ctx.reply(
        '用法:\n' +
        '  /grant <@username|user_id>            ← 弹按钮选月度/永久\n' +
        '  /grant <@username|user_id> monthly [YYYY-MM-DD]\n' +
        '  /grant <@username|user_id> lifetime\n\n' +
        'monthly 不传日期默认按今天算付款日。'
    );
    return;
  }

  const target = await resolveGrantTarget(userArg);
  if (target.error) {
    await ctx.reply(target.error);
    return;
  }
  const targetUserId = target.tgUserId;

  // 无类型 → 弹按钮
  if (!typeArg) {
    await ctx.reply(
        `请选择要为 user_id=${targetUserId} 开通的会员类型:`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '📅 开月度会员 (今天起)', callback_data: `grant:monthly:${targetUserId}` },
              { text: '♾️ 开永久会员', callback_data: `grant:lifetime:${targetUserId}` },
            ]],
          },
        }
    );
    return;
  }

  if (!['monthly', 'lifetime'].includes(typeArg)) {
    await ctx.reply('类型只能是 monthly 或 lifetime');
    return;
  }

  let paidAt = null;
  let dateLabel = null;
  if (typeArg === 'monthly') {
    if (dateArg) {
      paidAt = new Date(`${dateArg}T00:00:00+08:00`);
      if (isNaN(paidAt.getTime())) {
        await ctx.reply('日期格式错误,应为 YYYY-MM-DD (例: 2026-06-04)');
        return;
      }
      dateLabel = dateArg;
    } else {
      const today = todayShanghaiMidnight();
      paidAt = today.paidAt;
      dateLabel = `${today.date} (今天)`;
    }
  }

  const adminMsg = await performGrant({
    adminId: ctx.from.id,
    targetUserId,
    type: typeArg,
    paidAt,
    dateLabel,
  });
  await ctx.reply(adminMsg);
});

bot.action(/^grant:(monthly|lifetime):(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('无权限', { show_alert: true });
    return;
  }
  const type = ctx.match[1];
  const targetUserId = Number(ctx.match[2]);

  await ctx.answerCbQuery('处理中...');

  let paidAt = null;
  let dateLabel = null;
  if (type === 'monthly') {
    const today = todayShanghaiMidnight();
    paidAt = today.paidAt;
    dateLabel = `${today.date} (今天)`;
  }

  let adminMsg;
  try {
    adminMsg = await performGrant({
      adminId: ctx.from.id,
      targetUserId,
      type,
      paidAt,
      dateLabel,
    });
  } catch (err) {
    logger.error({ err: err.message, targetUserId, type }, 'grant button failed');
    await ctx.editMessageText(`❌ 开通失败: ${err.message}`).catch(() => {});
    return;
  }

  // 把按钮消息直接替换为结果, 避免重复点击
  await ctx.editMessageText(adminMsg).catch(async () => {
    await ctx.reply(adminMsg);
  });
});

// ============================================================
// /revoke @user
// ============================================================
bot.command('revoke', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const parts = ctx.message.text.split(/\s+/);
  const userArg = parts[1];

  if (!userArg) {
    await ctx.reply('用法: /revoke <@username 或 user_id>');
    return;
  }

  const parsed = parseUserArg(userArg);
  let targetUserId = parsed.tgUserId;
  if (!targetUserId && parsed.username) {
    const u = await findTgUserByUsername(parsed.username);
    if (!u) {
      await ctx.reply(`用户 @${parsed.username} 未找到`);
      return;
    }
    targetUserId = u.tg_user_id;
  }

  const m = await getMembership(targetUserId);
  if (!m) {
    await ctx.reply('该用户没有会员记录');
    return;
  }

  await setMembershipStatus(targetUserId, 'revoked');
  const kicked = await kickFromChannel(targetUserId);
  await logAdminAction('revoke', targetUserId, `by_admin=${ctx.from.id}`);

  await ctx.reply(
      `✅ 已撤销 user_id=${targetUserId} 的会员` +
      (kicked ? ' 并踢出频道' : ' (但踢出频道失败,可能本来就不在)')
  );
});

// ============================================================
// /stats — admin 看总览
// ============================================================
bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const stats = await getMembershipStats();
  let msg = '<b>会员统计</b>\n';
  for (const row of stats.byType) {
    msg += `  ${row.type} / ${row.status}: ${row.n}\n`;
  }
  msg += `\n月度会员 7 天内将到期: ${stats.monthlyExpiringIn7d}`;
  await ctx.reply(msg, { parse_mode: 'HTML' });
});

// ============================================================
// 兜底: 私聊里的其他文本
// ============================================================
bot.on('text', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  await ctx.reply(
      '没看懂 🤔 直接发订单号 (FS-xxx 或 FSM-xxx) 可以自助开通会员。\n用 /help 看完整命令。'
  );
});

// ============================================================
// 全局错误
// ============================================================
bot.catch((err, ctx) => {
  logger.error(
      { err: err.message, stack: err.stack, update: ctx.update },
      'Bot handler error'
  );
});
