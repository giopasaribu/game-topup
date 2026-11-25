// Types mirror the OpenAPI spec (gachagaming.json, API v1.0.1).

export interface ProductSummary {
  id: string;
  slug: string;
  title: string;
  imageUrl: string;
}

export interface Category {
  id: string;
  name: string;
}

export interface ProductItem {
  id: string;
  /** Category id */
  category: string;
  name: string;
  /** Unit price. The docs sometimes show it as a string, the client normalises it to a number. */
  price: number;
}

export enum FormType {
  Text = 1,
  Number = 2,
  Select = 3,
}

export interface FormOption {
  id: string;
  label: string;
  value: string;
}

export interface ProductForm {
  id: string;
  type: FormType;
  label: string;
  placeholder: string;
  isRequired: boolean;
  /** Only used when type = Select */
  options: FormOption[];
}

export interface ProductDetail extends ProductSummary {
  bannerUrl?: string;
  categories: Category[];
  items: ProductItem[];
  forms: ProductForm[];
}

export enum TransactionStatus {
  Refunded = -2,
  Cancelled = -1,
  Unpaid = 0,
  OnProcess = 1,
  Completed = 2,
  OnHold = 3,
}

export interface TransactionItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
  subTotal: number;
  redeemCode?: string | null;
}

export interface FormValue {
  label: string;
  value: string;
}

export interface Transaction {
  id: string;
  merchantOrderId: string | null;
  status: TransactionStatus;
  subTotal: number;
  discount: number;
  total: number;
  createdAt: string;
  product: ProductSummary;
  item: TransactionItem;
  forms: FormValue[];
}

export interface TransactionUpdate {
  id: string;
  status: string;
  createdAt: string;
  description: string;
}

export interface TransactionDetail extends Transaction {
  updates: TransactionUpdate[];
}

export interface PaginationMeta {
  current_page: number;
  from: number | null;
  last_page: number;
  per_page: number;
  to: number | null;
  total: number;
  path: string;
}

export interface TransactionPage {
  data: Transaction[];
  meta?: PaginationMeta;
}

export interface TransactionCreateRequest {
  merchantOrderId?: string;
  slug: string;
  /** item price x quantity, must match the current price or the API returns 422 */
  price: number;
  item: { id: string; quantity: number };
  forms: { id: string; value: string }[];
}
