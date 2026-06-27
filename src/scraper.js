import 'dotenv/config';
import fs from 'fs';
import { insertOrder, getCookiesFromDb, saveCookiesToDb } from './db.js';
import { logger } from './logger.js';

// ============================================================
// Constants
// ============================================================
const PAGE_SIZE = 50;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PAGES_PER_RUN = 10; // 安全网

const MONTHLY_PRICE = Number(process.env.MONTHLY_PRICE || 29);
const LIFETIME_PRICE = Number(process.env.LIFETIME_PRICE || 119);

// 商品订单 search 参数: 让 Fansky 帮我们过滤"会员"商品
// 如果以后改商品名, 改这里
const PRODUCT_SEARCH_PARAMS = {
  tradeNo: '',
  buyerSearchType: 'userInfo',
  buyerQuery: '',
  productName: '会员',
};

// ============================================================
// Custom errors
// ============================================================
export class CookieExpiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CookieExpiredError';
  }
}

// ============================================================
// Cookie 管理
// ============================================================
async function loadCookies() {
  const fromDb = await getCookiesFromDb();
  if (fromDb && Object.keys(fromDb).length > 0) return fromDb;

  const bootstrapPath = process.env.COOKIE_FILE || './data/cookies.json';
  if (fs.existsSync(bootstrapPath)) {
    logger.info({ path: bootstrapPath }, 'Bootstrapping cookies from file → DB');
    const raw = JSON.parse(fs.readFileSync(bootstrapPath, 'utf-8'));
    await saveCookiesToDb(raw);
    return raw;
  }

  throw new Error(
    `No cookies found in DB or at ${bootstrapPath}. ` +
      `Create the file with format {"session": "...", "session.sig": "..."} ` +
      `and run again.`
  );
}

