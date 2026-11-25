// Discord bot: sessions + top-ups with an audit trail.
// Run: npm run bot   (or with PM2: pm2 start npm --name gacha-bot -- run bot)
import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type MessageCreateOptions,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { AuditStore, type Session, type TopupRow } from '../audit/db.js';
import { GachaApiError, GachaClient } from '../client.js';
import { getProductsCached, matchProducts } from '../commands/shared.js';
import { resolveGame } from '../presets.js';
import { executeTopup, isFinalStatus, prepareTopup, statusLabel, waitForTransaction, type TopupPreview } from '../topup.js';
import type { ProductDetail, ProductItem } from '../types.js';
import { loadBotConfig } from './config.js';
import { dailyText, idr, localTime, mapFields, matchItems, optionFor, sessionText, today, topupLine } from './logic.js';

const cfg = loadBotConfig();
const gacha = new GachaClient();
const audit = new AuditStore();
const EPHEMERAL = MessageFlags.Ephemeral;
const NO_PINGS = { parse: [] as never[] };

// ---------- Slash command definitions ----------

function addTopupOptions(b: SlashCommandBuilder): SlashCommandBuilder {
  b.addStringOption((o) =>
    o.setName('product').setDescription('Product name or price to search, e.g. 136').setRequired(true).setAutocomplete(true),
  )
    .addStringOption((o) => o.setName('link').setDescription('Razer / payment link, for games that need one'))
    .addStringOption((o) =>
      o
        .setName('game')
        .setDescription(cfg.defaultGame ? `Game (default: ${cfg.defaultGame})` : 'Game')
        .setAutocomplete(true),
    )
    .addIntegerOption((o) => o.setName('quantity').setDescription('How many (default 1)').setMinValue(1).setMaxValue(100))
    .addStringOption((o) => o.setName('user_id').setDescription('Player/User ID, for games that need one'))
    .addStringOption((o) => o.setName('server').setDescription('Server/Zone, for games that need one'))
    .addStringOption((o) => o.setName('extra').setDescription('Other fields: Label=value; Label2=value'));
  return b;
}

const commandDefs = [
  new SlashCommandBuilder().setName('start-session').setDescription('Start your top-up session (needed before /topup)'),
  new SlashCommandBuilder()
    .setName('end-session')
    .setDescription('End your session and show its total')
    .addUserOption((o) => o.setName('user').setDescription('Admin: end someone else\'s session')),
  new SlashCommandBuilder()
    .setName('session')
    .setDescription('Show your current (or last) session')
    .addUserOption((o) => o.setName('user').setDescription('Admin: show someone else\'s session')),
  addTopupOptions(new SlashCommandBuilder().setName('topup').setDescription('Top up (asks for confirmation, spends deposit)')),
  addTopupOptions(new SlashCommandBuilder().setName('topup-test').setDescription('Test a top-up: same checks, nothing is sent')),
  new SlashCommandBuilder()
    .setName('audit')
    .setDescription('Top-up records')
    .addSubcommand((s) =>
      s
        .setName('today')
        .setDescription('Admin: paid totals per user for a day')
        .addStringOption((o) => o.setName('date').setDescription('YYYY-MM-DD (default today)')),
    )
    .addSubcommand((s) =>
      s
        .setName('latest')
        .setDescription('Latest top-ups (yours, or anyone\'s for admins)')
        .addIntegerOption((o) => o.setName('count').setDescription('How many (default 10)').setMinValue(1).setMaxValue(25))
        .addUserOption((o) => o.setName('user').setDescription('Admin: only this user')),
    )
    .addSubcommand((s) =>
      s
        .setName('export')
        .setDescription('Admin: download top-ups as CSV')
        .addIntegerOption((o) => o.setName('days').setDescription('Last N days (default 30)').setMinValue(1).setMaxValue(3650)),
    ),
  new SlashCommandBuilder().setName('balance').setDescription('Merchant deposit balance'),
  new SlashCommandBuilder()
    .setName('order')
    .setDescription('Check a transaction status')
    .addStringOption((o) => o.setName('id').setDescription('Transaction id').setRequired(true)),
];

