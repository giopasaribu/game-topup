import 'dotenv/config';

export interface GachaConfig {
  clientSecret: string;
  baseUrl: string;
  timeoutMs: number;
  orderPrefix: string;
  dryRun: boolean;
}

/** Reads config from environment variables (.env is loaded automatically). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GachaConfig {
  const clientSecret = env.GACHA_CLIENT_SECRET?.trim() ?? '';
  if (!clientSecret) {
    throw new Error(
      'GACHA_CLIENT_SECRET is not set. Copy .env.example to .env and add your merchant client secret.',
    );
  }

  return {
    clientSecret,
    baseUrl: (env.GACHA_BASE_URL?.trim() || 'https://api.gachagaming.com/open-api').replace(/\/+$/, ''),
    timeoutMs: Number(env.GACHA_TIMEOUT_MS) || 15000,
    orderPrefix: env.GACHA_ORDER_PREFIX?.trim() || 'GIO',
    dryRun: ['1', 'true', 'yes'].includes((env.GACHA_DRY_RUN ?? '').trim().toLowerCase()),
  };
}
