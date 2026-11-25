// Pure helpers for the Discord bot (no Discord objects here, so they're easy to test).
import type { SessionSummary, TopupRow, UserTotal } from '../audit/db.js';
import { localDate } from '../audit/db.js';
import { statusLabel } from '../topup.js';
import type { ProductDetail, ProductItem } from '../types.js';

/** "IDR 136,000 / Rare Biosuit" -> "idr136000/rarebiosuit", so "136", "136000" and "136.000" all match. */
export function loose(s: string): string {
  return s.toLowerCase().replace(/[\s,._-]/g, '');
}

/**
 * Items whose name contains the search text (commas/dots/spaces ignored), cheapest first.
 * An exact item id (e.g. picked from autocomplete) returns just that item.
 */
export function matchItems(product: ProductDetail, query: string): ProductItem[] {
  const q = query.trim();
  const byId = product.items.find((i) => i.id === q);
  if (byId) return [byId];
  const key = loose(q);
  return product.items.filter((i) => !key || loose(i.name).includes(key)).sort((a, b) => a.price - b.price);
}

export interface FieldInputs {
  link?: string | null;
  userId?: string | null;
  server?: string | null;
  /** "Label=value; Label 2=value" for any other field a game needs */
  extra?: string | null;
}

export function parseExtra(extra?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (extra ?? '').split(/[;\n]/)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * Maps the slash-command options onto the game's forms (by label):
 *  - a field whose label contains "link"          <- link
 *  - "User ID" / "ID" / "Player ID"               <- user_id
 *  - "Server" / "Zone"                            <- server
 *  - anything else                                <- extra: "Label=value"
 * Returns values keyed by form label, plus the labels of required fields still missing.
 */
export function mapFields(product: ProductDetail, input: FieldInputs): { forms: Record<string, string>; missing: string[] } {
  const extra = Object.fromEntries(Object.entries(parseExtra(input.extra)).map(([k, v]) => [k.toLowerCase(), v]));
  const forms: Record<string, string> = {};
  const missing: string[] = [];
  for (const f of product.forms) {
    const label = f.label.toLowerCase();
    let value = extra[label] ?? '';
    if (!value) {
      const opt = optionKind(label);
      if (opt === 'link') value = input.link?.trim() ?? '';
      else if (opt === 'server') value = input.server?.trim() ?? '';
      else if (opt === 'user_id') value = input.userId?.trim() ?? '';
    }
    if (value) forms[f.label] = value;
    else if (f.isRequired) missing.push(f.label);
  }
  return { forms, missing };
}

function optionKind(label: string): 'link' | 'server' | 'user_id' | 'extra' {
  const l = label.toLowerCase();
  if (l.includes('link')) return 'link';
  if (/server|zone/.test(l)) return 'server';
  if (/(^|\s)(user|player|game|character)?\s*id$/.test(l)) return 'user_id';
  return 'extra';
}

/** Which slash-command option fills a given form label (for error messages). */
export function optionFor(label: string): string {
  const kind = optionKind(label);
  return kind === 'extra' ? `\`extra: ${label}=...\`` : `\`${kind}\``;
}

export function idr(n: number): string {
  return `IDR ${Math.round(n).toLocaleString('en-US')}`;
}

export function localTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

export function today(timeZone: string): string {
  return localDate(new Date().toISOString(), timeZone);
}

export function topupLine(t: TopupRow, timeZone: string, withUser = false): string {
  const icon = t.status === 'placed' ? '✅' : t.status === 'test' ? '🧪' : t.status === 'rejected' ? '🚫' : '❌';
  const who = withUser ? ` **${t.username}**` : '';
  const tx = t.tx_status ? ` · ${t.tx_status}` : '';
  return `${icon} ${localTime(t.created_at, timeZone)}${who} · ${t.item_name} ×${t.quantity} · **${idr(t.total_idr)}**${tx}`;
}

export function sessionText(s: SessionSummary, timeZone: string): string {
  const state = s.session.ended_at
    ? `ended ${localTime(s.session.ended_at, timeZone)}${s.session.end_reason === 'idle' ? ' (idle)' : ''}`
    : 'open';
  const lines = [
    `Session #${s.session.id} for **${s.session.username}**, started ${localTime(s.session.started_at, timeZone)}, ${state}`,
    `Paid top-ups: **${s.liveCount}** · Total to collect: **${idr(s.liveTotal)}**`,
  ];
  if (s.testCount || s.failedCount) lines.push(`Tests: ${s.testCount} · Failed: ${s.failedCount}`);
  if (s.latest.length) lines.push('', '**Latest**', ...s.latest.map((t) => topupLine(t, timeZone)));
  return lines.join('\n');
}

export function dailyText(day: string, totals: UserTotal[]): string {
  if (!totals.length) return `No paid top-ups on ${day}.`;
  const grand = totals.reduce((a, u) => a + u.total_idr, 0);
  return [
    `**Paid top-ups on ${day}**`,
    ...totals.map(
      (u) => `• **${u.username}**: ${u.topups} top-up(s), **${idr(u.total_idr)}**${u.open_session ? ' · session open' : ''}`,
    ),
    '',
    `Total: **${idr(grand)}**`,
  ].join('\n');
}

export { statusLabel };
