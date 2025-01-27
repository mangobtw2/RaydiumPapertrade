import { createClient } from 'redis';
import { checkRaydium } from '../filter.js';
import fs from 'fs';

// Create or reuse your Redis client
const redisClient = createClient({
  url: 'redis://localhost:6379',
});

export async function init(){
    await redisClient.connect();
}

/**
 * Analyzes all wallets in Redis, returning a sorted list (descending) of 
 * the "best" wallets by a conservative confidence score. 
 * 
 * @param maxWallets number of wallets to retrieve from the top
 * @returns top wallets with stats
 */
export async function analyzeWallets(maxWallets: number = 2000): Promise<WalletPnLStats[]> {
  // 1. Get all wallet keys: "trades:<address>"
  const allKeys = await redisClient.keys('trades:*');
  console.log(`Found ${allKeys.length} wallet keys.`);

  const results: WalletPnLStats[] = [];

  let analyzingIndex = 0;
  for (const key of allKeys) {
    analyzingIndex++;
    if (analyzingIndex % 1000 == 0) {
        console.log(`Analyzing wallet ${analyzingIndex} of ${allKeys.length}`);
    }
    // Extract the wallet address from the key "trades:xyz"
    const address = key.replace('trades:', '');

    // 2. Load all trades
    const rawTrades = await redisClient.lRange(key, 0, -1);

    // 3. Parse and compute PnLs
    const trades: Trade[] = rawTrades.map((row) => JSON.parse(row) as Trade);
    const pnls = computePnLsForWallet(trades);

    // 4. Filter by trade count
    const tradeCount = pnls.length;
    if (tradeCount < 6 || tradeCount > 50) {
      continue; // skip this wallet
    }

    // 5. Compute stats
    const { average, median, standardDeviation } = computeStatistics(pnls);

    // 6. Compute trimmed mean
    const trimmedMean = computeTrimmedMean(pnls);

    // 7. Push into results array
    results.push({
      address,
      tradeCount,
      pnlList: pnls,
      averagePnl: average,
      medianPnl: median,
      standardDev: standardDeviation,
      trimmedMean,
    });
  }

  // 8. Sort by trimmedMean descending
  results.sort((a, b) => b.trimmedMean - a.trimmedMean);

  // 9. Process wallets in parallel batches of 20
  const returnList: WalletPnLStats[] = [];
  const batchSize = 20;

  while (returnList.length < maxWallets && results.length > 0) {
    // Take next batch of wallets to process
    const batch = results.splice(0, batchSize);
    
    // Process batch in parallel
    const batchResults = await Promise.all(
      batch.map(async (wallet) => {
        const rawTrades = await redisClient.lRange(`trades:${wallet.address}`, 0, -1);
        const trades: Trade[] = rawTrades.map((row) => JSON.parse(row) as Trade);
        const isRaydium = await checkRaydium(trades);
        return isRaydium ? wallet : null;
      })
    );

    // Add valid wallets to return list
    const validWallets = batchResults.filter((w): w is WalletPnLStats => w !== null);
    returnList.push(...validWallets);
    console.log(`Added batch results. Current return list size: ${returnList.length}`);

    if (returnList.length >= maxWallets) {
      returnList.length = maxWallets; // Trim to exact size if we went over
      break;
    }
  }

  // 10. Return results
  return returnList;
}


async function getWalletPnlStatsNOUSE(key: string): Promise<WalletPnLStats>{
    // Extract the wallet address from the key "trades:xyz"
    const address = key.replace('trades:', '');

    // 2. Load all trades
    const rawTrades = await redisClient.lRange(key, 0, -1);

    // 3. Parse and compute PnLs
    const trades: Trade[] = rawTrades.map((row) => JSON.parse(row) as Trade);
    const pnls = computePnLsForWallet(trades);

    // 4. Filter by trade count
    const tradeCount = pnls.length;

    // 5. Compute stats
    const { average, median, standardDeviation } = computeStatistics(pnls);

    // 6. Compute confidence-based score
    const trimmedMean = computeTrimmedMean(pnls);

    return {
        address,
        tradeCount,
        pnlList: pnls,
        averagePnl: average,
        medianPnl: median,
        standardDev: standardDeviation,
        trimmedMean,
      }
}


/**
 * Compute basic descriptive statistics (mean, median, std dev).
 */
