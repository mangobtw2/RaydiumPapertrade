import { createClient } from 'redis';
import fs from 'fs';
// Create or reuse your Redis client
const redisClient = createClient({
  url: 'redis://localhost:6379',
});

export async function init(){
    await redisClient.connect();
}

export async function compressAllWallets(removeOld: boolean = false){
    const wallets = await redisClient.keys('trades:*');
    for(const wallet of wallets){
        await compressWallet(wallet, removeOld);
    }
}

export async function compressWallet(wallet: string, removeOld: boolean = false){
    try{
        const oldKey = `trades:${wallet}`;
        const newKey = `rt:${wallet}`;
        const rawTrades = await redisClient.lRange(oldKey, 0, -1);
        const trades: TradeOld[] = rawTrades.map(row => JSON.parse(row));
        // Group trades by positionID
        
        const positions = new Map<string, { buyTimestamp: number; sellAmounts: number[]; mint: string }>();

        for (const trade of trades) {
            if (!positions.has(trade.positionID)) {
                positions.set(trade.positionID, {
                    buyTimestamp: 0,
                    sellAmounts: [],
                    mint: trade.mint.substring(0, 10)
                });
            }

            const pos = positions.get(trade.positionID)!;
            if (trade.amount < 0) {
                // Buy trade
                pos.buyTimestamp = trade.timestamp;
            } else {
                // Sell trade
                pos.sellAmounts.push(trade.amount);
            }
        }

        // Calculate PnLs and assign to intervals
        positions.forEach(async (pos) => {
            if (pos.sellAmounts.length === 3) {
                const totalSell = pos.sellAmounts.reduce((sum, amount) => sum + amount, 0);
                const pnl = parseFloat((totalSell - 1).toFixed(4)); // Round to max 4 decimals, remove trailing zeros
                const trade: CompressedTrade = {
                    pl: pnl,
                    t: pos.buyTimestamp,
                    m: pos.mint
                }
                await redisClient.lPush(newKey, JSON.stringify(trade));
            }
        });

        if(removeOld){
            await redisClient.del(oldKey);
        }

        console.log(`Compressed ${wallet} trades`);
    }catch(error){
        console.error(`Error compressing wallet ${wallet}: ${error}`);
    }
}



interface TradeOld {
    positionID: string;
    amount: number;      // -1 means "bought for 1 SOL"; positive means partial sells
    timestamp: number;
    mint: string;        // e.g., "3Jy9X..."
  }

interface CompressedTrade {
    pl: number; //Pnl
    t: number; //timestamp
    m: string; //first 10 chars of mint
}