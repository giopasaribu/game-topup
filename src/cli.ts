// Terminal front end: numbered menu + typed answers.
// It only READS the command definitions in src/commands, so a Discord bot can reuse them as-is.
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { GachaClient } from './client.js';
import {
  commands,
  errorReply,
  findCommand,
  getFields,
  runCommand,
  runSafely,
  type Args,
  type Choice,
  type Command,
  type Ctx,
  type FieldDef,
  type OptionDef,
  type Reply,
} from './commands/index.js';

/** How many choices the terminal lists at once (Discord is limited to 25). */
const CLI_LIMIT = 50;

/** Thrown when the user types "back" (or 0 in a list) to return to the main menu. */
class Back extends Error {}

const rl = readline.createInterface({ input: stdin, output: stdout });
rl.on('SIGINT', () => bye());
rl.on('close', () => bye());

function bye(): never {
  console.log('\nBye.');
  process.exit(0);
}

async function ask(question: string): Promise<string> {
  const answer = (await rl.question(question)).trim();
  if (answer.toLowerCase() === 'back') throw new Back();
  return answer;
}

// ---------- Main menu ----------

async function main(): Promise<void> {
  let client: GachaClient;
  try {
    client = new GachaClient();
  } catch (e) {
    console.error(`\n${(e as Error).message}\n`);
    process.exit(1);
  }
  const ctx: Ctx = { client };

  console.log('\n=========================================');
  console.log('   GachaGaming Top-up');
  if (client.dryRun) console.log('   DRY RUN: orders are only simulated');
  console.log('=========================================');

  // Shortcut: `npm run quick` (= cli.ts quick) skips the menu and runs one command directly.
  const direct = process.argv[2];
  if (direct) {
    const cmd = findCommand(direct);
    if (!cmd) {
      console.error(`Unknown command "${direct}". Available: ${commands.map((c) => c.name).join(', ')}`);
      process.exit(1);
    }
    console.log("Type 'back' at any question to stop.");
    try {
      await execute(ctx, cmd);
    } catch (e) {
      if (!(e instanceof Back)) show(errorReply(e));
    }
    bye();
  }

  console.log("Tip: type 'back' at any question to return to this menu.");

  for (;;) {
    console.log('\nMain menu');
    commands.forEach((c, i) => console.log(`  ${i + 1}. ${c.label}`));
    console.log('  0. Exit');

    const answer = (await rl.question(`\nChoose 0-${commands.length}: `)).trim().toLowerCase();
    if (answer === '0' || answer === 'exit' || answer === 'q') bye();

    const cmd = commands[Number(answer) - 1];
    if (!/^\d+$/.test(answer) || !cmd) {
      console.log(`  Please type a number from 0 to ${commands.length}.`);
      continue;
    }

    try {
      await execute(ctx, cmd);
    } catch (e) {
      if (e instanceof Back) console.log('  Back to the menu.');
      else show(errorReply(e));
    }
  }
}

// ---------- Running a command ----------

async function execute(ctx: Ctx, cmd: Command, preset: Args = {}): Promise<void> {
  console.log(`\n--- ${cmd.label} ---`);

  const args: Args = { ...preset };
  for (const opt of cmd.options) {
    if (args[opt.name] === undefined) args[opt.name] = await askOption(ctx, opt, args);
  }

  const fieldDefs = await getFields(ctx, cmd, args);
  if (!Array.isArray(fieldDefs)) return handle(ctx, fieldDefs);
  const fields = await askFields(fieldDefs);

  console.log('  Working...');
  await handle(ctx, await runCommand(ctx, cmd, args, fields));
}

/** Shows a reply, then its confirm question or follow-up actions. */
async function handle(ctx: Ctx, r: Reply): Promise<void> {
  show(r);

  if (r.confirm) {
    const answer = await ask(`\n  ${r.confirm.question} (y/N): `);
    if (/^y(es)?$/i.test(answer)) {
      console.log('  Working...');
      return handle(ctx, await runSafely(r.confirm.run));
    }
    console.log('  Cancelled. Nothing was ordered.');
    return;
  }

  if (r.followUp) {
    const cmd = findCommand(r.followUp.command);
    if (cmd) {
      console.log(`\n  ${r.followUp.label} (type 'back' to stop)`);
      return execute(ctx, cmd, r.followUp.args);
    }
  }

  if (r.actions?.length) {
    console.log('\n  What next?');
    r.actions.forEach((a, i) => console.log(`    ${i + 1}. ${a.label}`));
    console.log('    Enter. Back to the menu');
    const answer = await ask('  Choose: ');
    const action = r.actions[Number(answer) - 1];
    const cmd = action && findCommand(action.command);
    if (cmd) await execute(ctx, cmd, action.args);
  }
}