// ---------- Permissions ----------

function isAdmin(userId: string): boolean {
  return cfg.adminIds.has(userId);
}

function canTopup(i: Interaction): boolean {
  if (isAdmin(i.user.id)) return true;
  if (!cfg.topupRoleId || !i.inGuild()) return false;
  const roles = i.member.roles;
  return Array.isArray(roles) ? roles.includes(cfg.topupRoleId) : roles.cache.has(cfg.topupRoleId);
}

const roleHint = () => (cfg.topupRoleId ? `You need the <@&${cfg.topupRoleId}> role.` : 'Only admins can use this.');

// ---------- Small caches (keep autocomplete fast) ----------

const productCache = new Map<string, { at: number; product: ProductDetail }>();
async function getGame(ref: string): Promise<ProductDetail> {
  const hit = productCache.get(ref);
  if (hit && Date.now() - hit.at < 60_000) return hit.product;
  const product = await resolveGame(gacha, ref);
  productCache.set(ref, { at: Date.now(), product });
  productCache.set(product.slug, { at: Date.now(), product });
  return product;
}

// ---------- Pending top-ups (between the command, the pick-list and the Confirm button) ----------

interface Pending {
  userId: string;
  username: string;
  sessionId: number;
  mode: 'live' | 'test';
  slug: string;
  query: string;
  quantity: number;
  forms: Record<string, string>;
  preview?: TopupPreview;
  createdAt: number;
}
const pending = new Map<string, Pending>();
const PENDING_TTL = 5 * 60_000;
setInterval(() => {
  for (const [k, p] of pending) if (Date.now() - p.createdAt > PENDING_TTL) pending.delete(k);
}, 60_000).unref();

// ---------- Interaction router ----------

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  const rest = new REST().setToken(cfg.token);
  await rest.put(Routes.applicationGuildCommands(c.application.id, cfg.guildId), {
    body: commandDefs.map((d) => d.toJSON()),
  });
  console.log(`Logged in as ${c.user.tag}. ${commandDefs.length} commands registered in guild ${cfg.guildId}.`);
  if (gacha.dryRun) console.log('GACHA_DRY_RUN is on: /topup will not send real orders.');
  console.log(cfg.requireApproval ? `Approval is ON: members' top-ups need an admin to approve (expires after ${cfg.approvalMinutes} min).` : 'Approval is OFF: anyone with the role can pay directly.');
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isAutocomplete()) return await onAutocomplete(i);
    if (i.isChatInputCommand()) return await onCommand(i);
    if (i.isStringSelectMenu() && i.customId.startsWith('tp:pick:')) return await onPick(i);
    if (i.isButton() && i.customId.startsWith('tp:')) return await onButton(i);
    if (i.isButton() && i.customId.startsWith('ap:')) return await onApproval(i);
  } catch (e) {
    console.error(e);
    if (!i.isRepliable()) return;
    const msg = `Something went wrong: ${errorText(e)}`;
    if (i.deferred || i.replied) await i.editReply({ content: msg, embeds: [], components: [] }).catch(() => {});
    else await i.reply({ content: msg, flags: EPHEMERAL }).catch(() => {});
  }
});

function errorText(e: unknown): string {
  if (e instanceof GachaApiError) return `API error: ${e.message}`;
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'The API did not answer in time.';
  return e instanceof Error ? e.message : String(e);
}

async function onAutocomplete(i: AutocompleteInteraction): Promise<void> {
  const focused = i.options.getFocused(true);
  try {
    if (focused.name === 'game') {
      const list = matchProducts(await getProductsCached(gacha), String(focused.value)).slice(0, 25);
      return await i.respond(list.map((p) => ({ name: p.title.slice(0, 100), value: p.slug })));
    }
    if (focused.name === 'product') {
      const ref = i.options.getString('game') || cfg.defaultGame;
      if (!ref) return await i.respond([]);
      const product = await getGame(ref);
      const items = matchItems(product, String(focused.value)).slice(0, 25);
      return await i.respond(items.map((it) => ({ name: `${it.name} — ${idr(it.price)}`.slice(0, 100), value: it.id })));
    }
    await i.respond([]);
  } catch {
    await i.respond([]).catch(() => {});
  }
}

