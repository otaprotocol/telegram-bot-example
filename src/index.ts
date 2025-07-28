import { VercelRequest, VercelResponse } from '@vercel/node';
import { run } from './run';
import { bot } from './bot';

export const startVercel = async (req: VercelRequest, res: VercelResponse) => {
    await run(req, res, bot);
};