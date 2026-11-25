// Business logic on top of the client. Every function takes plain JSON-friendly input and
// returns plain data, so the CLI, a Discord bot or an AI agent (as "tools") can all call them.
import { randomBytes } from 'node:crypto';
import type { GachaClient } from './client.js';
import {
  FormType,
  TransactionStatus,
  type ProductDetail,
  type ProductItem,
  type ProductSummary,
  type TransactionCreateRequest,
  type TransactionDetail,
} from './types.js';

// ---------- Products ----------

/** Case-insensitive search on title and slug. Empty query returns everything. */
export async function searchProducts(client: GachaClient, query = ''): Promise<ProductSummary[]> {
  const q = query.trim().toLowerCase();
  const products = await client.listProducts();
  const matches = q
    ? products.filter((p) => p.title.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q))
    : products;
  return matches.sort((a, b) => a.title.localeCompare(b.title));
}

export interface CatalogCategory {
  id: string;
  name: string;
  items: ProductItem[];
}

/** Items grouped by category, cheapest first. Items with an unknown category go to "Other". */
export function groupItemsByCategory(product: ProductDetail): CatalogCategory[] {
  const groups: CatalogCategory[] = product.categories.map((c) => ({ id: c.id, name: c.name, items: [] }));
  const other: CatalogCategory = { id: '', name: 'Other', items: [] };
  for (const item of product.items) {
    (groups.find((g) => g.id === item.category) ?? other).items.push(item);
  }
  if (other.items.length) groups.push(other);
  for (const g of groups) g.items.sort((a, b) => a.price - b.price);
  return groups.filter((g) => g.items.length > 0);
}

/** Find an item by exact id, else by name (exact, then partial). Throws if missing or ambiguous. */
export function findItem(product: ProductDetail, idOrName: string): ProductItem {
  const key = idOrName.trim().toLowerCase();
  const byId = product.items.find((i) => i.id.toLowerCase() === key);
  if (byId) return byId;
  const exact = product.items.filter((i) => i.name.toLowerCase() === key);
  if (exact.length === 1) return exact[0];
  const partial = product.items.filter((i) => i.name.toLowerCase().includes(key));
  if (partial.length === 1) return partial[0];
  if (partial.length === 0) throw new Error(`No item matching "${idOrName}" in ${product.title}.`);
  throw new Error(
    `"${idOrName}" matches ${partial.length} items in ${product.title}: ${partial.map((i) => i.name).join(', ')}`,
  );
}

// ---------- Forms (User ID, Server, ...) ----------

/**
 * Validates form input against the product's forms.
 * `values` can be keyed by form id OR label (case-insensitive), e.g. { "User ID": "123", "server": "Asia" }.
 * For select forms, the option's value or label is accepted and converted to the option value.
 */
export function buildForms(
  product: ProductDetail,
  values: Record<string, string>,
): { forms: { id: string; value: string }[]; errors: string[] } {
  const lookup = new Map(Object.entries(values).map(([k, v]) => [k.trim().toLowerCase(), String(v ?? '').trim()]));
  const forms: { id: string; value: string }[] = [];
  const errors: string[] = [];

  for (const form of product.forms) {
    const raw = lookup.get(form.id.toLowerCase()) ?? lookup.get(form.label.toLowerCase()) ?? '';
    if (!raw) {
      if (form.isRequired) errors.push(`${form.label} is required.`);
      continue;
    }
    const result = validateFormValue(form.type, raw, form.options);
    if (result.error) errors.push(`${form.label}: ${result.error}`);
    else forms.push({ id: form.id, value: result.value });
  }
  return { forms, errors };
}

export function validateFormValue(
  type: FormType,
  raw: string,
  options: { label: string; value: string }[] = [],
): { value: string; error?: string } {
  const v = raw.trim();
  if (type === FormType.Number && !/^\d+$/.test(v)) return { value: v, error: 'must be digits only.' };
  if (type === FormType.Select) {
    const opt = options.find((o) => o.value === v || o.label.toLowerCase() === v.toLowerCase());
    if (!opt) return { value: v, error: `must be one of: ${options.map((o) => o.label).join(', ')}.` };
    return { value: opt.value };
  }
  return { value: v };
}

// ---------- Top-up ----------

export interface TopupInput {
  slug: string;
  /** Item id or item name */
  item: string;
  quantity?: number;
  /** Keyed by form id or label */
  forms: Record<string, string>;
  merchantOrderId?: string;
}