async function onCommand(i: ChatInputCommandInteraction): Promise<void> {
  switch (i.commandName) {
    case 'start-session':
      return startSession(i);
    case 'end-session':
      return endSession(i);
    case 'session':
      return showSession(i);
    case 'topup':
      return startTopup(i, 'live');
    case 'topup-test':
      return startTopup(i, 'test');
    case 'audit':
      return auditCommand(i);
    case 'balance':
      return balance(i);
    case 'order':
      return order(i);
  }
}

// ---------- Sessions ----------

async function startSession(i: ChatInputCommandInteraction): Promise<void> {
  if (!canTopup(i)) return void (await i.reply({ content: roleHint(), flags: EPHEMERAL }));
  const { session, created } = audit.startSession(i.user.id, i.user.username, i.guildId, i.channelId);
  if (!created) {
    return void (await i.reply({
      content: `You already have an open session.\n\n${sessionText(audit.summarize(session.id), cfg.timeZone)}`,
      flags: EPHEMERAL,
    }));
  }
  const text = `▶️ Session #${session.id} started for **${session.username}**. Top-ups from now on are recorded under it. End it with \`/end-session\`.`;
  await i.reply({ content: text, allowedMentions: NO_PINGS });
  await logToChannel(text, i.channelId);
}

async function endSession(i: ChatInputCommandInteraction): Promise<void> {
  const target = i.options.getUser('user');
  if (target && target.id !== i.user.id && !isAdmin(i.user.id)) {
    return void (await i.reply({ content: 'Only admins can end someone else\'s session.', flags: EPHEMERAL }));
  }
  const who = target ?? i.user;
  const session = audit.getActiveSession(who.id);
  if (!session) return void (await i.reply({ content: `${who.username} has no open session.`, flags: EPHEMERAL }));
  audit.endSession(session.id, 'manual');
  const text = `⏹️ Session ended.\n${sessionText(audit.summarize(session.id), cfg.timeZone)}`;
  await i.reply({ content: text, allowedMentions: NO_PINGS });
  await logToChannel(text, i.channelId);
}

async function showSession(i: ChatInputCommandInteraction): Promise<void> {
  const target = i.options.getUser('user');
  if (target && target.id !== i.user.id && !isAdmin(i.user.id)) {
    return void (await i.reply({ content: 'Only admins can see someone else\'s session.', flags: EPHEMERAL }));
  }
  const who = target ?? i.user;
  const session = audit.getActiveSession(who.id) ?? audit.getLastSession(who.id);
  if (!session) return void (await i.reply({ content: `${who.username} has no sessions yet.`, flags: EPHEMERAL }));
  await i.reply({ content: sessionText(audit.summarize(session.id, 10), cfg.timeZone), flags: EPHEMERAL });
}

// Close sessions nobody used for a while, and say so where they were started.
setInterval(async () => {
  for (const s of audit.endIdleSessions(cfg.idleHours)) {
    const text = `⏹️ Session ended after ${cfg.idleHours}h without activity.\n${sessionText(audit.summarize(s.id), cfg.timeZone)}`;
    await logToChannel(text, null, s.channel_id);
  }
}, 10 * 60_000).unref();

// ---------- Top-up flow: command -> (pick-list) -> preview -> Confirm ----------

