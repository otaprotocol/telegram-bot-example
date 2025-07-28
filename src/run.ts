import { VercelRequest, VercelResponse } from '@vercel/node';
import { Context, Telegraf } from 'telegraf';
import { Update } from 'telegraf/types';

const PORT = (process.env.PORT && parseInt(process.env.PORT, 10)) || 3000;
const VERCEL_URL = `${process.env.VERCEL_URL}`;

const run = async (
    req: VercelRequest,
    res: VercelResponse,
    bot: Telegraf<Context<Update>>,
) => {
    console.log('Bot runs in production mode');
    console.log(`setting webhook: ${VERCEL_URL}`);

    if (!VERCEL_URL) {
        throw new Error('VERCEL_URL is not set.');
    }

    const getWebhookInfo = await bot.telegram.getWebhookInfo();
    if (getWebhookInfo.url !== VERCEL_URL + '/api') {
        console.log(`deleting webhook ${VERCEL_URL}`);
        await bot.telegram.deleteWebhook();
        console.log(`setting webhook: ${VERCEL_URL}/api`);
        await bot.telegram.setWebhook(`${VERCEL_URL}/api`);
    }

    if (req.method === 'POST') {
        await bot.handleUpdate(req.body as unknown as Update, res);
    } else {
        res.status(200).json('Listening to bot events...');
    }
    console.log(`starting webhook on port: ${PORT}`);
};
export { run };