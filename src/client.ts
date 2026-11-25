// Thin HTTP client: one method per API endpoint, no business logic.
import { loadConfig, type GachaConfig } from './config.js';
import type {
  ProductDetail,
  ProductForm,
  ProductItem,
  ProductSummary,
  TransactionCreateRequest,
  TransactionDetail,
  TransactionPage,
} from './types.js';

export class GachaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'GachaApiError';
  }
}

export class GachaClient {
  constructor(private readonly config: GachaConfig = loadConfig()) {}

  get dryRun(): boolean {
    return this.config.dryRun;
  }

  get orderPrefix(): string {
    return this.config.orderPrefix;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.clientSecret}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }

    if (!res.ok) {
      throw new GachaApiError(errorMessage(res.status, json), res.status, json);
    }
    return json as T;
  }

  /** GET / - merchant deposit balance */
  async getBalance(): Promise<number> {
    const res = await this.request<{ data: { deposit: number | string } }>('GET', '/');
    return Number(res.data.deposit);
  }

  /** GET /product - all games */
  async listProducts(): Promise<ProductSummary[]> {
    const res = await this.request<{ data: ProductSummary[] }>('GET', '/product');
    return res.data;
  }

  /** GET /product/{slug} - categories, items (prices) and required forms */
  async getProduct(slug: string): Promise<ProductDetail> {
    const res = await this.request<{ data: ProductDetail }>('GET', `/product/${encodeURIComponent(slug)}`);
    return normaliseProduct(res.data);
  }

  /** GET /transaction?page=n - 15 per page */
  async listTransactions(page = 1): Promise<TransactionPage> {
    return this.request<TransactionPage>('GET', `/transaction?page=${page}`);
  }

  /** GET /transaction/{id} - detail with status history and redeem code */
  async getTransaction(id: string): Promise<TransactionDetail> {
    const res = await this.request<{ data: TransactionDetail }>('GET', `/transaction/${encodeURIComponent(id)}`);
    return res.data;
  }

  /** POST /transaction - SPENDS DEPOSIT. Returns the new transaction id. */
  async createTransaction(req: TransactionCreateRequest): Promise<string> {
    const res = await this.request<{ data: { id: string } }>('POST', '/transaction', req);
    return res.data.id;
  }
}

// The docs show price and isRequired as strings in places, so coerce them.
function normaliseProduct(p: ProductDetail): ProductDetail {
  return {
    ...p,
    categories: p.categories ?? [],
    items: (p.items ?? []).map((i): ProductItem => ({ ...i, price: Number(i.price) })),
    forms: (p.forms ?? []).map(
      (f): ProductForm => ({
        ...f,
        type: Number(f.type),
        isRequired: String(f.isRequired) === 'true',
        options: f.options ?? [],
      }),
    ),
  };
}

function errorMessage(status: number, body: unknown): string {
  const apiMsg =
    body && typeof body === 'object' && 'message' in body ? String((body as { message: unknown }).message) : '';
  const hint =
    status === 401
      ? 'Invalid or missing client secret'
      : status === 404
        ? 'Not found'
        : status === 422
          ? 'Validation failed (price may be out of date)'
          : `HTTP ${status}`;
  return apiMsg ? `${hint}: ${apiMsg}` : hint;
}