async function startTopup(i: ChatInputCommandInteraction, mode: 'live' | 'test'): Promise<void> {
  await i.deferReply({ flags: EPHEMERAL });
  if (!canTopup(i)) return void (await i.editReply(roleHint()));

  const session = audit.getActiveSession(i.user.id);
  if (!session) return void (await i.editReply('Start a session first with `/start-session`.'));

  const gameRef = i.options.getString('game') || cfg.defaultGame;
  if (!gameRef) return void (await i.editReply('Choose a game with the `game` option.'));
  const product = await getGame(gameRef);

  const { forms, missing } = mapFields(product, {
    link: i.options.getString('link'),
    userId: i.options.getString('user_id'),
    server: i.options.getString('server'),
    extra: i.options.getString('extra'),
  });
  if (missing.length) {
    return void (await i.editReply(
      `${product.title} needs: ${missing.map((m) => `**${m}** (${optionFor(m)})`).join(', ')}.`,
    ));
  }

  const query = i.options.getString('product', true);
  const matches = matchItems(product, query);
  if (!matches.length) {
    const sample = product.items
      .slice()
      .sort((a, b) => a.price - b.price)
      .slice(0, 10)
      .map((it) => `• ${it.name} — ${idr(it.price)}`)
      .join('\n');
    return void (await i.editReply(`No ${product.title} product matches "${query}". Some products:\n${sample}`));
  }

  const token = randomBytes(6).toString('hex');
  const p: Pending = {
    userId: i.user.id,
    username: i.user.username,
    sessionId: session.id,
    mode,
    slug: product.slug,
    query,
    quantity: i.options.getInteger('quantity') ?? 1,
    forms,
    createdAt: Date.now(),
  };
  pending.set(token, p);

  if (matches.length === 1) {
    const note = matches[0].id === query ? undefined : `Only one product matches "${query}".`;
    return showPreview(i, token, p, product, matches[0], note);
  }
  if (matches.length > 25) {
    pending.delete(token);
    return void (await i.editReply(`${matches.length} products match "${query}". Type more of the name or price.`));
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`tp:pick:${token}`)
    .setPlaceholder('Pick the product')
    .addOptions(
      matches.map((it) => ({
        label: it.name.slice(0, 100),
        description: idr(it.price).slice(0, 100),
        value: it.id,
      })),
    );
  await i.editReply({
    content: `${matches.length} ${product.title} products match "${query}". Which one?`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  });
}

async function onPick(i: StringSelectMenuInteraction): Promise<void> {
  const token = i.customId.split(':')[2];
  const p = pending.get(token);
  if (!p) return void (await i.update({ content: 'This top-up expired. Run the command again.', components: [] }));
  if (p.userId !== i.user.id) return void (await i.reply({ content: 'This is not your top-up.', flags: EPHEMERAL }));
  await i.deferUpdate();
  const product = await getGame(p.slug);
  const item = product.items.find((it) => it.id === i.values[0]);
  if (!item) return void (await i.editReply({ content: 'That product is no longer available.', components: [] }));
  await showPreview(i, token, p, product, item);
}

