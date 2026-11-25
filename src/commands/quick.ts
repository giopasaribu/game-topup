// Repeat top-up from a saved preset (presets.json). The game and item are fixed; only the
// fields not saved in the preset (e.g. the Razer link) are asked for each order.
// After a confirmed order it goes straight to the next one ("followUp"), until you type 'back'.
import { formatMoney, prepareTopup } from '../topup.js';
import { loadPresets, pinPreset, presetsPath, resolvePreset, type Preset } from '../presets.js';
import { MAX_CHOICES } from './shared.js';
import { formToField, previewReply } from './topup.js';
import { type Args, type Command } from './types.js';

function getPreset(args: Args): { presets: Preset[]; preset: Preset; index: number } {
  const presets = loadPresets();
  const index = Number(args.preset);
  const preset = presets[index];
  if (!preset) throw new Error(`Preset not found. Check ${presetsPath()}.`);
  return { presets, preset, index };
}

function savedKeys(preset: Preset): Set<string> {
  return new Set(Object.keys(preset.fields ?? {}).map((k) => k.toLowerCase()));
}

export const quick: Command = {
  name: 'quick',
  label: 'Quick top-up (saved preset)',
  description: 'Top up a saved game + item; only asks what changes per order',
  options: [
    {
      name: 'preset',
      description: 'Which preset',
      type: 'string',
      required: true,
      choices: async (_ctx, _args, query, limit = MAX_CHOICES) =>
        loadPresets()
          .map((p, i) => ({ name: p.label, value: String(i) }))
          .filter((c) => !query || c.name.toLowerCase().includes(query.toLowerCase()))
          .slice(0, limit),
    },
  ],

  // Ask only for what is not fixed in the preset (for RF Online: the Razer link).
  async fields({ client }, args) {
    const { preset } = getPreset(args);
    const { product } = await resolvePreset(client, preset);
    const saved = savedKeys(preset);
    return product.forms.filter((f) => !saved.has(f.label.toLowerCase()) && !saved.has(f.id)).map(formToField);
  },

  async run(ctx, args, fields) {
    const { presets, preset, index } = getPreset(args);
    const { product, item, pinned } = await resolvePreset(ctx.client, preset);

    const preview = await prepareTopup(ctx.client, {
      slug: product.slug,
      item: item.id,
      quantity: preset.quantity ?? 1,
      forms: { ...(preset.fields ?? {}), ...fields },
    });

    const extraErrors =
      preset.maxPrice !== undefined && preview.total > preset.maxPrice
        ? [
            `Total ${formatMoney(preview.total)} is above your limit of ${formatMoney(preset.maxPrice)} ("maxPrice" in presets.json). The price may have changed.`,
          ]
        : [];
    const notes = pinned ? [] : [`First order: item id \`${item.id}\` will be saved as the default once you confirm.`];

    const r = previewReply(ctx, preview, extraErrors, notes);

    // After a successful order: pin the item (first time only) and go straight to the next order.
    if (r.confirm) {
      const placeOrder = r.confirm.run;
      r.confirm.run = async () => {
        const result = await placeOrder();
        if (result.ok) {
          if (!pinned) {
            pinPreset(presets, index, product, item);
            result.body += `\nSaved as default: ${item.name} (id \`${item.id}\`)`;
          }
          result.followUp = { label: 'Next order', command: 'quick', args: { preset: String(index) } };
        }
        return result;
      };
    }
    return r;
  },
};
