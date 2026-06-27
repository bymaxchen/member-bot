# membership-sync

爬取 Fansky 创作者后台订单 (商品+订阅两个 API) → 同步到 MySQL,给后续 TG bot 用。

## 架构

```
                  ┌──────────────────────────┐
                  │  Fansky 商品订单 API     │ ───► 永久会员 (FS-xxx)
[5 min cron]──► │                          │
                  │  Fansky 订阅订单 API     │ ───► 月度会员 (FSM-xxx)
                  └────────────┬─────────────┘
                               │ 带 cookie 调用
                               ▼
                       ┌───────────────┐
                       │  Cloud MySQL  │  ◄── TG bot 后续读这里
                       └───────────────┘
```

### 设计要点

- **两个 API 共享 cookies**: Fansky 同域,一份 session 都能用
- **Cookies 存 DB 不存文件**: 容器 redeploy 文件就没了,DB 是唯一来源。首次跑从 `data/cookies.json` bootstrap 进 DB,之后就靠 DB
- **滑动续期自动持久化**: 每次 API 响应 `Set-Cookie` 都覆盖 DB,理论上长期不用手动刷新
- **增量抓取**: 从第 1 页开始,遇到本页 0 个新订单就停。正常情况每 API 每次 5 分钟只调 1 次
- **类型识别按 API 来源定**: 商品 API 出来的全是 lifetime (已按 `productName=会员` 过滤),订阅 API 出来的全是 monthly。金额对不上只 warn 不阻断 (因为你会涨价)

## 本地跑

```bash
# 1. 装依赖
npm install

# 2. 配置 .env
cp .env.example .env
# 编辑 .env, 填上 DATABASE_URL

# 3. 准备 cookies
# 浏览器登录 Fansky → F12 → Application → Cookies → www.fansky.net
# 复制 session 和 session.sig 的值
mkdir -p data
cat > data/cookies.json <<'EOF'
{
  "session": "rp:sess:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "session.sig": "xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
EOF

# 4. 跑一次
npm run scrape:once

# 5. 看 DB
npm run db:peek

# 6. 长期运行
npm start
```

> 只需要 `session` 和 `session.sig`,其它 cookie (`locale`/`theme`/`_ga*`) 不是身份凭证,不用复制。

## 部署到 Railway

1. push 代码到 GitHub
2. Railway 新建 service,从 GitHub 部署
3. 配 Variables:
   - `DATABASE_URL` — 同一个云 MySQL
   - `MONTHLY_PRICE=29`,`LIFETIME_PRICE=119`
   - `NODE_ENV=production`
   - `SCRAPE_CRON=*/5 * * * *`
4. Deploy

不用配 `COOKIE_FILE`——本地首次跑时 cookies 已经进了 DB,Railway 直接读 DB 就行。

### Cookie 过期了怎么办

爬虫检测到 401 / 403 / 302 / 非 JSON 响应,会停止重试并报 fatal log:

```
!!! COOKIES EXPIRED — refresh `fansky_cookies` row in app_config and restart !!!
```

修复:

1. 浏览器重新登录 Fansky,F12 复制新 `session` 和 `session.sig`
2. 更新 DB:
   ```sql
   UPDATE app_config
      SET v = '{"session":"NEW","session.sig":"NEW"}'
    WHERE k = 'fansky_cookies';
   ```
3. Railway dashboard → Restart

## 数据库表

| 表 | 用途 |
|---|---|
| `orders` | 所有订单 (商品+订阅+手动支付宝/微信都在这) |
| `memberships` | 用户当前会员状态 (爬虫不写,bot 写) |
| `verify_attempts` | 用户校验订单号的尝试记录 |
| `admin_log` | 操作留痕 |
| `app_config` | KV,目前存 cookies |

### `orders` 关键字段

| 字段 | 商品订单 | 订阅订单 |
|---|---|---|
| `external_order_id` | `tradeNo` (FS-xxx) | `orderNo` (FSM-xxx) |
| `source` | `fansky_product` | `fansky_subscription` |
| `type` | `lifetime` | `monthly` |
| `subscription_no` | NULL | UUID,**跨续费保持不变** |
| `period_end_at` | NULL | 当前订阅周期结束时间 |
| `subscription_action` | NULL | `initial_purchase` / `renewal` / ... |
| `tier_id`, `tier_name` | NULL | Fansky 的订阅 tier |
| `product_id`, `product_name` | 商品信息 | NULL |

订单号 (`external_order_id`) 唯一,FS- 和 FSM- 不会冲突。

### 给 bot 用的辅助函数

`db.js` 里 `getLatestPeriodEnd(subscriptionNo)` 返回某个订阅最新的周期结束时间——bot 处理续费时直接用这个值更新 `memberships.expires_at`,不用自己算 30 天。

## 类型识别逻辑

简化版,按 API 来源确定:

- 商品 API (已过滤 `productName=会员`) → `lifetime`
- 订阅 API → `monthly`

金额不匹配 `MONTHLY_PRICE` / `LIFETIME_PRICE` 时只输出 warn log,不阻断 (适配涨价场景)。

**涨价**: 改 `.env` 的价格变量,老订单不受影响 (类型在入库时已定下)。

## 后续路线

- [ ] TG bot 模块: `/verify <订单号>`、`/grant` (手动录支付宝/微信)、`/revoke`
- [ ] 月度会员到期 cron:
  - 用 `getLatestPeriodEnd(subscription_no)` 比 `memberships.expires_at`,新则延期 (自动处理续费)
  - 提前 7/3/1 天 DM 提醒续费
  - 过期宽限 48h 后 `banChatMember + unbanChatMember`
- [ ] 把 `TODO: TG bot DM` 那两处接进 bot 告警通道
- [ ] 存量月度会员认领: 公告 + 截止日扫差集

## 升级 (从 v0.1.0)

v0.1.0 用的 SQLite + Playwright + 单 API。v0.2.0 是 MySQL + fetch + 双 API,schema 重写了。如果你跑过 v0.1.0,数据可以丢 (那时候是测试):

```sql
DROP TABLE IF EXISTS orders, memberships, verify_attempts, admin_log, app_config;
```

然后 `npm run scrape:once`,会重建表并从 Fansky 拉全部历史。
