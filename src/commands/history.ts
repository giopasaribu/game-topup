import { formatMoney, statusLabel } from '../topup.js';
import { shortDate, table } from './shared.js';
import { reply, type Action, type Command } from './types.js';

export const history: Command = {
  name: 'history',
  label: 'Transaction history',
  description: 'List your transactions, 15 per page',
  options: [{ name: 'page', description: 'Page number', type: 'integer', required: true, default: 1, min: 1 }],
  async run({ client }, args) {
    const page = Number(args.page ?? 1);
    const res = await client.listTransactions(page);
    if (!res.data.length) return reply.ok('Transaction history', page > 1 ? 'No transactions on this page.' : 'No transactions yet.');

    const last = res.meta?.last_page ?? page;
    const rows = [
      ['Date', 'Status', 'Game / item', 'Total', 'Id'],
      ...res.data.map((t) => [
        shortDate(t.createdAt),
        statusLabel(t.status),
        `${t.product.title} - ${t.item.name} x${t.item.quantity}`,
        formatMoney(t.total),
        t.id,
      ]),
    ];

    const actions: Action[] = [];
    if (page < last) actions.push({ label: 'Next page', command: 'history', args: { page: page + 1 } });
    if (page > 1) actions.push({ label: 'Previous page', command: 'history', args: { page: page - 1 } });
    actions.push({ label: 'Open a transaction', command: 'transaction', args: {} });

    const total = res.meta ? `, ${res.meta.total} total` : '';
    return reply.ok(`Transaction history - page ${page}/${last}${total}`, table(rows), { data: res, actions });
  },
};
