// Audit store: one small SQLite file (default data/audit.db) using Node's built-in node:sqlite.
// No extra install needed. Open it with any SQLite viewer (e.g. DB Browser for SQLite) or
// export CSV with /audit export.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface Session {
  id: number;
  user_id: string;
  username: string;
  guild_id: string | null;
  channel_id: string | null;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  last_activity_at: string;
}

export type TopupMode = 'live' | 'test';
export type TopupStatus = 'placed' | 'failed' | 'test' | 'rejected';

export interface TopupRow {
  id: number;
  session_id: number;
  user_id: string;
  username: string;
  created_at: string;
  mode: TopupMode;
  status: TopupStatus;
  game_slug: string;
  game_title: string;
  item_id: string;
  item_name: string;
  quantity: number;
  unit_price_idr: number;
  total_idr: number;
  fields_json: string;
  merchant_order_id: string | null;
  transaction_id: string | null;
  tx_status: string | null;
  error: string | null;
  approved_by: string | null;
}

export interface NewTopup {
  sessionId: number;
  userId: string;
  username: string;
  mode: TopupMode;
  status: TopupStatus;
  gameSlug: string;
  gameTitle: string;
  itemId: string;
  itemName: string;
  quantity: number;
  unitPriceIdr: number;
  totalIdr: number;
  fields: { label: string; value: string }[];
  merchantOrderId?: string | null;
  transactionId?: string | null;
  error?: string | null;
  /** Admin username who approved or rejected it (null when no approval was needed) */
  approvedBy?: string | null;
}

export interface SessionSummary {
  session: Session;
  liveCount: number;
  liveTotal: number;
  testCount: number;
  failedCount: number;
  latest: TopupRow[];
}

export interface UserTotal {
  user_id: string;
  username: string;
  sessions: number;
  topups: number;
  total_idr: number;
  open_session: boolean;
}

const now = () => new Date().toISOString();

export class AuditStore {
  private db: DatabaseSync;

  constructor(file = process.env.AUDIT_DB_PATH?.trim() || 'data/audit.db') {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        guild_id TEXT,
        channel_id TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        end_reason TEXT,
        last_activity_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, ended_at);