async function showPreview(
  i: ChatInputCommandInteraction | StringSelectMenuInteraction,
  token: string,
  p: Pending,
  product: ProductDetail,
  item: ProductItem,
  note?: string,
): Promise<void> {
  const preview = await prepareTopup(gacha, { slug: product.slug, item: item.id, quantity: p.quantity, forms: p.forms });
  p.preview = preview;

  const test = p.mode === 'test';
  const embed = new EmbedBuilder()
    .setTitle(test ? '🧪 Test top-up (nothing will be sent)' : 'Confirm top-up')
    .setColor(preview.ok ? (test ? 0x5865f2 : 0xf0b232) : 0xda373c)
    .addFields(
      { name: 'Game', value: product.title, inline: true },
      { name: 'Session', value: `#${p.sessionId} · ${p.username}`, inline: true },
      { name: 'Product', value: item.name },
      { name: 'Price', value: `${idr(item.price)} × ${p.quantity}`, inline: true },
      { name: 'Total', value: `**${idr(preview.total)}**`, inline: true },
      ...preview.formSummary.map((f) => ({ name: f.label, value: f.value.slice(0, 1024) })),
    );
  if (isAdmin(p.userId)) {
    embed.addFields({ name: 'Deposit', value: `${idr(preview.balance)} → ${idr(preview.balanceAfter)}` });
  }
  if (note) embed.setFooter({ text: note });

  if (!preview.ok) {
    pending.delete(token);
    embed.setDescription(preview.errors.map((e) => `• ${e}`).join('\n'));
    return void (await i.editReply({ content: '', embeds: [embed], components: [] }));
  }

  const approval = needsApproval(p);
  if (approval) embed.setFooter({ text: [note, `An admin must approve this (expires ${cfg.approvalMinutes} min after you request).`].filter(Boolean).join(' · ') });
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`tp:${approval ? 'req' : 'ok'}:${token}`)
      .setLabel(test ? 'Run test' : approval ? 'Request approval' : `Pay ${idr(preview.total)}`)
      .setStyle(test ? ButtonStyle.Primary : ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`tp:no:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  await i.editReply({ content: '', embeds: [embed], components: [buttons] });
}

async function onButton(i: ButtonInteraction): Promise<void> {
  const [, action, token] = i.customId.split(':');
  const p = pending.get(token);
  if (!p) return void (await i.update({ content: 'This top-up expired. Run the command again.', embeds: [], components: [] }));
  if (p.userId !== i.user.id) return void (await i.reply({ content: 'This is not your top-up.', flags: EPHEMERAL }));
  pending.delete(token); // one click only, no double orders

  if (action === 'no') return void (await i.update({ content: 'Cancelled. Nothing was ordered.', embeds: [], components: [] }));
  if (action === 'req') {
    if (!needsApproval(p)) return void (await i.update({ content: 'This top-up expired. Run the command again.', embeds: [], components: [] }));
    return requestApproval(i, p);
  }
  if (needsApproval(p)) return void (await i.update({ content: 'This top-up needs admin approval. Run the command again.', embeds: [], components: [] }));

  await i.update({ content: '⏳ Working...', embeds: [], components: [] });
  const result = await placeOrder(i, p, p.preview!, null);
  await i.editReply(result);
}

/** Real top-ups by non-admins need approval when TOPUP_REQUIRE_APPROVAL is on. Tests never do. */
function needsApproval(p: Pending): boolean {
  return p.mode === 'live' && cfg.requireApproval && !isAdmin(p.userId);
}

/**
 * Places (or, for tests / GACHA_DRY_RUN, simulates) the order, records it in the audit,
 * posts the public line through the requester's interaction and tracks the status.
 * Returns the text to show to whoever triggered it.
 */
async function placeOrder(requester: ButtonInteraction, p: Pending, preview: TopupPreview, approvedBy: string | null): Promise<string> {
  const session = audit.getSession(p.sessionId);
  if (!session || session.ended_at) {
    return 'The session ended before the order was placed. Nothing was ordered. Start a new one with `/start-session`.';
  }

  const base = {
    sessionId: p.sessionId,
    userId: p.userId,
    username: p.username,
    gameSlug: preview.product.slug,
    gameTitle: preview.product.title,
    itemId: preview.item!.id,
    itemName: preview.item!.name,
    quantity: preview.quantity,
    unitPriceIdr: preview.item!.unitPrice,
    totalIdr: preview.total,
    fields: preview.formSummary,
    merchantOrderId: preview.request!.merchantOrderId,
    approvedBy,
  };

  if (p.mode === 'test' || gacha.dryRun) {
    audit.recordTopup({ ...base, mode: 'test', status: 'test' });
    return (
      `🧪 Test passed: **${preview.item!.name}** ×${preview.quantity} for **${idr(preview.total)}** would be ordered. Nothing was sent.` +
      (p.mode === 'live' ? '\n(GACHA_DRY_RUN is on, so /topup only simulates.)' : '')
    );
  }

  let txId: string;
  try {
    const result = await executeTopup(gacha, preview);
    txId = result.transactionId!;
  } catch (e) {
    audit.recordTopup({ ...base, mode: 'live', status: 'failed', error: errorText(e) });
    return `❌ Top-up failed, nothing was charged by this bot: ${errorText(e)}`;
  }

  const row = audit.recordTopup({ ...base, mode: 'live', status: 'placed', transactionId: txId });
  const sum = audit.summarize(p.sessionId, 0);
  const line =
    `✅ **${p.username}** topped up ${preview.product.title} · ${preview.item!.name} ×${preview.quantity} · **${idr(preview.total)}**` +
    (approvedBy ? ` (approved by ${approvedBy})` : '') +
    `\nSession #${p.sessionId} total: **${idr(sum.liveTotal)}** (${sum.liveCount} top-ups) · \`${txId}\``;
  const publicMsg = await requester.followUp({ content: line, allowedMentions: NO_PINGS }).catch(() => null);
  const logMsg = await logToChannel(line, requester.channelId);
  void trackStatus(row, txId, line, requester, publicMsg, logMsg);
  return `✅ Order placed. Transaction \`${txId}\`. The status will be posted in the channel.`;
}

