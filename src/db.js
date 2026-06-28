import 'dotenv/config';
import mysql from 'mysql2/promise';
import { logger } from './logger.js';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required in .env');
}

// ---------- Pool ----------
// 默认开启 SSL。TiDB Cloud / PlanetScale / 阿里云 RDS 等基本都强制 TLS。
// Node.js 自带 Mozilla CA bundle, Let's Encrypt 证书无需手动下载 CA。
// 本地无 SSL 的 MySQL 设 DB_SSL=false 关掉。
const pool = mysql.createPool({
  uri: process.env.DATABASE_URL,
  waitForConnections: true,
  connectionLimit: 5,
  charset: 'utf8mb4_unicode_ci',
  timezone: 'Z', // 一律按 UTC,业务层用时再转本地
  ssl:
    process.env.DB_SSL === 'false'
      ? undefined
      : { minVersion: 'TLSv1.2', rejectUnauthorized: true },
});

// ---------- Schema ----------
//
// orders 表统一容纳:
//   - Fansky 商品订单 (永久会员, source='fansky_product', external_order_id 是 FS-xxx tradeNo)
//   - Fansky 订阅订单 (月度会员, source='fansky_subscription', external_order_id 是 FSM-xxx orderNo,
//     带 subscription_no / period_end_at / subscription_action / tier 信息)
//   - 手动录入支付宝/微信 (source='alipay'|'wechat'|'manual', external_order_id 用 MANUAL-xxx 格式)
//
// 用户给 bot 发的订单号匹配 external_order_id, 不管哪条路来的都能查到
export async function initSchema() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        external_order_id VARCHAR(64) NOT NULL,
        fansky_order_item_id BIGINT NULL,
        type ENUM('monthly','lifetime','unknown') NOT NULL DEFAULT 'unknown',
        amount DECIMAL(10,2) NOT NULL,
        currency VARCHAR(8) NOT NULL DEFAULT 'CNY',
        status_enum VARCHAR(32) NULL,
        product_id INT NULL,
        product_name VARCHAR(255) NULL,
        subscription_no VARCHAR(64) NULL,
        period_end_at DATETIME(3) NULL,
        subscription_action VARCHAR(32) NULL,
        tier_id INT NULL,
        tier_name VARCHAR(64) NULL,
        fansky_user_id BIGINT NULL,
        fansky_username VARCHAR(128) NULL,
        paid_at DATETIME(3) NULL,
        source VARCHAR(32) NOT NULL DEFAULT 'fansky_product',
        raw_data JSON NULL,
        claimed_by_tg_user_id BIGINT NULL,
        claimed_at DATETIME NULL,
        scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_external_order_id (external_order_id),
        KEY idx_claimed (claimed_by_tg_user_id),
        KEY idx_paid_at (paid_at),
        KEY idx_type (type),
        KEY idx_subscription (subscription_no),
        KEY idx_source (source)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS memberships (
        tg_user_id BIGINT PRIMARY KEY,
        type ENUM('monthly','lifetime') NOT NULL,
        started_at DATETIME NOT NULL,
        expires_at DATETIME NOT NULL,
        status ENUM('active','expired','revoked') NOT NULL DEFAULT 'active',
        current_order_id VARCHAR(64) NULL,
        current_subscription_no VARCHAR(64) NULL,
        last_invite_link VARCHAR(512) NULL,
        joined_channel_at DATETIME NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_expires (expires_at),
        KEY idx_status (status),
        KEY idx_subscription (current_subscription_no)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS verify_attempts (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        tg_user_id BIGINT NOT NULL,
        attempted_order_id VARCHAR(64) NULL,
        success TINYINT NOT NULL,
        reason VARCHAR(255) NULL,
        attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        KEY idx_user_time (tg_user_id, attempted_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS admin_log (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        action VARCHAR(64) NOT NULL,
        tg_user_id BIGINT NULL,
        details TEXT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS app_config (
        k VARCHAR(64) PRIMARY KEY,
        v TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 记录所有跟 bot 互动过的 TG 用户. 给 /grant @username 用 (用户名 → user_id 反查)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tg_users (
        tg_user_id BIGINT PRIMARY KEY,
        username VARCHAR(128) NULL,
        first_name VARCHAR(128) NULL,
        first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_username (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 幂等列迁移 (v0.3.0 加上去的字段, 已有 DB 也能升级)
    await ensureColumn(conn, 'memberships', 'last_reminder_days', 'INT NULL');
    await ensureColumn(
      conn,
      'memberships',
      'last_reminder_for_expires_at',
      'DATETIME NULL'
    );

    logger.debug('Schema ensured');
  } finally {
    conn.release();
  }
}

async function ensureColumn(conn, table, column, definition) {
  const [rows] = await conn.execute(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  if (rows[0].n === 0) {
    await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    logger.info({ table, column }, 'Added column');
  }
}

// ---------- Orders ----------
const INSERT_ORDER_SQL = `
  INSERT IGNORE INTO orders
    (external_order_id, fansky_order_item_id, type, amount, currency, status_enum,
     product_id, product_name,
     subscription_no, period_end_at, subscription_action, tier_id, tier_name,
     fansky_user_id, fansky_username, paid_at, source, raw_data)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export async function insertOrder(o) {
  const [result] = await pool.execute(INSERT_ORDER_SQL, [
    o.externalOrderId,
    o.fanskyOrderItemId ?? null,
    o.type,
    o.amount,
    o.currency || 'CNY',
    o.statusEnum ?? null,
    o.productId ?? null,
    o.productName ?? null,
    o.subscriptionNo ?? null,
    o.periodEndAt ?? null,
    o.subscriptionAction ?? null,
    o.tierId ?? null,
    o.tierName ?? null,
    o.fanskyUserId ?? null,
    o.fanskyUsername ?? null,
    o.paidAt,
    o.source || 'fansky_product',
    o.rawData ? JSON.stringify(o.rawData) : null,
  ]);
  return result; // affectedRows: 1 = inserted, 0 = already existed
}

export async function getStats() {
  const [[totalRow]] = await pool.query('SELECT COUNT(*) AS n FROM orders');
  const [byType] = await pool.query(
    'SELECT type, COUNT(*) AS n FROM orders GROUP BY type'
  );
  const [bySource] = await pool.query(
    'SELECT source, COUNT(*) AS n FROM orders GROUP BY source'
  );
  const [[claimedRow]] = await pool.query(
    'SELECT COUNT(*) AS n FROM orders WHERE claimed_by_tg_user_id IS NOT NULL'
  );
  const [[subRow]] = await pool.query(
    `SELECT COUNT(DISTINCT subscription_no) AS n
       FROM orders WHERE subscription_no IS NOT NULL`
  );
  return {
    total: totalRow.n,
    byType,
    bySource,
    claimed: claimedRow.n,
    distinctSubscriptions: subRow.n,
  };
}

export async function getRecentOrders(limit = 10) {
  const [rows] = await pool.execute(
    `SELECT external_order_id, type, amount, paid_at, status_enum, source,
            product_name, tier_name, subscription_no, period_end_at,
            fansky_username, claimed_by_tg_user_id
       FROM orders
       ORDER BY paid_at DESC
       LIMIT ?`,
    [limit]
  );
  return rows;
}

export async function getUnknownTypeOrders() {
  const [rows] = await pool.query(
    `SELECT external_order_id, amount, paid_at, source, product_name, tier_name
       FROM orders WHERE type = 'unknown'`
  );
  return rows;
}

// ---------- Cookies ----------
const COOKIES_KEY = 'fansky_cookies';

export async function getCookiesFromDb() {
  const [rows] = await pool.execute(
    'SELECT v FROM app_config WHERE k = ?',
    [COOKIES_KEY]
  );
  if (rows.length === 0) return null;
  try {
    return JSON.parse(rows[0].v);
  } catch (err) {
    logger.error({ err }, 'Failed to parse cookies from DB');
    return null;
  }
}

export async function saveCookiesToDb(cookieObj) {
  await pool.execute(
    `INSERT INTO app_config (k, v) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE v = VALUES(v)`,
    [COOKIES_KEY, JSON.stringify(cookieObj)]
  );
}

// ---------- Bot: 订单查询 ----------
export async function getOrderByExternalId(externalOrderId) {
  const [rows] = await pool.execute(
    'SELECT * FROM orders WHERE external_order_id = ? LIMIT 1',
    [externalOrderId]
  );
  return rows[0] || null;
}

// 原子认领订单: 只在 claimed_by_tg_user_id IS NULL 时更新.
// 返回 affectedRows=1 表示认领成功, =0 表示已被认领或不存在.
export async function claimOrder(externalOrderId, tgUserId) {
  const [result] = await pool.execute(
    `UPDATE orders SET claimed_by_tg_user_id = ?, claimed_at = NOW()
       WHERE external_order_id = ? AND claimed_by_tg_user_id IS NULL`,
    [tgUserId, externalOrderId]
  );
  return result;
}

// ---------- Bot: 会员状态 ----------
export async function getMembership(tgUserId) {
  const [rows] = await pool.execute(
    'SELECT * FROM memberships WHERE tg_user_id = ? LIMIT 1',
    [tgUserId]
  );
  return rows[0] || null;
}

// 入会 / 续期 / 复活 (一个用户主键, INSERT OR UPDATE)
export async function upsertMembership(m) {
  await pool.execute(
    `INSERT INTO memberships
       (tg_user_id, type, started_at, expires_at, status,
        current_order_id, current_subscription_no, last_invite_link)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       type = VALUES(type),
       started_at = VALUES(started_at),
       expires_at = VALUES(expires_at),
       status = 'active',
       current_order_id = VALUES(current_order_id),
       current_subscription_no = VALUES(current_subscription_no),
       last_invite_link = VALUES(last_invite_link),
       last_reminder_days = NULL,
       last_reminder_for_expires_at = NULL`,
    [
      m.tgUserId,
      m.type,
      m.startedAt,
      m.expiresAt,
      m.currentOrderId ?? null,
      m.currentSubscriptionNo ?? null,
      m.lastInviteLink ?? null,
    ]
  );
}

export async function extendMonthly(tgUserId, newExpiresAt) {
  await pool.execute(
    `UPDATE memberships
        SET expires_at = ?,
            status = 'active',
            last_reminder_days = NULL,
            last_reminder_for_expires_at = NULL
      WHERE tg_user_id = ?`,
    [newExpiresAt, tgUserId]
  );
}

export async function setMembershipStatus(tgUserId, status) {
  await pool.execute(
    `UPDATE memberships SET status = ? WHERE tg_user_id = ?`,
    [status, tgUserId]
  );
}

export async function markReminderSent(tgUserId, daysBefore, expiresAt) {
  await pool.execute(
    `UPDATE memberships
        SET last_reminder_days = ?, last_reminder_for_expires_at = ?
      WHERE tg_user_id = ?`,
    [daysBefore, expiresAt, tgUserId]
  );
}

// ---------- Cron 查询 ----------

// 续费检测: 所有 active monthly 会员
export async function getActiveMonthlyMembers() {
  const [rows] = await pool.query(
    `SELECT tg_user_id, current_subscription_no, expires_at
       FROM memberships
      WHERE status = 'active'
        AND type = 'monthly'
        AND current_subscription_no IS NOT NULL`
  );
  return rows;
}

// 到期提醒: monthly 会员, 距离过期 7/3/1 天
export async function getMembershipsForReminder() {
  const [rows] = await pool.query(
    `SELECT tg_user_id, expires_at,
            last_reminder_days, last_reminder_for_expires_at,
            DATEDIFF(expires_at, NOW()) AS days_until
       FROM memberships
      WHERE status = 'active'
        AND type = 'monthly'
        AND DATEDIFF(expires_at, NOW()) IN (7, 3, 1)`
  );
  return rows;
}

// 清理: monthly 会员, 过期超过 24h
export async function getMembershipsToCleanup() {
  const [rows] = await pool.query(
    `SELECT tg_user_id, expires_at
       FROM memberships
      WHERE status = 'active'
        AND type = 'monthly'
        AND expires_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)`
  );
  return rows;
}

// 给 bot 自动续费检测用: 某订阅当前最新的周期结束时间
export async function getLatestPeriodEnd(subscriptionNo) {
  const [rows] = await pool.execute(
    `SELECT MAX(period_end_at) AS latest
       FROM orders
      WHERE subscription_no = ? AND status_enum = 'Paid'`,
    [subscriptionNo]
  );
  return rows[0]?.latest ?? null;
}

// ---------- Bot: 防扫号 ----------
export async function recordVerifyAttempt(tgUserId, orderId, success, reason) {
  await pool.execute(
    `INSERT INTO verify_attempts (tg_user_id, attempted_order_id, success, reason)
     VALUES (?, ?, ?, ?)`,
    [tgUserId, orderId, success ? 1 : 0, reason]
  );
}

export async function countRecentVerifyFailures(tgUserId, withinMinutes) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS n FROM verify_attempts
      WHERE tg_user_id = ?
        AND success = 0
        AND attempted_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [tgUserId, withinMinutes]
  );
  return rows[0].n;
}

// ---------- Bot: 用户名解析 ----------
export async function recordTgUser(tgUserId, username, firstName) {
  await pool.execute(
    `INSERT INTO tg_users (tg_user_id, username, first_name)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       username = VALUES(username),
       first_name = VALUES(first_name)`,
    [tgUserId, username ?? null, firstName ?? null]
  );
}

export async function findTgUserByUsername(username) {
  // username 不带 @
  const clean = username.replace(/^@/, '');
  const [rows] = await pool.execute(
    `SELECT * FROM tg_users WHERE username = ? LIMIT 1`,
    [clean]
  );
  return rows[0] || null;
}

// ---------- Bot: admin log ----------
export async function logAdminAction(action, tgUserId, details) {
  await pool.execute(
    `INSERT INTO admin_log (action, tg_user_id, details) VALUES (?, ?, ?)`,
    [action, tgUserId ?? null, details ?? null]
  );
}

// ---------- Bot: 管理用统计 ----------
export async function getMembershipStats() {
  const [byType] = await pool.query(
    `SELECT type, status, COUNT(*) AS n FROM memberships GROUP BY type, status`
  );
  const [[expiringSoon]] = await pool.query(
    `SELECT COUNT(*) AS n FROM memberships
      WHERE status = 'active' AND type = 'monthly'
        AND expires_at < DATE_ADD(NOW(), INTERVAL 7 DAY)`
  );
  return { byType, monthlyExpiringIn7d: expiringSoon.n };
}

export async function closePool() {
  await pool.end();
}

export default pool;