export interface TopupPreview {
  ok: boolean;
  errors: string[];
  product: { slug: string; title: string };
  item?: { id: string; name: string; unitPrice: number };
  quantity: number;
  total: number;
  balance: number;
  balanceAfter: number;
  /** Form values as label -> value, for showing the user before confirming */
  formSummary: { label: string; value: string }[];
  request?: TransactionCreateRequest;
  dryRun: boolean;
}

/**
 * Step 1 of a top-up: fetches the CURRENT price and balance, validates everything and builds the
 * request. Spends nothing. Show the preview to a human (or AI) and only then call executeTopup().
 */
export async function prepareTopup(client: GachaClient, input: TopupInput): Promise<TopupPreview> {
  const quantity = input.quantity ?? 1;
  const [product, balance] = await Promise.all([client.getProduct(input.slug), client.getBalance()]);
  const errors: string[] = [];

  if (!Number.isInteger(quantity) || quantity < 1) errors.push('Quantity must be a whole number of at least 1.');

  let item: ProductItem | undefined;
  try {
    item = findItem(product, input.item);
  } catch (e) {
    errors.push((e as Error).message);
  }

  const { forms, errors: formErrors } = buildForms(product, input.forms);
  errors.push(...formErrors);

  const total = item ? item.price * quantity : 0;
  if (item && total > balance) errors.push(`Insufficient balance: need ${formatMoney(total)}, have ${formatMoney(balance)}.`);

  const formSummary = forms.map((f) => {
    const def = product.forms.find((pf) => pf.id === f.id)!;
    const label = def.options.find((o) => o.value === f.value)?.label;
    return { label: def.label, value: label ? `${label} (${f.value})` : f.value };
  });

  const ok = errors.length === 0 && !!item;
  return {
    ok,
    errors,
    product: { slug: product.slug, title: product.title },
    item: item && { id: item.id, name: item.name, unitPrice: item.price },
    quantity,
    total,
    balance,
    balanceAfter: balance - total,
    formSummary,
    request:
      ok && item
        ? {
            merchantOrderId: input.merchantOrderId || generateOrderId(client.orderPrefix),
            slug: product.slug,
            price: total,
            item: { id: item.id, quantity },
            forms,
          }
        : undefined,
    dryRun: client.dryRun,
  };
}

export interface TopupResult {
  transactionId: string | null;
  merchantOrderId?: string;
  dryRun: boolean;
}

/** Step 2: places the order (SPENDS DEPOSIT) unless GACHA_DRY_RUN is on. */
export async function executeTopup(client: GachaClient, preview: TopupPreview): Promise<TopupResult> {
  if (!preview.ok || !preview.request) {
    throw new Error(`Top-up is not valid: ${preview.errors.join(' ') || 'unknown error'}`);
  }
  if (client.dryRun) {
    return { transactionId: null, merchantOrderId: preview.request.merchantOrderId, dryRun: true };
  }
  const id = await client.createTransaction(preview.request);
  return { transactionId: id, merchantOrderId: preview.request.merchantOrderId, dryRun: false };
}

// ---------- Transactions ----------

const STATUS_LABELS: Record<number, string> = {
  [TransactionStatus.Refunded]: 'Refunded',
  [TransactionStatus.Cancelled]: 'Cancelled',
  [TransactionStatus.Unpaid]: 'Unpaid',
  [TransactionStatus.OnProcess]: 'On Process',
  [TransactionStatus.Completed]: 'Completed',
  [TransactionStatus.OnHold]: 'On Hold',
};

export function statusLabel(status: number): string {
  return STATUS_LABELS[status] ?? `Unknown (${status})`;
}

export function isFinalStatus(status: number): boolean {
  return [TransactionStatus.Completed, TransactionStatus.Cancelled, TransactionStatus.Refunded].includes(status);
}

/** Polls a transaction until it reaches a final status or the timeout passes. */
export async function waitForTransaction(
  client: GachaClient,
  id: string,
  opts: { intervalMs?: number; timeoutMs?: number; onUpdate?: (t: TransactionDetail) => void } = {},
): Promise<TransactionDetail> {
  const { intervalMs = 5000, timeoutMs = 120000, onUpdate } = opts;
  const deadline = Date.now() + timeoutMs;
  let last = -999;
  for (;;) {
    const tx = await client.getTransaction(id);
    if (tx.status !== last) {
      last = tx.status;
      onUpdate?.(tx);
    }
    if (isFinalStatus(tx.status) || Date.now() + intervalMs > deadline) return tx;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ---------- Helpers ----------

/** e.g. GIO-20261118-165301-A1B2 */
export function generateOrderId(prefix = 'GIO'): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${prefix}-${stamp}-${randomBytes(2).toString('hex').toUpperCase()}`;
}

export function formatMoney(n: number): string {
  return Number(n).toLocaleString('en-US');
}