// ---------- Admin approval (DM with Approve / Reject) ----------

interface Approval {
  p: Pending;
  requester: ButtonInteraction;
  dms: Message[];
  timer: NodeJS.Timeout;
}
const approvals = new Map<string, Approval>();

/** Sends a DM. Replaceable in tests. */
let sendDm = async (userId: string, payload: MessageCreateOptions): Promise<Message> => {
  const user = await client.users.fetch(userId);
  return user.send(payload);
};

function approvalEmbed(p: Pending, preview: TopupPreview, status?: string): EmbedBuilder {
  const e = new EmbedBuilder()
    .setTitle(status ?? '🟡 Top-up approval')
    .setColor(status ? 0x80848e : 0xf0b232)
    .addFields(
      { name: 'Requested by', value: `${p.username} · session #${p.sessionId}`, inline: true },
      { name: 'Game', value: preview.product.title, inline: true },
      { name: 'Product', value: preview.item!.name },
      { name: 'Price', value: `${idr(preview.item!.unitPrice)} × ${preview.quantity}`, inline: true },
      { name: 'Total', value: `**${idr(preview.total)}**`, inline: true },
      ...preview.formSummary.map((f) => ({ name: f.label, value: f.value.slice(0, 1024) })),
      { name: 'Deposit', value: `${idr(preview.balance)} → ${idr(preview.balanceAfter)}` },
    );
  return e;
}

async function requestApproval(i: ButtonInteraction, p: Pending): Promise<void> {
  await i.update({ content: '⏳ Sending to an admin for approval...', embeds: [], components: [] });
  const preview = p.preview!;
  const id = randomBytes(6).toString('hex');
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`ap:ok:${id}`).setLabel(`Approve ${idr(preview.total)}`).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ap:no:${id}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
  );

  const dms: Message[] = [];
  for (const adminId of cfg.adminIds) {
    try {
      dms.push(await sendDm(adminId, { embeds: [approvalEmbed(p, preview)], components: [buttons] }));
    } catch (e) {
      console.error(`Could not DM admin ${adminId}:`, e);
    }
  }
  if (!dms.length) {
    return void (await i.editReply('Could not reach an admin by DM (their DMs may be closed). Nothing was ordered.'));
  }

  const timer = setTimeout(() => void expireApproval(id), cfg.approvalMinutes * 60_000);
  timer.unref();
  approvals.set(id, { p, requester: i, dms, timer });
  await i.editReply(
    `📨 Sent to an admin for approval: **${preview.item!.name}** ×${preview.quantity} · **${idr(preview.total)}**.\n` +
      `You'll see the result here. The request expires in ${cfg.approvalMinutes} minutes.`,
  );
}

