import 'dotenv/config';

export interface BotConfig {
  token: string;
  guildId: string;
  /** Members with this role can start sessions and top up */
  topupRoleId: string | null;
  /** Discord user ids that can do everything, incl. /audit for everyone, /balance and export */
  adminIds: Set<string>;
  /** Game used when /topup has no game option (slug or name words) */
  defaultGame: string | null;
  /** Optional channel that also receives top-up / session log lines */
  logChannelId: string | null;
  /** Time zone for "today" in /audit today */
  timeZone: string;
  /** Sessions with no activity for this many hours end automatically */
  idleHours: number;
}

export function loadBotConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const req = (name: string) => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`${name} is not set. See .env.example.`);
    return v;
  };
  const adminIds = new Set(
    (env.DISCORD_ADMIN_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const topupRoleId = env.DISCORD_TOPUP_ROLE_ID?.trim() || null;
  if (!topupRoleId && !adminIds.size) {
    throw new Error('Set DISCORD_TOPUP_ROLE_ID and/or DISCORD_ADMIN_IDS, otherwise nobody can use the bot.');
  }
  return {
    token: req('DISCORD_TOKEN'),
    guildId: req('DISCORD_GUILD_ID'),
    topupRoleId,
    adminIds,
    defaultGame: env.DISCORD_DEFAULT_GAME?.trim() || null,
    logChannelId: env.DISCORD_LOG_CHANNEL_ID?.trim() || null,
    timeZone: env.AUDIT_TIMEZONE?.trim() || 'Asia/Singapore',
    idleHours: Number(env.SESSION_IDLE_HOURS) || 12,
  };
}
