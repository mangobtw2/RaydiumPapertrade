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

export interface Trade {
  positionID: string;
  amount: number;      // -1 means "bought for 1 SOL"; positive means partial sells
  timestamp: number;
  mint: string;        // e.g., "3Jy9X..."
}

export interface WalletPnLStats {
  address: string;
  tradeCount: number;     // number of completed buy positions
  pnlList: number[];      // PnL for each completed position
  averagePnl: number;     // mean of pnlList
  medianPnl: number;      // median of pnlList
  standardDev: number;    // sample standard deviation
  confidenceScore: number; // here, it will be the Bayesian "score"
}

/**
 * Main analysis function, returning top wallets sorted by a Bayesian-based
 * "confidence score."
 */
export async function analyzeWallets(maxWallets: number = 2000): Promise<WalletPnLStats[]> {
  // 1. Get all wallet keys: "trades:<address>"
  const allKeys = await redisClient.keys('trades:*');
  console.log(`Found ${allKeys.length} wallet keys.`);

  const results: WalletPnLStats[] = [];

  let analyzingIndex = 0;
  for (const key of allKeys) {
    analyzingIndex++;
    if (analyzingIndex % 1000 === 0) {
      console.log(`Analyzing wallet ${analyzingIndex} of ${allKeys.length}`);
    }
    // Extract the wallet address from the key "trades:xyz"
    const address = key.replace('trades:', '');

    // 2. Load all trades
    const rawTrades = await redisClient.lRange(key, 0, -1);
    const trades: Trade[] = rawTrades.map((row) => JSON.parse(row) as Trade);

    // 3. Compute PnLs
    const pnls = computePnLsForWallet(trades);

    // 4. Filter by trade count
    const tradeCount = pnls.length;
    if (tradeCount < 6 || tradeCount > 50) {
      continue; // skip this wallet
    }

    // (Optional) CAP the PnLs to reduce outlier impact, e.g. at +2
    const cappedPnls = pnls.map((pnl) => Math.max(-1, Math.min(pnl, 2)));

    // 5. Compute simple stats (for reference)
    const { average, median, standardDeviation } = computeStatistics(cappedPnls);

    // 5.5 Compute the prior parameters
    const { priorMean, priorVar } = await estimateParameters();

    // 6. Compute Bayesian-based score
    const bayesScore = computeBayesianScore(cappedPnls, {
      priorMean: 0,    // \mu_0
      priorVar: 0.25,  // \tau^2 = 0.25 => std dev = 0.5
      z: 1.645         // for a ~90% one-sided
    });

    // 7. Push into results
    results.push({
      address,
      tradeCount,
      pnlList: pnls, // store original PnLs if you like
      averagePnl: average,
      medianPnl: median,
      standardDev: standardDeviation,
      confidenceScore: bayesScore, // the posterior-based ranking metric
    });
  }

  // 8. Sort by Bayesian-based confidence score descending
  results.sort((a, b) => b.confidenceScore - a.confidenceScore);

  // 9. Filter wallets with checkRaydium in parallel, until we get `maxWallets`
  const returnList: WalletPnLStats[] = [];
  const batchSize = 20;

  while (returnList.length < maxWallets && results.length > 0) {
    const batch = results.splice(0, batchSize);

    const batchResults = await Promise.all(
      batch.map(async (wallet) => {
        // Reload trades just to pass to checkRaydium
        // (Alternatively, store them earlier)
        const rawTrades = await redisClient.lRange(`trades:${wallet.address}`, 0, -1);
        const trades: Trade[] = rawTrades.map((row) => JSON.parse(row) as Trade);
        const isRaydium = await checkRaydium(trades);
        return isRaydium ? wallet : null;
      })
    );

    const validWallets = batchResults.filter((w): w is WalletPnLStats => w !== null);
    returnList.push(...validWallets);
    console.log(`Added batch results. Current return list size: ${returnList.length}`);

    if (returnList.length >= maxWallets) {
      returnList.length = maxWallets; // Trim to exact size if we went over
      break;
    }
  }

  return returnList;
}

/**
 * Gathers up to 100k wallets, computes each wallet's average (capped) PnL,
 * and estimates the mean & variance across that sample.
 * 
 * @returns { priorMean, priorVar } suitable for use as a data-driven prior.
 */
