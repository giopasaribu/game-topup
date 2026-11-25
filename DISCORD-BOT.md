# Discord top-up bot

Each user with the top-up role starts a **session**, runs top-ups, and ends the session. Every top-up is saved in an audit database with who did it, the product, and the real IDR price paid, so you can see who topped up and who owes you.

## Commands

| Command | Who | What it does |
|---|---|---|
| `/start-session` | role | Starts your session. `/topup` is refused without one. |
| `/topup product:136 link:https://pay.gold.razer.com/...` | role | Searches the product, shows a preview, places the order only after you press **Pay**. |
| `/topup-test` (same options) | role | Same checks and preview, but **never sends the order**. Saved as a test. |
| `/session` | role | Your open (or last) session: number of top-ups, total to collect, latest 10. |
| `/end-session` | role | Ends your session and posts its total in the channel. |
| `/audit latest` | role | Your latest top-ups (admins: everyone's, or `user:`). |
| `/audit today [date:2026-11-25]` | admin | Paid totals per user for a day. |
| `/audit export [days:30]` | admin | Downloads all top-ups as a CSV file (Excel / Google Sheets). |
| `/balance` | admin | Merchant deposit balance. |
| `/order id:MTRX...` | owner / admin | Status of a transaction. |
| `/end-session user:@x`, `/session user:@x` | admin | Same, for someone else. |

### `/topup` options

| Option | Required | Notes |
|---|---|---|
| `product` | yes | Part of the product name or price, e.g. `136`, `136000`, `usd 9.99`. Commas, dots and spaces are ignored. While typing, Discord suggests matching products with their IDR price. |
| `link` | if the game needs it | Fills fields whose label contains "link" (RF Online Next: RAZER LINK). |
| `game` | no | Defaults to `DISCORD_DEFAULT_GAME` (rf-online-next). Autocompletes game names. |
| `quantity` | no | Default 1. |
| `user_id`, `server` | if the game needs it | For games that ask for a player ID / server or zone. |
| `extra` | rarely | Any other field: `Label=value; Label 2=value`. |

### How product matching works
- **One match** (e.g. `68`): goes straight to the preview. The footer says it was the only match.
- **Several matches** (e.g. `136` matches both 136,000 and 1,360,000): a pick-list appears first.
- **Picked from Discord's suggestions:** goes straight to the preview.
- **Always:** a preview with game, product, IDR price × quantity, total and the link, then **Pay IDR …** / **Cancel**. Only the person who ran the command can press the buttons, and each Pay button works once, so a double click can't order twice.

After a real order, the bot posts one public line in the channel, without the Razer link:

```
✅ mcb345 topped up RF Online Next · IDR 136000 / Rare Biosuit Step 1/2 ×1 · IDR 95,604
Session #12 total: IDR 382,416 (4 top-ups) · MTRX...
🟢 Status: Completed
```

The status line is updated for up to 10 minutes. Previews and errors are only visible to the person who ran the command.

## Audit data

- **Where:** a single SQLite file, `data/audit.db` (`AUDIT_DB_PATH`). Even at 50 top-ups every day it grows by less than 10 MB a year, so your 60 GB disk is no concern.
- **`sessions` table:** who started it (Discord username and id), start and end time, and whether it was ended by hand or idle.
- **`topups` table:** session, user, time, `mode` (live/test), `status` (placed/failed/test), game, product name, quantity, `unit_price_idr` and `total_idr` (the real price from the API), the fields sent (Razer link), transaction id, latest status and any error.
- **Viewing it:** use `/audit export` for a CSV, or open the `.db` file with DB Browser for SQLite or any SQLite viewer. Any chart tool can read either.
- **Backup:** copy `data/audit.db` now and then (for example `scp` it to your PC), or keep the CSV exports.
- **Session totals** count only real, successful orders. Tests and failed orders are listed separately.
- **Idle sessions** end on their own after `SESSION_IDLE_HOURS` (12) with no activity, and the bot posts the total.

## Setup

### 1. Create the Discord bot
1. Go to discord.com/developers/applications → **New Application** → **Bot** → **Reset Token**, and copy the token into `DISCORD_TOKEN`.
2. Leave every "Privileged Gateway Intent" off. The bot only uses slash commands.
3. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot` and `applications.commands`.
   - Bot permissions: **Send Messages**, **Embed Links** and **Attach Files**.
4. Open the generated link and add the bot to your server.
5. In Discord, turn on Settings → Advanced → **Developer Mode**. Then right-click to copy:
   - the server id → `DISCORD_GUILD_ID`
   - the role allowed to top up → `DISCORD_TOPUP_ROLE_ID` (create a role like "Topup" first)
   - your own user id → `DISCORD_ADMIN_IDS`

### 2. Put it on the VPS (Ubuntu, 1 GB RAM)
```bash
# swap, so npm install never runs out of memory on 1 GB
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Node 22 + PM2
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2

# git, to download the code
sudo apt install -y git
```

#### Get the code onto the VPS with git

The code lives in a **private** GitHub repo. `.env`, `node_modules`, `data/` and `.idea/` are git-ignored, so your secrets and test data are never uploaded.

**Once, on your PC** (PowerShell):
```powershell
cd D:\Workspace\gachagaming
git init
git add .
git status          # check: no .env, node_modules, data/ in the list
git commit -m "GachaGaming top-up CLI and Discord bot"
```
Create an empty **private** repo on github.com named `gachagaming` (no README), then:
```powershell
git branch -M main
git remote add origin https://github.com/<your-github-username>/gachagaming.git
git push -u origin main
```

**Once, on the VPS:** give the server read-only access to that repo with a deploy key:
```bash
ssh-keygen -t ed25519 -C "gacha-vps" -f ~/.ssh/gacha_deploy -N ""
cat ~/.ssh/gacha_deploy.pub
```
Copy the printed line into GitHub → the repo → **Settings → Deploy keys → Add deploy key** (leave "Allow write access" off). Then:
```bash
cat >> ~/.ssh/config <<'CFG'
Host github-gacha
  HostName github.com
  User git
  IdentityFile ~/.ssh/gacha_deploy
CFG
git clone github-gacha:<your-github-username>/gachagaming.git ~/gachagaming   # answer "yes" to the GitHub fingerprint question
```

#### Install and start
```bash
cd ~/gachagaming
npm install
cp .env.example .env && nano .env      # fill GACHA_CLIENT_SECRET and the DISCORD_* values
chmod 600 .env

# first run with orders simulated
GACHA_DRY_RUN=true npm run bot          # wait for "Logged in as ...", try the commands, then Ctrl+C

# run it for real, restart on crash and on reboot
pm2 start npm --name gacha-bot -- run bot
pm2 save && pm2 startup                 # run the command it prints once
```

Useful commands:
- `pm2 logs gacha-bot`: see the bot's output
- `pm2 restart gacha-bot`: after editing `.env` or updating the code
- `pm2 status`: check it's running

Slash commands are registered in your server each time the bot starts, so they show up straight away.

### Updating the bot later
On your PC: `git add .`, `git commit -m "..."` and `git push`. Then on the VPS:
```bash
cd ~/gachagaming
git pull
npm install
pm2 restart gacha-bot
```
`.env` and `data/audit.db` on the VPS are not touched by `git pull`.
