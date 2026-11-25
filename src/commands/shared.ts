// Helpers shared by several commands.
import type { GachaClient } from '../client.js';
import { formatMoney } from '../topup.js';
import type { ProductSummary } from '../types.js';
import type { Choice, OptionDef } from './types.js';

/** Discord autocomplete shows at most 25 choices, so lists use the same limit. */
export const MAX_CHOICES = 25;

// The game list rarely changes, so keep it for 5 minutes instead of calling the API every prompt.
let cache: { at: number; products: ProductSummary[] } | null = null;
export async function getProductsCached(client: GachaClient): Promise<ProductSummary[]> {
  if (!cache || Date.now() - cache.at > 5 * 60_000) {
    cache = { at: Date.now(), products: await client.listProducts() };
  }
  return cache.products;
}

export function matchProducts(products: ProductSummary[], query: string): ProductSummary[] {
  const q = query.trim().toLowerCase();
  return products
    .filter((p) => !q || p.title.toLowerCase().includes(q) || p.slug.includes(q))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** Reusable "game" option: search by name, value is the slug. */
export const gameOption: OptionDef = {
  name: 'game',
  description: 'Game name, or part of it',
  type: 'string',
  required: true,
  search: true,
  choices: async ({ client }, _args, query, limit = MAX_CHOICES): Promise<Choice[]> =>
    matchProducts(await getProductsCached(client), query)
      .slice(0, limit)
      .map((p) => ({ name: p.title, value: p.slug })),
};

/** Reusable "item" option: depends on the game answered before it. */
export const itemOption: OptionDef = {
  name: 'item',
  description: 'Item name, or part of it',
  type: 'string',
  required: true,
  search: true,
  choices: async ({ client }, args, query, limit = MAX_CHOICES): Promise<Choice[]> => {
    const product = await client.getProduct(String(args.game));
    const q = query.trim().toLowerCase();
    return product.items
      .filter((i) => !q || i.name.toLowerCase().includes(q))
      .sort((a, b) => a.price - b.price)
      .slice(0, limit)
      .map((i) => ({ name: `${i.name} - ${formatMoney(i.price)}`, value: i.id }));
  },
};

/** Pads columns and wraps them in a code block so they line up in both the terminal and Discord. */
export function table(rows: string[][]): string {
  if (!rows.length) return '';
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length)));
  const lines = rows.map((r) =>
    r
      .map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c])))
      .join('  ')
      .trimEnd(),
  );
  return '```\n' + lines.join('\n') + '\n```';
}

export function shortDate(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}
