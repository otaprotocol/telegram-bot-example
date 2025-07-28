import { config } from 'dotenv';
config(); // Load environment variables from .env file

import { ActionCodesClient, ActionCodeStatusResponse } from '@actioncodes/sdk'
import { Telegraf } from 'telegraf';

const client = new ActionCodesClient();

export const bot = new Telegraf(process.env.BOT_TOKEN!);

// Store user states for multi-step interactions
const userStates = new Map<number, {
    step: 'waiting_for_message' | 'waiting_for_code' | 'processing' | 'waiting_for_transfer_params';
    message?: string;
    code?: string;
    transferParams?: {
        token: string;
        to: string;
        amount: number;
    };
}>();

bot.start((ctx) => {
    ctx.reply('Welcome! This bot is an example of how to use Action Codes with Telegram')
})

bot.command('message', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Initialize user state
    userStates.set(userId, { step: 'waiting_for_message' });
    
    ctx.reply('Please enter a message to sign with Action Codes:');
});

bot.command('transfer', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Initialize user state for transfer
    userStates.set(userId, { step: 'waiting_for_transfer_params' });
    
    ctx.reply('Please enter transfer parameters in this format:\n\n<token> <to_address> <amount>\n\nExample: USDC 6tBUD4bQzNehG3hQVtVFaGxre2P8rQoH99pubRtgSbSb 100');
});

// Handle text messages for multi-step flow
bot.on('text', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const userState = userStates.get(userId);
    if (!userState) return;

    const text = ctx.message.text;

    if (userState.step === 'waiting_for_message') {
        // Store the message and ask for action code
        userState.message = text;
        userState.step = 'waiting_for_code';
        
        ctx.reply('Please enter the 8-digit one-time action code:\n\nVisit actioncode.app to get a one-time code and submit it here.');
        
    } else if (userState.step === 'waiting_for_transfer_params') {
        // Parse transfer parameters
        const parts = text.trim().split(' ');
        if (parts.length !== 3) {
            return ctx.reply('❌ Invalid format. Please use: <token> <to_address> <amount>\n\nExample: USDC 6tBUD4bQzNehG3hQVtVFaGxre2P8rQoH99pubRtgSbSb 100');
        }

        const [token, toAddress, amountStr] = parts;
        const amount = parseFloat(amountStr);

        console.log('Parsed amount:', amount);

        if (isNaN(amount) || amount <= 0) {
            return ctx.reply('❌ Invalid amount. Please enter a valid positive number.');
        }

        console.log('Parsed transfer parameters:', { token, toAddress, amount });

        userState.transferParams = { token, to: toAddress, amount };
        userState.step = 'waiting_for_code';

        ctx.reply(`Transfer Parameters:\nToken: ${token}\nTo: ${toAddress}\nAmount: ${amount}\n\nPlease enter the 8-digit one-time action code:\n\nVisit actioncode.app to get a one-time code and submit it here.`);
        
    } else if (userState.step === 'waiting_for_code') {
        // Validate and process the action code
        const code = text.trim();
        
        // Basic validation for 8-digit code
        if (!/^\d{8}$/.test(code)) {
            return ctx.reply('Please enter a valid 8-digit action code.');
        }

        userState.code = code;
        userState.step = 'processing';

        // Show processing message
        const processingMsg = await ctx.reply('⏳ Processing... Please confirm the action on actioncode.app');

        try {
            if (userState.transferParams) {
                // Handle transfer flow
                await handleTransferFlow(ctx, userState, processingMsg);
            } else {
                // Handle message signing flow
                await handleMessageFlow(ctx, userState, processingMsg);
            }
        } catch (error) {
            console.error('Error processing action code:', error);
            await ctx.reply('❌ Error processing the action code. Please make sure the code is valid and try again.');
        }

        // Clean up user state
        userStates.delete(userId);
    }
});