      CREATE TABLE IF NOT EXISTS topups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id),
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        created_at TEXT NOT NULL,
        mode TEXT NOT NULL,             -- live | test
        status TEXT NOT NULL,           -- placed | failed | test | rejected
        game_slug TEXT NOT NULL,
        game_title TEXT NOT NULL,
        item_id TEXT NOT NULL,
        item_name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        unit_price_idr REAL NOT NULL,   -- real price per item from the API
        total_idr REAL NOT NULL,        -- what was paid (unit x quantity)
        fields_json TEXT NOT NULL,      -- player info sent (e.g. Razer link)
        merchant_order_id TEXT,
        transaction_id TEXT,
        tx_status TEXT,                 -- latest status from the API (On Process, Completed, ...)
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_topups_session ON topups(session_id);
      CREATE INDEX IF NOT EXISTS idx_topups_created ON topups(created_at);
    `);
    // v2: who approved / rejected a member's top-up
    const cols = this.db.prepare('PRAGMA table_info(topups)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'approved_by')) this.db.exec('ALTER TABLE topups ADD COLUMN approved_by TEXT');
  }

  // ---------- Sessions ----------

  getActiveSession(userId: string): Session | undefined {
    return this.db
      .prepare('SELECT * FROM sessions WHERE user_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1')
      .get(userId) as Session | undefined;
  }

  getSession(id: number): Session | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
  }

  getLastSession(userId: string): Session | undefined {
    return this.db
      .prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .get(userId) as Session | undefined;
  }

  /** Starts a session, or returns the one already open (created = false). */
  startSession(
    userId: string,
    username: string,
    guildId: string | null,
    channelId: string | null,
  ): { session: Session; created: boolean } {
    const open = this.getActiveSession(userId);
    if (open) return { session: open, created: false };
    const t = now();
    const r = this.db
      .prepare(
        'INSERT INTO sessions (user_id, username, guild_id, channel_id, started_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(userId, username, guildId, channelId, t, t);
    return { session: this.getSession(Number(r.lastInsertRowid))!, created: true };
  }

  endSession(sessionId: number, reason: 'manual' | 'idle'): void {
    this.db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL').run(now(), reason, sessionId);
  }

  touchSession(sessionId: number): void {
    this.db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(now(), sessionId);
  }

  /** Ends sessions with no activity for `hours`. Returns the sessions that were ended. */
  endIdleSessions(hours: number): Session[] {
    const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
    const idle = this.db
      .prepare('SELECT * FROM sessions WHERE ended_at IS NULL AND last_activity_at < ?')
      .all(cutoff) as unknown as Session[];
    for (const s of idle) this.endSession(s.id, 'idle');
    return idle;
  }

  summarize(sessionId: number, latest = 5): SessionSummary {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found.`);
    const agg = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'placed' THEN 1 ELSE 0 END) AS live_count,
           SUM(CASE WHEN status = 'placed' THEN total_idr ELSE 0 END) AS live_total,
           SUM(CASE WHEN status = 'test' THEN 1 ELSE 0 END) AS test_count,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
         FROM topups WHERE session_id = ?`,
      )
      .get(sessionId) as Record<string, number | null>;
    return {
      session,
      liveCount: agg.live_count ?? 0,
      liveTotal: agg.live_total ?? 0,
      testCount: agg.test_count ?? 0,
      failedCount: agg.failed_count ?? 0,
      latest: this.db
        .prepare('SELECT * FROM topups WHERE session_id = ? ORDER BY id DESC LIMIT ?')
        .all(sessionId, latest) as unknown as TopupRow[],
    };
  }

  // ---------- Top-ups ----------

  recordTopup(t: NewTopup): TopupRow {
    const r = this.db
      .prepare(
        `INSERT INTO topups (session_id, user_id, username, created_at, mode, status, game_slug, game_title,
           item_id, item_name, quantity, unit_price_idr, total_idr, fields_json, merchant_order_id, transaction_id, error, approved_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.sessionId,
        t.userId,
        t.username,
        now(),
        t.mode,
        t.status,
        t.gameSlug,
        t.gameTitle,
        t.itemId,
        t.itemName,
        t.quantity,
        t.unitPriceIdr,
        t.totalIdr,
        JSON.stringify(t.fields),
        t.merchantOrderId ?? null,
        t.transactionId ?? null,
        t.error ?? null,
        t.approvedBy ?? null,
      );
    this.touchSession(t.sessionId);
    return this.db.prepare('SELECT * FROM topups WHERE id = ?').get(Number(r.lastInsertRowid)) as unknown as TopupRow;
  }

  setTxStatus(topupId: number, txStatus: string): void {
    this.db.prepare('UPDATE topups SET tx_status = ? WHERE id = ?').run(txStatus, topupId);
  }

  latestTopups(limit = 10, userId?: string): TopupRow[] {
    return (
      userId
        ? this.db.prepare('SELECT * FROM topups WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit)
        : this.db.prepare('SELECT * FROM topups ORDER BY id DESC LIMIT ?').all(limit)
    ) as unknown as TopupRow[];
  }

  /** Paid totals per user for one local day (e.g. "2026-11-25" in Asia/Singapore). */
  dailyTotals(day: string, timeZone: string): UserTotal[] {
    // Small data set: load the last 2 days and filter by local date in JS (handles any time zone).
    const since = new Date(Date.parse(day + 'T00:00:00Z') - 2 * 86400_000).toISOString();
    const rows = this.db
      .prepare("SELECT * FROM topups WHERE status = 'placed' AND created_at >= ?")
      .all(since) as unknown as TopupRow[];
    const byUser = new Map<string, UserTotal & { sessionIds: Set<number> }>();
    for (const r of rows) {
      if (localDate(r.created_at, timeZone) !== day) continue;
      const u = byUser.get(r.user_id) ?? {
        user_id: r.user_id,
        username: r.username,
        sessions: 0,
        topups: 0,
        total_idr: 0,
        open_session: !!this.getActiveSession(r.user_id),
        sessionIds: new Set<number>(),
      };
      u.topups++;
      u.total_idr += r.total_idr;
      u.sessionIds.add(r.session_id);
      u.sessions = u.sessionIds.size;
      byUser.set(r.user_id, u);
    }
    return [...byUser.values()]
      .map(({ sessionIds: _s, ...u }) => u)
      .sort((a, b) => b.total_idr - a.total_idr);
  }

  /** All top-ups from the last `days` days as CSV (Excel/Sheets friendly). */
  exportCsv(days = 30): string {
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const rows = this.db
      .prepare('SELECT * FROM topups WHERE created_at >= ? ORDER BY id')
      .all(since) as unknown as TopupRow[];
    const cols: (keyof TopupRow)[] = [
      'id', 'session_id', 'created_at', 'username', 'user_id', 'mode', 'status', 'game_title', 'item_name',
      'quantity', 'unit_price_idr', 'total_idr', 'transaction_id', 'merchant_order_id', 'tx_status', 'approved_by', 'error', 'fields_json',
    ];
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
  }

  close(): void {
    this.db.close();
  }
}

/** "2026-11-25" for an ISO timestamp in the given time zone. */
export function localDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(iso),
  );
}
