import 'dotenv/config';
import {
  getStats,
  getRecentOrders,
  getUnknownTypeOrders,
  closePool,
} from './db.js';

const stats = await getStats();
console.log('\n=== Stats ===');
console.log(JSON.stringify(stats, null, 2));

console.log('\n=== Last 10 orders ===');
const recent = await getRecentOrders(10);
console.table(
  recent.map((r) => ({
    order: r.external_order_id,
    type: r.type,
    amount: r.amount,
    src: r.source,
    paid_at: r.paid_at,
    period_end: r.period_end_at,
    user: r.fansky_username,
    claimed: r.claimed_by_tg_user_id,
  }))
);

console.log('\n=== Unknown-type orders (need manual review) ===');
const unknown = await getUnknownTypeOrders();
if (unknown.length === 0) {
  console.log('  (none)');
} else {
  console.table(unknown);
}

await closePool();