async function handleTransferFlow(ctx: any, userState: any, processingMsg: any) {
    try {
        // First resolve the action code to get the user's account
        const actionCode = await client.resolve(userState.code!);
        const userAccount = actionCode.pubkey;

        console.log('Resolved action code:', {
            code: userState.code,
            userAccount: userAccount
        });

        // Generate transfer transaction using Dialect API
        const { token, to, amount } = userState.transferParams!;
        
        console.log('Transfer parameters for API call:', { token, to, amount });
        
        const requestBody = {
            type: 'transaction',
            account: userAccount
        };

        const url = `https://solana-sbl.dial.to/api/v0/transfer/${token}?to=${to}&amount=${amount}`;
        
        console.log('Dialect API request:', {
            url: url,
            method: 'POST',
            body: requestBody
        });

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody)
        });

        console.log('Dialect API response status:', response.status);
        console.log('Dialect API response status text:', response.statusText);

        if (!response.ok) {
            // Try to get the error response body
            const errorText = await response.text();
            console.log('Dialect API error response:', errorText);
            
            // If it's a 500 error, try with a different token or smaller amount
            if (response.status === 500) {
                console.log('Trying with different token...');
                
                // Try with SOL instead of USDC
                const alternativeToken = token === 'USDC' ? 'SOL' : 'USDC';
                const alternativeUrl = `https://solana-sbl.dial.to/api/v0/transfer/${alternativeToken}?to=${to}&amount=${amount}`;
                
                console.log('Trying alternative token:', alternativeToken);
                const alternativeResponse = await fetch(alternativeUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(requestBody)
                });
                
                if (alternativeResponse.ok) {
                    const alternativeData = await alternativeResponse.json() as { type: string; transaction: string };
                    console.log('Dialect API alternative token success response:', alternativeData);
                    
                    const transaction = alternativeData.transaction;
                    if (!transaction) {
                        throw new Error('No transaction received from Dialect API alternative token');
                    }

                    // Attach the transaction to the action code
                    await client.attachTransaction(userState.code!, transaction);
                    
                    // Update status message
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        processingMsg.message_id,
                        undefined,
                        `⏳ Pending/Waiting for transaction signature...\n\nToken changed to ${alternativeToken} due to API limitations.\n\nPlease complete the action on actioncode.app`
                    );

                    // Start observing the status
                    let finalStatus: ActionCodeStatusResponse | null = null;
                    for await (const status of client.observeStatus(userState.code!, { 
                        interval: 2000, // Check every 2 seconds
                        timeout: 120000 // Timeout after 2 minutes
                    })) {
                        console.log('Status update:', status);
                        
                        if (status.status === 'finalized' && status.finalizedSignature) {
                            finalStatus = status;
                            break;
                        } else if (status.status === 'expired') {
                            await ctx.reply('❌ Action code has expired. Please try again with a new code.');
                            return;
                        } else if (status.status === 'error') {
                            await ctx.reply('❌ Error processing the action code. Please make sure the code is valid and try again.')
                            return;
                        }
                    }

                    if (finalStatus && finalStatus.finalizedSignature) {
                        await ctx.reply(`✅ Transfer transaction signed successfully!\n\nTransaction Signature: ${finalStatus.finalizedSignature}\n\nNote: Token was changed to ${alternativeToken} due to API limitations.`);
                    } else {
                        await ctx.reply('❌ Failed to get transaction signature. Please try again.');
                    }
                    
                    return;
                } else {
                    const alternativeErrorText = await alternativeResponse.text();
                    console.log('Dialect API alternative token error response:', alternativeErrorText);
                    
                    // If alternative token also fails, try with a smaller amount
                    if (amount > 0.1) {
                        console.log('Trying with smaller amount...');
                        const smallerAmount = Math.max(0.1, amount / 10);
                        
                        const retryUrl = `https://solana-sbl.dial.to/api/v0/transfer/${token}?to=${to}&amount=${smallerAmount}`;
                        const retryResponse = await fetch(retryUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify(requestBody)
                        });
                        
                        if (retryResponse.ok) {
                            const retryData = await retryResponse.json() as { type: string; transaction: string };
                            console.log('Dialect API retry success response:', retryData);
                            
                            const transaction = retryData.transaction;
                            if (!transaction) {
                                throw new Error('No transaction received from Dialect API retry');
                            }

                            // Attach the transaction to the action code
                            await client.attachTransaction(userState.code!, transaction);
                            
                            // Update status message
                            await ctx.telegram.editMessageText(
                                ctx.chat.id,
                                processingMsg.message_id,
                                undefined,
                                `⏳ Pending/Waiting for transaction signature...\n\nAmount adjusted to ${smallerAmount} ${token} due to API limitations.\n\nPlease complete the action on actioncode.app`
                            );

                            // Start observing the status
                            let finalStatus: ActionCodeStatusResponse | null = null;
                            for await (const status of client.observeStatus(userState.code!, { 
                                interval: 2000, // Check every 2 seconds
                                timeout: 120000 // Timeout after 2 minutes
                            })) {
                                console.log('Status update:', status);
                                
                                if (status.status === 'finalized' && status.finalizedSignature) {
                                    finalStatus = status;
                                    break;
                                } else if (status.status === 'expired') {
                                    await ctx.reply('❌ Action code has expired. Please try again with a new code.');
                                    return;
                                } else if (status.status === 'error') {
                                    await ctx.reply('❌ Error processing the action code. Please make sure the code is valid and try again.')
                                    return;
                                }
                            }

                            if (finalStatus && finalStatus.finalizedSignature) {
                                await ctx.reply(`✅ Transfer transaction signed successfully!\n\nTransaction Signature: ${finalStatus.finalizedSignature}\n\nNote: Amount was adjusted to ${smallerAmount} ${token} due to API limitations.`);
                            } else {
                                await ctx.reply('❌ Failed to get transaction signature. Please try again.');
                            }
                            
                            return;
                        } else {
                            const retryErrorText = await retryResponse.text();
                            console.log('Dialect API retry error response:', retryErrorText);
                        }
                    }
                }
            }
            
            throw new Error(`Dialect API error: ${response.statusText} - ${errorText}`);
        }

        const data = await response.json() as { type: string; transaction: string };
        console.log('Dialect API success response:', data);
        
        const transaction = data.transaction;

        if (!transaction) {
            throw new Error('No transaction received from Dialect API');
        }

        // Attach the transaction to the action code
        await client.attachTransaction(userState.code!, transaction);
        
        // Update status message
        await ctx.telegram.editMessageText(
            ctx.chat.id,
            processingMsg.message_id,
            undefined,
            '⏳ Pending/Waiting for transaction signature...\n\nPlease complete the action on actioncode.app'
        );

        // Start observing the status
        let finalStatus: ActionCodeStatusResponse | null = null;
        for await (const status of client.observeStatus(userState.code!, { 
            interval: 2000, // Check every 2 seconds
            timeout: 120000 // Timeout after 2 minutes
        })) {
            console.log('Status update:', status);
            
            if (status.status === 'finalized' && status.finalizedSignature) {
                finalStatus = status;
                break;
            } else if (status.status === 'expired') {
                await ctx.reply('❌ Action code has expired. Please try again with a new code.');
                return;
            } else if (status.status === 'error') {
                await ctx.reply('❌ Error processing the action code. Please make sure the code is valid and try again.')
                return;
            }
        }

        if (finalStatus && finalStatus.finalizedSignature) {
            await ctx.reply(`✅ Transfer transaction signed successfully!\n\nTransaction Signature: ${finalStatus.finalizedSignature}`);
        } else {
            await ctx.reply('❌ Failed to get transaction signature. Please try again.');
        }

    } catch (error) {
        console.error('Error in transfer flow:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        await ctx.reply(`❌ Error processing transfer: ${errorMessage}`);
    }
}

async function handleMessageFlow(ctx: any, userState: any, processingMsg: any) {
    // Attach the message to the action code
    await client.attachMessage(userState.code!, userState.message!);
    
    // Update status message
    await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        '⏳ Pending/Waiting for action completion...\n\nPlease complete the action on actioncode.app'
    );

    // Start observing the status
    let finalStatus: ActionCodeStatusResponse | null = null;
    for await (const status of client.observeStatus(userState.code!, { 
        interval: 2000, // Check every 2 seconds
        timeout: 120000 // Timeout after 2 minutes
    })) {
        console.log('Status update:', status);
        
        if (status.status === 'finalized' && status.signedMessage) {
            finalStatus = status;
            break;
        } else if (status.status === 'expired') {
            await ctx.reply('❌ Action code has expired. Please try again with a new code.');
            return;
        } else if (status.status === 'error') {
            await ctx.reply('❌ Error processing the action code. Please make sure the code is valid and try again.')
            return;
        }
    }

    if (finalStatus && finalStatus.signedMessage) {
        await ctx.reply(`✅ Message signed successfully!\n\nSigned Message: ${finalStatus.signedMessage}`);
    } else {
        await ctx.reply('❌ Failed to get signed message. Please try again.');
    }
}