function computeStatistics(values: number[]): {
    average: number;
    median: number;
    standardDeviation: number;
  } {
    if (values.length === 0) {
      return { average: 0, median: 0, standardDeviation: 0 };
    }
  
    // Mean
    const sum = values.reduce((acc, v) => acc + v, 0);
    const average = sum / values.length;
  
    // Median
    const sorted = [...values].sort((a, b) => a - b);
    let median: number;
    if (sorted.length % 2 === 1) {
      median = sorted[Math.floor(sorted.length / 2)];
    } else {
      const mid = sorted.length / 2;
      median = (sorted[mid - 1] + sorted[mid]) / 2;
    }
  
    // Standard Deviation (sample)
    if (values.length === 1) {
      return { average, median, standardDeviation: 0 };
    }
    const variance =
      values.reduce((acc, v) => acc + Math.pow(v - average, 2), 0) / (values.length - 1);
    const standardDeviation = Math.sqrt(variance);
  
    return { average, median, standardDeviation };
  }

  function computeTrimmedMean(values: number[], trimPercent: number = 0.05): number {
    if(values.length == 0) return 0;
    if(values.length == 1) return values[0];
    const sorted = [...values].sort((a, b) => a - b).map(x => Math.min(x, 2)); //maximum pnl of 2 sol
    const n = values.length;
    const trimCount = Math.floor(n * trimPercent);

    //only trim the top, not the bottom

    //const start = Math.min(trimCount, n - 1);
    const start = 0;
    const end = Math.max(n - trimCount, start);

    const trimmed = sorted.slice(start, end);
    const mean =
      trimmed.reduce((acc, v) => acc + v, 0) / (trimmed.length || 1);
    return mean;
  }



/**
 * Given a list of raw trade objects (each with positionID, amount, etc.),
 * group them by positionID and compute the PnL for each completed position.
 * 
 * Only considers the first position per token mint, ranked by buy timestamp, filters out the rest.
 * 
 * Returns an array of PnLs (one per completed position).
 */
function computePnLsForWallet(trades: Trade[]): number[] {
    // Group trades by positionID
    const positions = new Map<string, { buyFound: boolean; sellAmounts: number[] }>();

    let firstBuyTimestampMap = new Map<string, number>();
    let firstBuyTradeMap = new Map<string, Trade>();

    // filter out the non-first buys for every token mint, ranked by timestamp
    //let filteredTrades = trades.filter((trade) => !trades.some(t => t.mint === trade.mint && t.timestamp < trade.timestamp));
    let filteredTrades: Trade[] = [];
    for(const trade of trades){
        if(trade.amount < 0){
            if(!firstBuyTimestampMap.has(trade.mint)){
                firstBuyTimestampMap.set(trade.mint, trade.timestamp);
                firstBuyTradeMap.set(trade.mint, trade);
            }else{
                if(trade.timestamp < firstBuyTimestampMap.get(trade.mint)!){
                    firstBuyTimestampMap.set(trade.mint, trade.timestamp);
                    firstBuyTradeMap.set(trade.mint, trade);
                }
            }
        }else{
            filteredTrades.push(trade);
        }
    }
    firstBuyTradeMap.forEach((trade) => {
        filteredTrades.push(trade);
    });

    for (const trade of filteredTrades) {
      const { positionID, amount } = trade;
      if (!positions.has(positionID)) {
        positions.set(positionID, { buyFound: false, sellAmounts: [] });
      }
  
      const pos = positions.get(positionID)!;
      if (amount < 0) {
        // This is a buy
        pos.buyFound = true;
      } else {
        // This is a partial sell
        pos.sellAmounts.push(amount);
      }
    }
  
    // Now compute PnLs
    const pnls: number[] = [];
    positions.forEach((posData) => {
      if (posData.buyFound && posData.sellAmounts.length == 3) {
        const totalSells = posData.sellAmounts.reduce((acc, val) => acc + val, 0);
        const pnl = totalSells - 1; // net result of buying for 1 SOL and selling
        pnls.push(pnl);
      }
    });
  
    return pnls;
  }




export interface Trade {
    positionID: string;
    amount: number;      // -1 means "bought for 1 SOL"; positive means partial sells
    timestamp: number;
    mint: string;        // e.g., "3Jy9X..."
  }
  
export interface WalletPnLStats {
    address: string;
    tradeCount: number;             // number of completed buy positions
    pnlList: number[];              // PnL for each completed position
    averagePnl: number;             // mean of pnlList
    medianPnl: number;              // median of pnlList
    standardDev: number;            // sample standard deviation
    trimmedMean: number;            // trimmed mean of pnlList, used for final ranking
  }