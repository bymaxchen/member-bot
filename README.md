# membership-sync

Fansky 订单同步 + Telegram 会员管理 bot,单 Node.js 进程一把梭。

## 架构

```
┌────────────────────────────────────────────────────────────┐
│  单 Node.js 进程 (Railway)                                  │
│                                                            │
│  ┌──────────────┐    ┌──────────────────────────────────┐ │
│  │  scraper     │    │  telegraf bot (polling)           │ │
│  │  cron 5 min  │    │  /verify /grant /status /stats   │ │
│  └──────┬───────┘    └──────────────┬───────────────────┘ │
│         │                            │                     │
│         │   ┌────────────────────────┴───────┐             │
│         │   │  daily cron (10:00 Asia/SH)    │             │
│         │   │  - 自动续费检测                 │             │
│         │   │  - 到期提醒 (7/3/1天)          │             │
│         │   │  - 过期清理 (宽限24h)          │             │
│         │   └────────────────────────────────┘             │
│         ▼                            ▲                     │
│  ┌──────────────────────────────────┴──────┐              │
│  │            Cloud MySQL (TiDB)            │              │
│  └──────────────────────────────────────────┘              │
└────────────────────────────────────────────────────────────┘
```

## 用户交互流程

### 新会员入会

1. 用户在 Fansky 付款,拿到订单号 (FS-xxx = 永久 / FSM-xxx = 月度)
2. 给 bot 私聊订单号 (智能识别) 或 `/verify FS-xxx`
3. Bot 验证 → 写 `memberships` → 生成单次 24h 邀请链接 → DM 给用户

### 月度自动续费 (零交互)

1. 用户在 Fansky 续费 (产生新订单,但 `subscription_no` 不变)
2. 爬虫 5 分钟内同步到 DB
3. 每天 10:00 daily cron 跑续费检测,发现新 `period_end_at` 比 `expires_at` 新
4. 自动 UPDATE `memberships.expires_at`,静默无提醒

### 月度未续费 → 提醒 → 踢出

1. 到期前 7/3/1 天 daily cron DM 提醒 (附 Fansky 续费链接)
2. 到期当天没续费 → 24h 宽限期
3. 24h 后 daily cron `banChatMember + unbanChatMember` (踢出但允许重新加入) + 标记 `expired`

### 手动支付宝/微信入账 (admin)

- `/grant @user monthly` → 默认 NOW+30天
- `/grant @user monthly 2026-07-28` → 指定到期日
- `/grant @user lifetime` → 永久
- 现有 active monthly 用户调用 = 在原 `expires_at` 上 +30 天 (续费场景,不吃亏)
- 自动检测用户是否已在频道,在的话跳过邀请链接

### 撤销 / 统计

- `/revoke @user` — admin 撤销 + 踢出
- `/stats` — admin 看 byType×status 计数 + 7 天内将到期数

## 部署

### 环境变量

```env
DATABASE_URL=mysql://...
MONTHLY_PRICE=29
LIFETIME_PRICE=119
SCRAPE_CRON=*/5 * * * *
DAILY_CRON=0 10 * * *

TG_BOT_TOKEN=xxx:yyy
TG_CHANNEL_ID=-1001234567890
TG_ADMIN_IDS=123456789,987654321
FANSKY_SUBSCRIBE_URL=https://www.fansky.net/...

NODE_ENV=production
LOG_LEVEL=info
```

### Railway

把代码 push 到 GitHub → Railway 新增上面的环境变量 → Deploy。

启动后看 logs 应该看到:
- `membership-sync starting`
- `Bot launched (polling)`
- `Scrape cron scheduled`
- `Daily cron scheduled`
- `Scrape complete` (第一次立即执行的)

### Bot 准备工作

1. `@BotFather` 创建 bot → 拿 token
2. 把 bot 拉进你频道,给"邀请用户"、"封禁/解封成员"权限
3. 把你频道一条消息转发给 `@userinfobot` → 拿频道 ID (负数,以 `-100` 开头)
4. 私聊 `@userinfobot` 拿你自己的 user_id (admin 白名单)

## 命令汇总

| 命令 | 谁能用 | 作用 |
|---|---|---|
| `/start` | 任何人 | 引导文案 |
| `/help` | 任何人 | 命令列表 |
| 发送 `FS-xxx` / `FSM-xxx` | 任何人 | 智能识别认领 |
| `/verify <订单号>` | 任何人 | 显式认领 |
| `/status` | 任何人 | 看自己的会员状态 |
| `/grant <user> monthly\|lifetime [日期]` | admin | 手动开通 |
| `/revoke <user>` | admin | 撤销 + 踢出 |
| `/stats` | admin | 总览 |

`<user>` 支持 `@username` (需对方曾跟 bot 交互过) 或纯数字 `user_id`。

## 数据库表

| 表 | 用途 |
|---|---|
| `orders` | 所有订单 (Fansky 商品+订阅, 手动支付宝/微信) |
| `memberships` | 用户当前会员状态 |
| `verify_attempts` | 防扫号 (10 min 内 5 次错限流) |
| `tg_users` | TG 用户名 ↔ user_id 映射 (给 `/grant @username` 用) |
| `admin_log` | 所有自动/手动操作留痕 |
| `app_config` | KV,目前只存 cookies |

`memberships` 加了两个跟踪续费提醒的字段:
- `last_reminder_days`: 上次发的是 7/3/1 哪个
- `last_reminder_for_expires_at`: 上次提醒针对的 expires_at (续费后 expires_at 变了, 自动重置)

## 关键设计点

1. **续费完全自动**: 利用 Fansky 订阅 API 的 `subscription_no` 跨续费不变,daily cron 自动 UPDATE `expires_at`,用户不用碰 bot
2. **`/grant` 续费不吃亏**: admin 手动 grant 一个已 active 的 monthly 用户,在原 `expires_at` 上 +30 天,不是 NOW+30
3. **踢人 = ban + unban**: 直接 ban 会让用户以后想付费重进群都进不来,ban+unban 等于"踢出但允许再加入"
4. **24h 宽限**: 避免时差和 Fansky 支付延迟误伤
5. **Cookie 失效 DM admin**: 之前的 fatal log 现在还会 DM 你,你能立刻知道
6. **防扫号**: 同 tg_user 10 min 内 5 次错限流

## 升级 (v0.2 → v0.3)

DB 改动是幂等的 (`ensureColumn` 自动加新字段),老数据不丢:

- `memberships` 加 `last_reminder_days`, `last_reminder_for_expires_at`
- 新建 `tg_users` 表

正常 deploy 重启就行,无需 drop。

## 已知局限

- Bot DM 用户前提是用户曾经 `/start` 过 bot (TG 限制)。手动 `/grant` 没 /start 过的用户,DM 会失败,要你手动转告
- `/grant @username` 也依赖对方曾跟 bot 互动 (否则用 numeric user_id)
- 用户自己点 "离开频道" bot 不感知 (除非主动监听 chat_member 事件,后续可加)

## 下一步可做

- [ ] `/cookies set` admin 命令: 直接 DM 新 cookies, bot 写进 DB,不用手动 SQL
- [ ] `chat_member` 事件: 用户自退后自动标记 expired
- [ ] 每周/每月报表 DM admin: 新增会员、流失、续费率
- [ ] inline 按钮: 提醒消息里直接放 "去 Fansky 续费" 按钮