async function onApproval(i: ButtonInteraction): Promise<void> {
  const [, action, id] = i.customId.split(':');
  if (!isAdmin(i.user.id)) return void (await i.reply({ content: 'Only admins can approve top-ups.', flags: EPHEMERAL }));
  const a = approvals.get(id);
  if (!a) return void (await i.update({ content: '⌛ This request expired or was already handled. Nothing was ordered.', components: [] }));
  approvals.delete(id); // first admin to click wins, no double orders
  clearTimeout(a.timer);
  const { p, requester } = a;
  const admin = i.user.username;
  const original = p.preview!;

  const finish = async (title: string, text: string) => {
    const payload = { content: text, embeds: [approvalEmbed(p, original, title)], components: [] };
    await i.editReply(payload).catch(() => {});
    for (const dm of a.dms) if (dm.id !== i.message.id) await dm.edit(payload).catch(() => {});
  };

  if (action === 'no') {
    await i.update({ components: [] });
    audit.recordTopup({
      sessionId: p.sessionId, userId: p.userId, username: p.username, mode: 'live', status: 'rejected',
      gameSlug: original.product.slug, gameTitle: original.product.title, itemId: original.item!.id,
      itemName: original.item!.name, quantity: original.quantity, unitPriceIdr: original.item!.unitPrice,
      totalIdr: original.total, fields: original.formSummary, approvedBy: admin,
    });
    await finish(`🚫 Rejected by ${admin}`, 'Nothing was ordered.');
    await requester.editReply(`🚫 Rejected by an admin. Nothing was ordered.`).catch(() => {});
    return;
  }

  await i.update({ content: '⏳ Checking the live price and placing the order...', components: [] });
  // Prices or the deposit may have moved since the request: check again before spending.
  const fresh = await prepareTopup(gacha, {
    slug: p.slug, item: original.item!.id, quantity: p.quantity, forms: p.forms,
  });
  if (!fresh.ok || fresh.total !== original.total) {
    const why = !fresh.ok ? fresh.errors.join(' ') : `The price changed from ${idr(original.total)} to ${idr(fresh.total)}.`;
    await finish(`⚠️ Not ordered`, `${why} Nothing was ordered; ask ${p.username} to request again.`);
    await requester.editReply(`⚠️ Not ordered: ${why} Run \`/topup\` again.`).catch(() => {});
    return;
  }

  const result = await placeOrder(requester, p, fresh, admin);
  const ok = result.startsWith('✅') || result.startsWith('🧪');
  await finish(ok ? `✅ Approved by ${admin}` : `❌ Approved by ${admin}, but it failed`, result);
  await requester.editReply(`${result}\n(Approved by ${admin}.)`).catch(() => {});
}

async function expireApproval(id: string): Promise<void> {
  const a = approvals.get(id);
  if (!a) return;
  approvals.delete(id);
  const text = `⌛ Expired after ${cfg.approvalMinutes} minutes without an answer. Nothing was ordered.`;
  for (const dm of a.dms) {
    await dm.edit({ content: text, embeds: [approvalEmbed(a.p, a.p.preview!, '⌛ Expired')], components: [] }).catch(() => {});
  }
  await a.requester
    .editReply(`⌛ Your approval request expired (no answer in ${cfg.approvalMinutes} minutes). Nothing was ordered. Run \`/topup\` again.`)
    .catch(() => {});
}

/** Polls the order for up to 10 minutes and updates the audit row and the channel message. */
async function trackStatus(
  row: TopupRow,
  txId: string,
  line: string,
  i: ButtonInteraction,
  publicMsg: Message | null,
  logMsg: Message | null,
): Promise<void> {
  try {
    const tx = await waitForTransaction(gacha, txId, {
      intervalMs: 10_000,
      timeoutMs: 10 * 60_000,
      onUpdate: (t) => audit.setTxStatus(row.id, statusLabel(t.status)),
    });
    const status = statusLabel(tx.status);
    const icon = tx.status === 2 ? '🟢' : isFinalStatus(tx.status) ? '🔴' : '🟡';
    const code = tx.item.redeemCode ? ` · code \`${tx.item.redeemCode}\`` : '';
    const content = `${line}\n${icon} Status: **${status}**${code}`;
    if (publicMsg) await i.webhook.editMessage(publicMsg.id, { content, allowedMentions: NO_PINGS }).catch(() => {});
    if (logMsg) await logMsg.edit({ content, allowedMentions: NO_PINGS }).catch(() => {});
  } catch (e) {
    console.error(`Status check for ${txId} failed:`, e);
  }
}

// ---------- Audit, balance, order ----------