export async function estimateParameters(): Promise<{ priorMean: number; priorVar: number }> {
    // 1. Get all wallet keys
    let allKeys = await redisClient.keys('trades:*');
    console.log(`Total keys found: ${allKeys.length}`);
    
    // 2. Take first 100k (or fewer if less are available)
    if (allKeys.length > 100000) {
      allKeys = allKeys.slice(0, 100000);
    }
    console.log(`Using ${allKeys.length} wallets for parameter estimation.`);
  
    const walletAverages: number[] = [];
  
    let processedCount = 0;
    for (const key of allKeys) {
      processedCount++;
      if (processedCount % 5000 === 0) {
        console.log(`Processed ${processedCount} of ${allKeys.length}`);
      }
  
      // Load trades
      const rawTrades = await redisClient.lRange(key, 0, -1);
      const trades: Trade[] = rawTrades.map((row) => JSON.parse(row) as Trade);
  
      // Compute PnLs for wallet
      const pnls = computePnLsForWallet(trades);
  
      // Filter by trade count
      const tradeCount = pnls.length;
      if (tradeCount < 6 || tradeCount > 50) {
        continue; // skip
      }
  
      // Optional: cap PnLs at +2 (and >= -1)
      const cappedPnls = pnls.map((pnl) => Math.max(-1, Math.min(pnl, 2)));
  
      // Compute average for this wallet
      const avgPnl = cappedPnls.reduce((acc, val) => acc + val, 0) / cappedPnls.length;
  
      // Collect it
      walletAverages.push(avgPnl);
    }
  
    if (walletAverages.length === 0) {
      // Fallback if no wallets qualify
      return { priorMean: 0, priorVar: 0.25 }; // a fallback prior
    }
  
    // 3. Compute mean & variance of the collected averages
    const n = walletAverages.length;
    const mean = walletAverages.reduce((acc, v) => acc + v, 0) / n;
  
    let varianceAcc = 0;
    for (const val of walletAverages) {
      varianceAcc += (val - mean) ** 2;
    }
    // sample variance
    const variance = n > 1 ? varianceAcc / (n - 1) : 0.25;
  
    console.log(`Finished parameter estimation from ${n} wallets: mean=${mean.toFixed(4)}, var=${variance.toFixed(4)}`);
  
    // 4. Return prior parameters
    return {
      priorMean: mean,
      priorVar: variance,
    };
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
  let filteredTrades: Trade[] = [];
  for(const trade of trades){
      if(trade.amount < 0){
          if(!firstBuyTimestampMap.has(trade.mint)){
              firstBuyTimestampMap.set(trade.mint, trade.timestamp);
              firstBuyTradeMap.set(trade.mint, trade);
          } else {
              if(trade.timestamp < firstBuyTimestampMap.get(trade.mint)!) {
                  firstBuyTimestampMap.set(trade.mint, trade.timestamp);
                  firstBuyTradeMap.set(trade.mint, trade);
              }
          }
      } else {
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
    // we only consider positions with exactly 3 sells in your example
    if (posData.buyFound && posData.sellAmounts.length === 3) {
      const totalSells = posData.sellAmounts.reduce((acc, val) => acc + val, 0);
      const pnl = totalSells - 1; // net result of buying for 1 SOL and selling
      pnls.push(pnl);
    }
  });

  return pnls;
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

/** 
 * Bayesian Score
 * 
 * We assume: 
 *   prior:  mu ~ Normal(priorMean, priorVar)
 *   data:   x_i ~ Normal(mu, sigma^2) [where sigma^2 ~ sample variance of x_i]
 * 
 * posterior: mu | x ~ Normal(muN, tauN^2), where
 *   muN = [ (mu0 / tau^2) + (n * xbar / sigma^2 ) ] / [ (1 / tau^2) + (n / sigma^2) ]
 *   1/tauN^2 = (1 / tau^2) + (n / sigma^2)
 * 
 * We return the "score" = posteriorMean - z * posteriorStd (like a conservative lower bound).
 */
function computeBayesianScore(
  data: number[],
  opts: { priorMean: number; priorVar: number; z?: number }
): number {
  const { priorMean, priorVar, z = 1.645 } = opts;
  const n = data.length;
  if (n === 0) {
    // no data => fallback to prior mean as "score"
    return priorMean;
  }

  // sample mean
  const xbar = data.reduce((acc, v) => acc + v, 0) / n;

  // sample variance (with min floor)
  if (n === 1) {
    // approximate no variance with a small floor
    const smallVar = 0.05;
    const tauN2 = 1 / (1 / priorVar + n / smallVar);
    const muN = 
      (priorMean / priorVar + n * xbar / smallVar) / 
      (1 / priorVar + n / smallVar);
    const posteriorStd = Math.sqrt(tauN2);
    return muN - z * posteriorStd;
  }

  let variance =
    data.reduce((acc, v) => acc + (v - xbar) ** 2, 0) / (n - 1);
  // impose a floor to avoid near-zero variance
  if (variance < 0.0001) {
    variance = 0.0001;
  }

  // Now compute posterior
  // posterior precision = (1/tau^2 + n/sigma^2)
  const posteriorPrecision = 1 / priorVar + n / variance;
  const tauN2 = 1 / posteriorPrecision;

  // posterior mean
  const muN =
    (priorMean / priorVar + (n * xbar) / variance) / posteriorPrecision;

  const posteriorStd = Math.sqrt(tauN2);

  // Return lower-bound style score
  const score = muN - z * posteriorStd;
  return score;
}