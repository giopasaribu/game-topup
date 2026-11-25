// Quick top-up presets, stored in presets.json (path can be changed with GACHA_PRESETS_FILE).
import fs from 'node:fs';
import path from 'node:path';
import type { GachaClient } from './client.js';
import { GachaApiError } from './client.js';
import type { ProductDetail, ProductItem } from './types.js';

export interface Preset {
  /** Shown in the menu, e.g. "RF Online Next - 136,000" */
  label: string;
  /** Game slug, or a name to search for (e.g. "rf online next"). Replaced by the exact slug once pinned. */
  game: string;
  /** Search text for the item (e.g. "136"). Only used until itemId is pinned. */
  item: string;
  /** The exact item id. Filled in automatically after the first confirmed order, then always used. */
  itemId?: string;
  /** Name of the pinned item, for reference only */
  itemName?: string;
  quantity?: number;
  /** Safety limit: refuse if the total is above this (protects against price changes) */
  maxPrice?: number;
  /** Fixed answers, keyed by form label (e.g. { "User ID": "123" }). Anything not here is asked every order. */
  fields?: Record<string, string>;
}

export function presetsPath(): string {
  return path.resolve(process.env.GACHA_PRESETS_FILE?.trim() || 'presets.json');
}

export function loadPresets(file = presetsPath()): Preset[] {
  if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data)) throw new Error(`${path.basename(file)} must contain a JSON array of presets.`);
  return data as Preset[];
}

export function savePresets(presets: Preset[], file = presetsPath()): void {
  fs.writeFileSync(file, JSON.stringify(presets, null, 2) + '\n', 'utf8');
}

/** "136,000 Ruby" -> "136000ruby", so "136", "136000" and "136,000" all match it. */
function loose(s: string): string {
  return s.toLowerCase().replace(/[\s,._-]/g, '');
}

/** Finds the game by slug first, then by name (all words must appear in the title or slug). */
export async function resolveGame(client: GachaClient, ref: string): Promise<ProductDetail> {
  try {
    return await client.getProduct(ref);
  } catch (e) {
    if (!(e instanceof GachaApiError) || e.status !== 404) throw e;
  }
  const words = ref.toLowerCase().split(/[\s-]+/).filter(Boolean);
  const matches = (await client.listProducts()).filter((p) =>
    words.every((w) => p.title.toLowerCase().includes(w) || p.slug.includes(w)),
  );
  if (matches.length === 1) return client.getProduct(matches[0].slug);
  if (!matches.length) throw new Error(`No game matches "${ref}". Check "game" in presets.json.`);
  throw new Error(`"${ref}" matches several games: ${matches.map((m) => `${m.title} (${m.slug})`).join(', ')}. Put the exact slug in presets.json.`);
}

/** Finds the item by id, or by text its name contains (ignoring commas/dots/spaces). Must match exactly one. */
export function resolveItem(product: ProductDetail, ref: string): ProductItem {
  const byId = product.items.find((i) => i.id === ref);
  if (byId) return byId;
  const key = loose(ref);
  const matches = product.items.filter((i) => loose(i.name).includes(key));
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new Error(`No item in ${product.title} matches "${ref}". Check "item" in presets.json.`);
  throw new Error(
    `"${ref}" matches several items in ${product.title}: ${matches.map((m) => `${m.name} [${m.id}]`).join(', ')}. Put the right id in "itemId" in presets.json.`,
  );
}

/** Uses the pinned itemId when there is one, otherwise searches by the item text. */
export async function resolvePreset(
  client: GachaClient,
  preset: Preset,
): Promise<{ product: ProductDetail; item: ProductItem; pinned: boolean }> {
  const product = await resolveGame(client, preset.game);
  if (preset.itemId) {
    const item = product.items.find((i) => i.id === preset.itemId);
    if (!item) {
      throw new Error(
        `The saved item (${preset.itemName ?? preset.itemId}) is no longer sold in ${product.title}. Remove "itemId" from presets.json to search by "item" again.`,
      );
    }
    return { product, item, pinned: true };
  }
  return { product, item: resolveItem(product, preset.item), pinned: false };
}

/** Saves the exact game slug and item id, so later orders skip the search. */
export function pinPreset(presets: Preset[], index: number, product: ProductDetail, item: ProductItem): void {
  const preset = presets[index];
  preset.game = product.slug;
  preset.itemId = item.id;
  preset.itemName = item.name;
  savePresets(presets);
}
