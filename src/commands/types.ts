// The contract every command follows. Nothing here knows about the terminal or Discord.
//
// How it maps to Discord later:
//   Command.name / description   -> slash command name / description
//   Command.options              -> slash command options (choices() -> autocomplete)
//   Command.fields               -> a modal with one input per field (shown after the options)
//   Reply.title / body           -> embed title / description (body is Discord markdown)
//   Reply.confirm                -> Confirm / Cancel buttons
//   Reply.actions                -> extra buttons that run another command
import type { GachaClient } from '../client.js';

export interface Ctx {
  client: GachaClient;
}

export type Args = Record<string, string | number | undefined>;

export interface Choice {
  name: string;
  value: string;
}

export interface OptionDef {
  name: string;
  description: string;
  type: 'string' | 'integer';
  required?: boolean;
  default?: string | number;
  min?: number;
  /** Ask for search text first, then show matching choices. */
  search?: boolean;
  /**
   * Dynamic choices. `args` holds the options answered so far, `query` what the user typed,
   * `limit` how many to return (Discord autocomplete allows 25, the CLI asks for more).
   */
  choices?: (ctx: Ctx, args: Args, query: string, limit?: number) => Promise<Choice[]>;
}

/** Extra inputs that depend on earlier answers (e.g. a game's User ID / Server). */
export interface FieldDef {
  key: string;
  label: string;
  required: boolean;
  kind: 'text' | 'number' | 'select';
  options?: Choice[];
}

/** A follow-up the user can trigger: runs another command with fixed args. */
export interface Action {
  label: string;
  command: string;
  args: Args;
}

export interface Reply {
  ok: boolean;
  title: string;
  /** Discord-flavoured markdown: **bold**, `code`, ``` blocks. The CLI strips the marks. */
  body: string;
  /** Raw data, handy for an AI agent or tests. */
  data?: unknown;
  /** Ask the user before doing something irreversible. */
  confirm?: { question: string; run: () => Promise<Reply> };
  actions?: Action[];
  /** Continue straight into this command (CLI runs it immediately; Discord: a primary button). */
  followUp?: Action;
}

export interface Command {
  /** Lowercase, no spaces: valid as a Discord slash command name. */
  name: string;
  /** Menu text */
  label: string;
  description: string;
  options: OptionDef[];
  fields?: (ctx: Ctx, args: Args) => Promise<FieldDef[]>;
  run: (ctx: Ctx, args: Args, fields: Record<string, string>) => Promise<Reply>;
}

export const reply = {
  ok: (title: string, body: string, extra: Partial<Reply> = {}): Reply => ({ ok: true, title, body, ...extra }),
  error: (title: string, body: string, extra: Partial<Reply> = {}): Reply => ({ ok: false, title, body, ...extra }),
};
