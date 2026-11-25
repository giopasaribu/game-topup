import { getProductsCached, matchProducts, MAX_CHOICES, table } from './shared.js';
import { reply, type Command } from './types.js';

export const games: Command = {
  name: 'games',
  label: 'Find a game',
  description: 'Search the games you can top up',
  options: [
    { name: 'query', description: 'Game name to search', type: 'string', required: false },
  ],
  async run({ client }, args) {
    const query = String(args.query ?? '');
    const all = await getProductsCached(client);
    const found = matchProducts(all, query);
    if (!found.length) return reply.error('Games', `No game matches "${query}".`);

    const shown = found.slice(0, MAX_CHOICES);
    const rows = [['Game', 'Code (slug)'], ...shown.map((p) => [p.title, p.slug])];
    const more = found.length > shown.length ? `\nShowing ${shown.length} of ${found.length}. Type more of the name to narrow it down.` : '';
    return reply.ok(`Games${query ? ` matching "${query}"` : ''} (${found.length})`, table(rows) + more, {
      data: found,
    });
  },
};
