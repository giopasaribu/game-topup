import { executeTopup, formatMoney, prepareTopup, type TopupPreview } from '../topup.js';
import { FormType, type ProductForm } from '../types.js';
import { gameOption, itemOption } from './shared.js';
import { reply, type Command, type Ctx, type FieldDef, type Reply } from './types.js';

export const topup: Command = {
  name: 'topup',
  label: 'Top up a game',
  description: 'Buy an item for a player (asks for confirmation first)',
  options: [
    gameOption,
    itemOption,
    { name: 'quantity', description: 'How many', type: 'integer', required: true, default: 1, min: 1 },
  ],

  // The player info differs per game (User ID, Server, Zone, ...), so it comes from the API.
  async fields({ client }, args): Promise<FieldDef[]> {
    const product = await client.getProduct(String(args.game));
    return product.forms.map(formToField);
  },

  async run(ctx, args, fields) {
    const preview = await prepareTopup(ctx.client, {
      slug: String(args.game),
      item: String(args.item),
      quantity: Number(args.quantity ?? 1),
      forms: fields,
    });
    return previewReply(ctx, preview);
  },
};

export function formToField(f: ProductForm): FieldDef {
  return {
    key: f.id,
    label: f.label,
    required: f.isRequired,
    kind: f.type === FormType.Select ? 'select' : f.type === FormType.Number ? 'number' : 'text',
    options: f.options.map((o) => ({ name: o.label, value: o.value })),
  };
}

/** Turns a top-up preview into a reply with a confirm step. Shared by "topup" and "quick". */
export function previewReply(ctx: Ctx, preview: TopupPreview, extraErrors: string[] = [], notes: string[] = []): Reply {
  const lines = [
    `Game: **${preview.product.title}**`,
    preview.item ? `Item: **${preview.item.name}** @ ${formatMoney(preview.item.unitPrice)}` : '',
    `Quantity: ${preview.quantity}`,
    ...preview.formSummary.map((f) => `${f.label}: \`${f.value}\``),
    `Total: **${formatMoney(preview.total)}**`,
    `Balance: ${formatMoney(preview.balance)} -> ${formatMoney(preview.balanceAfter)}`,
  ].filter(Boolean);

  const errors = [...preview.errors, ...extraErrors];
  if (!preview.ok || errors.length) {
    return reply.error('Cannot place this order', [...lines, '', ...errors.map((e) => `- ${e}`)].join('\n'), {
      data: preview,
    });
  }

  lines.push(`Order ref: \`${preview.request!.merchantOrderId}\``, ...notes);
  return reply.ok(preview.dryRun ? 'Order preview (DRY RUN)' : 'Order preview', lines.join('\n'), {
    data: preview,
    confirm: {
      question: preview.dryRun
        ? 'Simulate this order? (dry run, nothing is spent)'
        : `Place this order? ${formatMoney(preview.total)} will be taken from your deposit.`,
      run: async () => {
        const result = await executeTopup(ctx.client, preview);
        if (result.dryRun) {
          return reply.ok(
            'Dry run - nothing was sent',
            'This request would have been sent:\n```json\n' + JSON.stringify(preview.request, null, 2) + '\n```',
            { data: result },
          );
        }
        return reply.ok(
          'Order placed',
          `Transaction id: \`${result.transactionId}\`\nOrder ref: \`${result.merchantOrderId}\``,
          {
            data: result,
            actions: [{ label: 'Check status', command: 'transaction', args: { id: result.transactionId! } }],
          },
        );
      },
    },
  });
}
