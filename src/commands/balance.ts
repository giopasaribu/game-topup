import { formatMoney } from '../topup.js';
import { reply, type Command } from './types.js';

export const balance: Command = {
  name: 'balance',
  label: 'Check balance',
  description: 'Show your merchant deposit balance',
  options: [],
  async run({ client }) {
    const deposit = await client.getBalance();
    return reply.ok('Balance', `Deposit balance: **${formatMoney(deposit)}**`, { data: { deposit } });
  },
};