// ---------- Asking for input ----------

async function askOption(ctx: Ctx, opt: OptionDef, args: Args): Promise<string | number | undefined> {
  if (opt.choices) return askChoice(ctx, opt, args);

  const hint = opt.default !== undefined ? ` [${opt.default}]` : opt.required ? '' : ' (Enter = skip)';
  for (;;) {
    const answer = await ask(`  ${opt.description}${hint}: `);
    if (!answer) {
      if (opt.default !== undefined) return opt.default;
      if (!opt.required) return undefined;
      console.log('  This one is required.');
      continue;
    }
    if (opt.type === 'integer') {
      const n = Number(answer);
      if (!Number.isInteger(n) || (opt.min !== undefined && n < opt.min)) {
        console.log(`  Please type a whole number${opt.min !== undefined ? ` of at least ${opt.min}` : ''}.`);
        continue;
      }
      return n;
    }
    return answer;
  }
}

async function askChoice(ctx: Ctx, opt: OptionDef, args: Args): Promise<string> {
  for (;;) {
    const query = opt.search ? await ask(`  ${opt.description} (Enter = show all): `) : '';
    const choices = await opt.choices!(ctx, args, query, CLI_LIMIT);

    if (!choices.length) {
      console.log(query ? `  Nothing matches "${query}". Try another word.` : `  Nothing to choose from. ${opt.name === 'preset' ? 'Add a preset to presets.json first.' : ''}`);
      if (!opt.search) throw new Back();
      continue;
    }
    if (choices.length === 1 && (query || !opt.search)) {
      console.log(`  -> ${choices[0].name}`);
      return choices[0].value;
    }
    if (choices.length === CLI_LIMIT) console.log(`  (showing the first ${CLI_LIMIT}, type more of the name to narrow it down)`);

    const picked = await pickFromList(choices, opt.search);
    if (picked !== null) return picked;
  }
}

/** Numbered list. Returns the chosen value, or null when the user wants to search again. */
async function pickFromList(choices: Choice[], canSearchAgain = false): Promise<string | null> {
  choices.forEach((c, i) => console.log(`    ${String(i + 1).padStart(2)}. ${c.name}`));
  const extra = canSearchAgain ? ', s = search again' : '';
  for (;;) {
    const answer = (await ask(`  Choose 1-${choices.length} (0 = back${extra}): `)).toLowerCase();
    if (answer === '0') throw new Back();
    if (canSearchAgain && answer === 's') return null;
    const choice = choices[Number(answer) - 1];
    if (/^\d+$/.test(answer) && choice) return choice.value;
    console.log(`  Please type a number from 1 to ${choices.length}.`);
  }
}

async function askFields(defs: FieldDef[]): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const f of defs) {
    if (f.kind === 'select' && f.options?.length) {
      console.log(`  ${f.label}:`);
      values[f.key] = (await pickFromList(f.options))!;
      continue;
    }
    for (;;) {
      const answer = await ask(`  ${f.label}${f.required ? '' : ' (Enter = skip)'}: `);
      if (!answer && f.required) {
        console.log(`  ${f.label} is required.`);
        continue;
      }
      if (answer && f.kind === 'number' && !/^\d+$/.test(answer)) {
        console.log(`  ${f.label} must be digits only.`);
        continue;
      }
      if (answer) values[f.key] = answer;
      break;
    }
  }
  return values;
}

// ---------- Output ----------

function show(r: Reply): void {
  console.log(`\n=== ${r.ok ? '' : 'ERROR: '}${r.title} ===`);
  console.log(
    toPlainText(r.body)
      .split('\n')
      .map((line) => '  ' + line)
      .join('\n'),
  );
}

/** Removes the Discord markdown so it reads cleanly in a terminal. */
function toPlainText(md: string): string {
  return md
    .split('\n')
    .filter((line) => !/^```\w*$/.test(line.trim()))
    .join('\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

main();
