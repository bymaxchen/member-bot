import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { logger } from './logger.js';

const TOKEN = process.env.TG_BOT_TOKEN;
const CHANNEL_ID = process.env.TG_CHANNEL_ID;
const ADMIN_IDS = (process.env.TG_ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

if (!TOKEN) throw new Error('TG_BOT_TOKEN is required');
if (!CHANNEL_ID) throw new Error('TG_CHANNEL_ID is required');
if (ADMIN_IDS.length === 0) {
  logger.warn('TG_ADMIN_IDS is empty — no one can use admin commands');
}

export const bot = new Telegraf(TOKEN);
export const CHANNEL = CHANNEL_ID;

export function isAdmin(tgUserId) {
  return ADMIN_IDS.includes(Number(tgUserId));
}

// ============================================================
// 邀请链接 (单次 + 24h 有效)
// ============================================================
export async function createInviteLink() {
  const expireDate = Math.floor(Date.now() / 1000) + 24 * 3600;
  const link = await bot.telegram.createChatInviteLink(CHANNEL, {
    expire_date: expireDate,
    member_limit: 1,
    name: `auto-${Date.now()}`,
  });
  return link.invite_link;
}

// ============================================================
// 检查用户是否已在频道里
// ============================================================
export async function isUserInChannel(tgUserId) {
  try {
    const member = await bot.telegram.getChatMember(CHANNEL, tgUserId);
    // 'left' = 自己退出, 'kicked' = 被 ban
    return !['left', 'kicked'].includes(member.status);
  } catch (err) {
    // user 没在群里时 TG 也会返回错误
    return false;
  }
}

// ============================================================
// 踢人 (允许重新加入): ban + 立即 unban
// ============================================================
export async function kickFromChannel(tgUserId) {
  try {
    await bot.telegram.banChatMember(CHANNEL, tgUserId);
    await bot.telegram.unbanChatMember(CHANNEL, tgUserId, {
      only_if_banned: true,
    });
    return true;
  } catch (err) {
    logger.warn({ err: err.message, tgUserId }, 'Failed to kick user');
    return false;
  }
}

// ============================================================
// 给单个用户发 DM
// ============================================================
export async function dmUser(tgUserId, text, options = {}) {
  try {
    await bot.telegram.sendMessage(tgUserId, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...options,
    });
    return true;
  } catch (err) {
    // 常见: 用户从没 /start 过 bot, TG 不让 bot 主动发 DM
    logger.warn(
      { err: err.message, tgUserId },
      'Failed to DM user (probably never started bot)'
    );
    return false;
  }
}

// ============================================================
// 给所有 admin DM (用于告警)
// ============================================================
export async function dmAdmins(text) {
  for (const id of ADMIN_IDS) {
    await dmUser(id, text);
  }
}

// ============================================================
// 解析 /grant 的用户参数: @username 或 user_id 数字
// 返回 { tgUserId, error }
// ============================================================
export function parseUserArg(arg) {
  if (!arg) return { error: '请指定用户: @username 或 user_id' };
  if (/^\d+$/.test(arg)) {
    return { tgUserId: Number(arg) };
  }
  if (arg.startsWith('@')) {
    return { username: arg.slice(1) };
  }
  return { username: arg };
}