function cookieObjToHeader(cookieObj) {
  return Object.entries(cookieObj)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

// 把 Set-Cookie 响应头解析进 cookies 对象 (mutate), 返回是否有更新
function applySetCookies(cookies, setCookieArr) {
  if (!setCookieArr || setCookieArr.length === 0) return false;
  let changed = false;
  for (const header of setCookieArr) {
    const firstPart = header.split(';')[0].trim();
    const eq = firstPart.indexOf('=');
    if (eq < 0) continue;
    const name = firstPart.slice(0, eq).trim();
    const value = firstPart.slice(eq + 1).trim();
    if (!name) continue;
    if (cookies[name] !== value) {
      cookies[name] = value;
      changed = true;
    }
  }
  return changed;
}

// ============================================================
// HTTP 单页请求
// ============================================================
async function fetchPage(url, cookieHeader, referer) {
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'manual', // 被 302 = 多半是 cookie 失效
      headers: {
        Cookie: cookieHeader,
        Accept: 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Referer: referer,
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  }

  if (res.status >= 300 && res.status < 400) {
    throw new CookieExpiredError(
      `Got HTTP ${res.status} redirect — cookies likely expired`
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new CookieExpiredError(`Got HTTP ${res.status} — cookies expired`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    throw new CookieExpiredError(
      `Response is not JSON (content-type: ${contentType}) — probably login page`
    );
  }

  const body = await res.json();
  if (body.code !== 1) {
    throw new Error(`API error code=${body.code}: ${body.message || 'unknown'}`);
  }

  const setCookies = res.headers.getSetCookie?.() || [];
  return { body, setCookies };
}

// ============================================================
// 通用分页抓取
// ============================================================
// config:
//   - name: 用于日志
//   - urlBuilder(page) -> URL string
//   - referer: HTTP Referer 头
//   - parseOrder(rawOrder) -> 归一化后的订单对象, 或 null (跳过)
async function scrapeApi(config, cookies) {
  let page = 1;
  let totalInserted = 0;
  let totalSeen = 0;
  let nonPaidSkipped = 0;
  let totalFromApi = null;

  while (page <= MAX_PAGES_PER_RUN) {
    const url = config.urlBuilder(page);
    const cookieHeader = cookieObjToHeader(cookies);
    const { body, setCookies } = await fetchPage(url, cookieHeader, config.referer);

    if (applySetCookies(cookies, setCookies)) {
      await saveCookiesToDb(cookies);
      logger.debug({ api: config.name }, 'Session cookies refreshed');
    }

    const orders = body.data?.orders || [];
    totalFromApi = body.data?.total ?? totalFromApi;
    logger.debug(
      { api: config.name, page, pageOrders: orders.length, total: totalFromApi },
      'Page fetched'
    );

    if (orders.length === 0) break;

    let pageInserted = 0;
    for (const raw of orders) {
      totalSeen++;
      const parsed = config.parseOrder(raw);
      if (!parsed) {
        nonPaidSkipped++;
        continue;
      }

      const result = await insertOrder(parsed);
      if (result.affectedRows === 1) {
        pageInserted++;
        totalInserted++;
        logger.info(
          {
            api: config.name,
            order: parsed.externalOrderId,
            type: parsed.type,
            amount: parsed.amount,
            user: parsed.fanskyUsername,
            ...(parsed.subscriptionAction && { action: parsed.subscriptionAction }),
          },
          'New order'
        );
      }
    }

    // 增量停止条件: 这一页一个新订单都没有 = 后面都是历史
    if (pageInserted === 0) {
      logger.debug({ api: config.name }, 'No new orders on this page, stopping');
      break;
    }
    // 已经覆盖完所有订单
    if (totalFromApi !== null && page * PAGE_SIZE >= totalFromApi) {
      logger.debug({ api: config.name }, 'Reached last page based on total, stopping');
      break;
    }

    page++;
  }

  if (page > MAX_PAGES_PER_RUN) {
    logger.warn(
      { api: config.name, MAX_PAGES_PER_RUN },
      'Hit max page limit — may have missed orders, raise MAX_PAGES_PER_RUN or check'
    );
  }

  return {
    api: config.name,
    inserted: totalInserted,
    seen: totalSeen,
    nonPaidSkipped,
    pagesScraped: Math.min(page, MAX_PAGES_PER_RUN),
    totalOnSite: totalFromApi,
  };
}

// ============================================================
// API configs
// ============================================================

// 商品订单 — 永久会员 (按 productName='会员' 过滤)
const productApi = {
  name: 'product',
  referer: 'https://www.fansky.net/creator-dashboard/orders',
  urlBuilder: (page) => {
    const search = encodeURIComponent(JSON.stringify(PRODUCT_SEARCH_PARAMS));
    return (
      `https://www.fansky.net/api/v1/creator-dashboard/orders` +
      `?page=${page}&pageSize=${PAGE_SIZE}&search=${search}`
    );
  },
  parseOrder: (o) => {
    if (o.statusEnum !== 'Paid') return null;

    const amount = Number(o.amount);
    // 已经按"会员"名字过滤,所以这里是 lifetime
    // 金额对不上只 warn,不阻断 (考虑你会涨价)
    if (amount !== LIFETIME_PRICE) {
      logger.warn(
        {
          tradeNo: o.tradeNo,
          amount,
          configuredLifetimePrice: LIFETIME_PRICE,
          productName: o.product?.name,
        },
        'Product order amount differs from configured LIFETIME_PRICE — update .env if you raised prices'
      );
    }

    return {
      externalOrderId: o.tradeNo,
      fanskyOrderItemId: o.orderItemId,
      type: 'lifetime',
      amount,
      currency: o.currency,
      statusEnum: o.statusEnum,
      productId: o.product?.id,
      productName: o.product?.name,
      fanskyUserId: o.user?.id,
      fanskyUsername: o.user?.username,
      paidAt: o.finishedAt
        ? new Date(o.finishedAt)
        : o.createdAt
        ? new Date(o.createdAt)
        : null,
      source: 'fansky_product',
      rawData: o,
    };
  },
};

// 订阅订单 — 月度会员
const subscriptionApi = {
  name: 'subscription',
  referer: 'https://www.fansky.net/creator-dashboard/membership-subscriptions/orders',
  urlBuilder: (page) =>
    `https://www.fansky.net/api/v1/creator-dashboard/membership-subscriptions/orders` +
    `?page=${page}&pageSize=${PAGE_SIZE}`,
  parseOrder: (o) => {
    // 注意: 订阅 API 的字段是 status, 不是 statusEnum
    if (o.status !== 'Paid') return null;

    const amount = Number(o.amount);
    if (amount !== MONTHLY_PRICE) {
      logger.warn(
        {
          orderNo: o.orderNo,
          amount,
          configuredMonthlyPrice: MONTHLY_PRICE,
          tierName: o.tier?.name,
        },
        'Subscription order amount differs from configured MONTHLY_PRICE — update .env if you raised prices'
      );
    }

    return {
      externalOrderId: o.orderNo,
      type: 'monthly',
      amount,
      currency: o.currency,
      statusEnum: o.status,
      subscriptionNo: o.subscriptionNo,
      periodEndAt: o.periodEndAt ? new Date(o.periodEndAt) : null,
      subscriptionAction: o.action,
      tierId: o.tier?.id,
      tierName: o.tier?.name,
      fanskyUserId: o.user?.id,
      fanskyUsername: o.user?.username,
      paidAt: o.finishedAt ? new Date(o.finishedAt) : null,
      source: 'fansky_subscription',
      rawData: o,
    };
  },
};

// ============================================================
// Orchestrator
// ============================================================
export async function runScrape() {
  const startedAt = Date.now();
  const cookies = await loadCookies();

  // 两个 API 共享同一份 cookies (Fansky 同域),
  // scrapeApi 内部会就地更新和持久化
  const productResult = await scrapeApi(productApi, cookies);
  const subscriptionResult = await scrapeApi(subscriptionApi, cookies);

  logger.info(
    {
      product: productResult,
      subscription: subscriptionResult,
      durationMs: Date.now() - startedAt,
    },
    'Scrape complete'
  );

  return { productResult, subscriptionResult };
}
