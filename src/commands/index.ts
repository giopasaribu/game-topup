// Command registry + a safe runner. Any front end (CLI now, Discord later) only needs:
//   commands          -> what to show in the menu / register as slash commands
//   findCommand(name) -> look one up
//   runCommand(...)   -> run it; errors come back as a Reply instead of throwing
import { GachaApiError } from '../client.js';
import { balance } from './balance.js';
import { games } from './games.js';
import { history } from './history.js';
import { prices } from './prices.js';
import { quick } from './quick.js';
import { topup } from './topup.js';
import { transaction } from './transaction.js';
import { reply, type Args, type Command, type Ctx, type FieldDef, type Reply } from './types.js';

export * from './types.js';

/** Order here = menu numbers in the CLI (1, 2, 3, ...). */
export const commands: Command[] = [balance, games, prices, topup, history, transaction, quick];

export function findCommand(name: string): Command | undefined {
  return commands.find((c) => c.name === name);
}

export async function runCommand(
  ctx: Ctx,
  cmd: Command,
  args: Args,
  fields: Record<string, string> = {},
): Promise<Reply> {
  try {
    return await cmd.run(ctx, args, fields);
  } catch (e) {
    return errorReply(e);
  }
}

/** Fields can also fail (e.g. unknown game), so wrap them the same way. */
export async function getFields(ctx: Ctx, cmd: Command, args: Args): Promise<FieldDef[] | Reply> {
  if (!cmd.fields) return [];
  try {
    return await cmd.fields(ctx, args);
  } catch (e) {
    return errorReply(e);
  }
}

/** Wraps a confirm callback so it never throws either. */
export async function runSafely(fn: () => Promise<Reply>): Promise<Reply> {
  try {
    return await fn();
  } catch (e) {
    return errorReply(e);
  }
}

export function errorReply(e: unknown): Reply {
  if (e instanceof GachaApiError) return reply.error('API error', e.message);
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    return reply.error('Timeout', 'The API did not answer in time. Try again.');
  }
  if (e instanceof TypeError && e.message === 'fetch failed') {
    return reply.error('Network error', 'Could not reach the API. Check your internet connection.');
  }
  return reply.error('Error', e instanceof Error ? e.message : String(e));
}