async function auditCommand(i: ChatInputCommandInteraction): Promise<void> {
  const sub = i.options.getSubcommand();
  const admin = isAdmin(i.user.id);

  if (sub === 'latest') {
    const target = i.options.getUser('user');
    if (!admin && target && target.id !== i.user.id) {
      return void (await i.reply({ content: 'Only admins can see other users\' top-ups.', flags: EPHEMERAL }));
    }
    const userId = admin ? target?.id : i.user.id;
    const rows = audit.latestTopups(i.options.getInteger('count') ?? 10, userId);
    const text = rows.length ? rows.map((r) => topupLine(r, cfg.timeZone, true)).join('\n') : 'No top-ups yet.';
    return void (await i.reply({ content: text, flags: EPHEMERAL }));
  }

  if (!admin) return void (await i.reply({ content: 'Only admins can use this.', flags: EPHEMERAL }));

  if (sub === 'today') {
    const day = i.options.getString('date') || today(cfg.timeZone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return void (await i.reply({ content: 'Use YYYY-MM-DD.', flags: EPHEMERAL }));
    return void (await i.reply({ content: dailyText(day, audit.dailyTotals(day, cfg.timeZone)), flags: EPHEMERAL }));
  }

  if (sub === 'export') {
    const days = i.options.getInteger('days') ?? 30;
    const file = new AttachmentBuilder(Buffer.from(audit.exportCsv(days), 'utf8'), {
      name: `topups-last-${days}-days-${today(cfg.timeZone)}.csv`,
    });
    return void (await i.reply({ content: `Top-ups from the last ${days} days.`, files: [file], flags: EPHEMERAL }));
  }
}

async function balance(i: ChatInputCommandInteraction): Promise<void> {
  if (!canTopup(i)) return void (await i.reply({ content: roleHint(), flags: EPHEMERAL }));
  await i.deferReply({ flags: EPHEMERAL });
  await i.editReply(`Deposit balance: **${idr(await gacha.getBalance())}**`);
}

async function order(i: ChatInputCommandInteraction): Promise<void> {
  const id = i.options.getString('id', true).trim();
  if (!isAdmin(i.user.id)) {
    const mine = audit.latestTopups(500, i.user.id).some((r) => r.transaction_id === id);
    if (!mine) return void (await i.reply({ content: 'You can only check your own orders.', flags: EPHEMERAL }));
  }
  await i.deferReply({ flags: EPHEMERAL });
  const t = await gacha.getTransaction(id);
  const lines = [
    `**${t.product.title}** · ${t.item.name} ×${t.item.quantity} · ${idr(t.total)}`,
    `Status: **${statusLabel(t.status)}** · created ${localTime(t.createdAt.replace(/\.\d+\+0000$/, 'Z'), cfg.timeZone)}`,
    t.item.redeemCode ? `Redeem code: \`${t.item.redeemCode}\`` : '',
    ...(t.updates ?? []).map((u) => `• ${u.status}: ${u.description}`),
  ].filter(Boolean);
  await i.editReply(lines.join('\n'));
}

// ---------- Log channel ----------

/** Posts to DISCORD_LOG_CHANNEL_ID (if set and different from where the command ran), or to `fallbackChannelId`. */
async function logToChannel(text: string, currentChannelId: string | null, fallbackChannelId?: string | null): Promise<Message | null> {
  const target =
    cfg.logChannelId && cfg.logChannelId !== currentChannelId ? cfg.logChannelId : fallbackChannelId ?? null;
  if (!target) return null;
  try {
    const ch = await client.channels.fetch(target);
    if (ch?.isSendable()) return await ch.send({ content: text, allowedMentions: NO_PINGS });
  } catch (e) {
    console.error(`Could not post to channel ${target}:`, e);
  }
  return null;
}

// ---------- Start ----------

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log('Shutting down...');
    audit.close();
    void client.destroy();
    process.exit(0);
  });
}

// BOT_TEST=1 lets the test script drive the handlers without connecting to Discord.
if (!process.env.BOT_TEST) void client.login(cfg.token);

export const __test = {
  onCommand, onPick, onButton, onApproval, onAutocomplete, pending, approvals, audit, cfg,
  setSendDm: (fn: typeof sendDm) => { sendDm = fn; },
};
export type { Session };
