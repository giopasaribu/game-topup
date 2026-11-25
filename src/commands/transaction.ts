import { formatMoney, isFinalStatus, statusLabel } from '../topup.js';
import { reply, type Command } from './types.js';

export const transaction: Command = {
  name: 'transaction',
  label: 'Transaction detail / status',
  description: 'Show one transaction with its status history',
  options: [{ name: 'id', description: 'Transaction id (e.g. MTRX2L4P6...)', type: 'string', required: true }],
  async run({ client }, args) {
    const t = await client.getTransaction(String(args.id).trim());
    const lines = [
      `Status: **${statusLabel(t.status)}**`,
      t.merchantOrderId ? `Order ref: \`${t.merchantOrderId}\`` : '',
      `Created: ${t.createdAt}`,
      `Game: ${t.product.title}`,
      `Item: ${t.item.name} x${t.item.quantity} @ ${formatMoney(t.item.price)}`,
      ...(t.forms ?? []).map((f) => `${f.label}: \`${f.value}\``),
      `Subtotal ${formatMoney(t.subTotal)} | Discount ${formatMoney(t.discount)} | Total **${formatMoney(t.total)}**`,
      t.item.redeemCode ? `Redeem code: \`${t.item.redeemCode}\`` : '',
    ].filter(Boolean);

    if (t.updates?.length) {
      lines.push('**History**', ...t.updates.map((u) => `- ${u.createdAt}  ${u.status}  ${u.description}`));
    }

    return reply.ok(`Transaction ${t.id}`, lines.join('\n'), {
      data: t,
      actions: isFinalStatus(t.status) ? [] : [{ label: 'Refresh status', command: 'transaction', args: { id: t.id } }],
    });
  },
};
