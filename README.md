# GachaGaming Top-up

Tools for the GachaGaming Open API (v1.0.1):

- a command-line menu (`npm start`, `npm run quick`)
- a **Discord bot** with per-user top-up sessions and an audit trail (`npm run bot`), see [DISCORD-BOT.md](DISCORD-BOT.md)

## Setup

Needs Node.js 22.13 or newer (the Discord bot uses Node's built-in SQLite).

```bash
npm install
copy .env.example .env      # Windows  (cp on Linux/macOS)
# then put your merchant secret in .env:  GACHA_CLIENT_SECRET=...
```

The secret is read only from the `GACHA_CLIENT_SECRET` environment variable, either from `.env` or from the real environment. `.env` is git-ignored.

## Run

```bash
npm run dry     # safe test: everything works, but orders are only simulated
npm start       # live: orders spend your deposit
```

```
Main menu
  1. Check balance
  2. Find a game
  3. Game items & prices
  4. Top up a game
  5. Transaction history
  6. Transaction detail / status
  7. Quick top-up (saved preset)
  0. Exit
```

- Type a number and press Enter. Lists are numbered too.
- When you're asked for a game or item, type part of the name. If only one thing matches, it's picked for you.
- Type `back` at any question (or `0` in a list) to return to the menu. Ctrl+C quits.
- Top-up always shows a preview with the live price and your balance after the order. It only places the order if you type `y`.
- After a reply, a "What next?" list offers follow-ups such as *Top up this game*, *Next page* or *Check status*.

## Quick top-up (menu 7)

Repeat orders of one fixed item. Start it directly with:

```bash
npm run quick        # or: npm start -> 7       (npm run quick:dry = simulated)
```

Each order asks only for what isn't fixed in the preset (for RF Online Next, the Razer link). Then it shows the preview, you type `y`, and it goes straight to the next order. Type `back` to stop.

Presets live in `presets.json`:

```json
[
  {
    "label": "RF Online Next - 136,000",
    "game": "rf-online-next",
    "item": "136",
    "quantity": 1,
    "maxPrice": 100000,
    "fields": {}
  }
]
```

- `item`: search text, used only until the first confirmed order. Then the exact `itemId` (and the exact game slug) is saved into the file automatically, and every later order uses that id.
- `game`: the slug, or words to search for (all words must appear in the game's title or slug).
- `maxPrice`: the order is refused if the total is above this, in case the price changes.
- `fields`: fixed answers by label, e.g. `{ "User ID": "123" }`. Any field not listed here is asked on every order.
- To switch to another item, remove `itemId` and change `item`.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GACHA_CLIENT_SECRET` | (required) | Merchant client secret, sent as `Bearer` token |
| `GACHA_BASE_URL` | `https://api.gachagaming.com/open-api` | API base URL |
| `GACHA_TIMEOUT_MS` | `15000` | Request timeout |
| `GACHA_ORDER_PREFIX` | `GIO` | Prefix of auto `merchantOrderId`, e.g. `GIO-20261118-165301-A1B2` |
| `GACHA_DRY_RUN` | `false` | `true` = never place real orders |
| `GACHA_PRESETS_FILE` | `presets.json` | Where quick top-up presets are stored |

## Structure

```
src/
  config.ts          env vars -> config
  presets.ts         load/save presets.json, find game/item by name
  types.ts           API types + enums
  client.ts          GachaClient: 1 method per API endpoint
  topup.ts           business logic (validate, price check, place order, poll status)
  commands/          one file per feature, NO terminal or Discord code
    types.ts           Command / OptionDef / FieldDef / Reply contracts
    shared.ts          shared options (game, item) and table helper
    balance.ts  games.ts  prices.ts  topup.ts  history.ts  transaction.ts  quick.ts
    index.ts           registry (menu order) + runCommand() that turns errors into replies
  cli.ts             terminal front end: reads the commands, asks questions, prints replies
  index.ts           exports everything
```

### How a command is defined

```ts
export const balance: Command = {
  name: 'balance',                 // -> /balance in Discord
  label: 'Check balance',          // -> menu text in the CLI
  description: 'Show your merchant deposit balance',
  options: [],                     // -> slash command options
  async run({ client }) {
    const deposit = await client.getBalance();
    return reply.ok('Balance', `Deposit balance: **${formatMoney(deposit)}**`, { data: { deposit } });
  },
};
```

To add a feature: create a file in `src/commands/` and add it to the list in `commands/index.ts`. It appears in the CLI menu automatically.

### Turning it into a Discord bot later

Only one new front end file (e.g. `src/discord.ts`) is needed. The command files stay as they are:

| Command contract | Discord (discord.js) |
|---|---|
| `commands` | register each as a slash command (`name`, `description`) |
| `options` | slash command options; `choices()` -> autocomplete (pass `limit` 25) |
| `fields()` | a modal with one input per field (User ID, Server, ...) |
| `runCommand()` | call it in the interaction handler |
| `Reply.title` / `body` | embed title / description (body is already Discord markdown) |
| `Reply.confirm` | Confirm / Cancel buttons, then call `confirm.run()` |
| `Reply.actions` | buttons that run another command with preset args |

### Using the logic directly (scripts / AI tools)

```ts
import { GachaClient, prepareTopup, executeTopup } from './src/index.js';

const client = new GachaClient();
const preview = await prepareTopup(client, {
  slug: 'mobile-legends',
  item: '5 Diamonds',                 // item id or name
  quantity: 1,
  forms: { 'User ID': '87653123', Server: '12472' },   // keyed by label or form id
});
if (!preview.ok) throw new Error(preview.errors.join('\n'));
const { transactionId } = await executeTopup(client, preview);   // spends deposit (unless dry run)
```

## Notes on the API

- Status codes: -2 Refunded, -1 Cancelled, 0 Unpaid, 1 On Process, 2 Completed, 3 On Hold.
- `price` in the order must equal current unit price × quantity, or the API returns 422. The top-up always fetches the live price first.
- The docs don't say what the 401/404 error bodies look like, so errors show the HTTP status plus any `message` field the API returns.
- `openapi.json` is the spec this was built from.
