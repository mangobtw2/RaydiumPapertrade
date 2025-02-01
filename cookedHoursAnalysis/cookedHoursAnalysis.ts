import { createClient } from 'redis';
import fs from 'fs';
import { Trade } from '../analysis/analysis.js';
// Create or reuse your Redis client
const redisClient = createClient({
  url: 'redis://localhost:6379',
});

export async function init(){
    await redisClient.connect();
}

interface IntervalPnL {
    startTimestamp: number;  // Start of 5-min interval
    endTimestamp: number;    // End of 5-min interval
    totalPnL: number;       // Sum of all PnLs from trades initiated in this interval
    tradeCount: number;     // Number of completed trades initiated in this interval
}

export async function getTotalPnls(startTimestamp: number): Promise<void> {
    // Round up startTimestamp to next 5-minute interval
    const FIVE_MINUTES = 5 * 60 * 1000;
    startTimestamp = Math.ceil(startTimestamp / FIVE_MINUTES) * FIVE_MINUTES;
    
    // Get all wallet keys
    const allKeys = await redisClient.keys('trades:*');
    console.log(`Found ${allKeys.length} wallet keys`);

    // Initialize intervals map
    const intervalPnLs = new Map<number, IntervalPnL>();

    // Process each wallet
    for (let i = 0; i < allKeys.length; i++) {
        if (i % 1000 === 0) {
            console.log(`Processing wallet ${i} of ${allKeys.length}`);
        }

        const rawTrades = await redisClient.lRange(allKeys[i], 0, -1);
        const trades: Trade[] = rawTrades.map(row => JSON.parse(row));

        // Group trades by positionID
        const positions = new Map<string, {
            buyTimestamp: number;
            sellAmounts: number[];
        }>();

        // Process trades
        for (const trade of trades) {
            if (!positions.has(trade.positionID)) {
                positions.set(trade.positionID, {
                    buyTimestamp: 0,
                    sellAmounts: []
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
        positions.forEach((pos) => {
            if (pos.buyTimestamp >= startTimestamp && pos.sellAmounts.length === 3) {
                const intervalStart = Math.floor(pos.buyTimestamp / FIVE_MINUTES) * FIVE_MINUTES;
                const totalSell = pos.sellAmounts.reduce((sum, amount) => sum + amount, 0);
                const pnl = totalSell - 1; // -1 because we bought for 1 SOL

                if (!intervalPnLs.has(intervalStart)) {
                    intervalPnLs.set(intervalStart, {
                        startTimestamp: intervalStart,
                        endTimestamp: intervalStart + FIVE_MINUTES,
                        totalPnL: 0,
                        tradeCount: 0
                    });
                }

                const interval = intervalPnLs.get(intervalStart)!;
                interval.totalPnL += pnl;
                interval.tradeCount++;
            }
        });
    }

    // Convert map to sorted array
    const results = Array.from(intervalPnLs.values())
        .sort((a, b) => a.startTimestamp - b.startTimestamp);

    // Save to file
    fs.writeFileSync(
        "cookedHoursAnalysis/interval_pnls.json", 
        JSON.stringify(results, null, 2)
    );

    console.log(`Analysis complete. Processed ${results.length} intervals.`);
}

