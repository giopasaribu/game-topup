import { formatMoney, groupItemsByCategory } from '../topup.js';
import { FormType } from '../types.js';
import { gameOption, table } from './shared.js';
import { reply, type Command } from './types.js';

export const prices: Command = {
  name: 'prices',
  label: 'Game items & prices',
  description: "Show a game's items, prices and what info a top-up needs",
  options: [gameOption],
  async run({ client }, args) {
    const product = await client.getProduct(String(args.game));
    const groups = groupItemsByCategory(product);
    if (!groups.length) return reply.error(product.title, 'No items available right now.');

    const sections = groups.map((g) => `**${g.name}**\n` + table(g.items.map((i) => [i.name, formatMoney(i.price)])));
    const needs = product.forms
      .map((f) => {
        const opts = f.type === FormType.Select ? ` (${f.options.map((o) => o.label).join(' / ')})` : '';
        return `- ${f.label}${f.isRequired ? '' : ' (optional)'}${opts}`;
      })
      .join('\n');

    return reply.ok(product.title, `${sections.join('\n\n')}\n\n**Needed to top up**\n${needs || '- nothing extra'}`, {
      data: product,
      actions: [{ label: `Top up ${product.title}`, command: 'topup', args: { game: product.slug } }],
    });
  },
};
