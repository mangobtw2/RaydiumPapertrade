import ClientPkg, { SubscribeRequest, SubscribeUpdate, SubscribeUpdateSlot, SubscribeUpdateTransaction, txErrDecode } from "@triton-one/yellowstone-grpc";
const Client = (ClientPkg as any).default || ClientPkg;
import { TransactionErrorSolana } from "@triton-one/yellowstone-grpc/dist/types.js";
import { ClientDuplexStream } from "@grpc/grpc-js";
import { Commitment } from "@solana/web3.js";
import * as config from './config.js';
import { createLogger } from "./logger.js";
import { Type } from "typescript";
import { Trade } from "./tradeTypes.js";
import { grpcExistsMigration, grpcTransactionToTrades, tradeToPrice } from "./coreUtils.js";
import bs58 from "bs58";
import { fileURLToPath } from 'url';
import fs from "fs";
import { createClient } from 'redis';


const logger = createLogger(fileURLToPath(import.meta.url));

const client = new Client(config.grpc_url, undefined, {});
let stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>;

let tokensPerLamportMap = new Map<string, number>();

const redisClient = createClient({
    url: 'redis://localhost:6379',
    socket: {
        reconnectStrategy: retries => Math.min(retries * 50, 1000)
    }
});

// +++ INITIALIZATION & SETUP +++

let prefixId = "paper";
let wallets: string[] = [];

//init function: needs to be awaited before running
export async function init(walletFile: string, clearMemory: boolean = false, prefixIdInput: string = ""){
    try{
        await redisClient.connect();
    }catch(error){
        logger.error("Failed to connect to Redis", error);
    }

    if(prefixIdInput != ""){
        prefixId = "paper" + prefixIdInput;
    }else{
        prefixId = "paper" + createID().slice(0, 6);
    }
    
    if (clearMemory) {
        await clearRedisMemory();
    }

    wallets = JSON.parse(fs.readFileSync(walletFile, 'utf8')).map((wallet: any) => wallet.address);
    
    try{
        try{
            stream.end();
        }catch(error){
            //
        }
        stream = await client.subscribe();
        setupStreamEventHandlers(stream);
        console.log("gRPC stream initialized");

        let request: SubscribeRequest = {
            accounts: {},
            slots: {
                slots: {}
            },
            transactions: {
                txs: { //raydium & pump transactions
                    vote: false,
                    accountInclude: ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"],
                    //accountInclude: [],
                    accountExclude: [],
                    accountRequired: []
                }
            },
            transactionsStatus: {},
            entry: {},
            blocks: {},
            blocksMeta: {},
            accountsDataSlice: [],
        }

        return new Promise<void>((resolve, reject) => {
            try{
                stream.write(request, (err: any) => {
                    if (err === null || err === undefined) {
                        console.log("gRPC stream request sent");
                        resolve();
                    } else {
                    console.error("Failed to send gRPC stream request", err);
                    setTimeout(() => {
                        init(walletFile);
                        }, 10000);
                    }
                });
            }catch(error){
                logger.error("Error sending gRPC stream request", error);
            }
        });
    }catch(error){
        console.error("Failed to connect gRPC stream, retrying in 10 seconds...", error);
        await new Promise(resolve => setTimeout(resolve, 10000));
        await init(walletFile);
    }
}
let lastLog = Date.now();
//sets up the event handlers for the gRPC stream
function setupStreamEventHandlers(stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>){
    stream.on("data", async (data: SubscribeUpdate) => {

        const now = Date.now();
        if (now - lastLog >= 1000) {
            console.log({
                time: data.createdAt?.toTimeString()
            });
            lastLog = now;
        }

        handleTransactionUpdate(data);
    });

    stream.on("error", (err: any) => {
        console.error("Error in gRPC stream", err);
    });

    stream.on("end", () => {
        console.error("gRPC stream ended");
        stream.end();
    });

    stream.on("close", () => {
        console.error("gRPC stream closed");
        stream.end();
    });
}

let queue: Status[] = [];

setInterval(() => {
    const now = Date.now();
    // Find expired items
    const expiredItems = queue.filter(item => item.waitingForTimestamp <= now);
    // Process expired items
    for (const item of expiredItems) {
        sellThird(item);
    }
    // Remove expired items from queue
    queue = queue.filter(item => item.waitingForTimestamp > now);
}, 1000);

type Status = {
    positionID: string;
    mint: string;
    address: string;
    initialTokensPerLamport: number;
    waitingForTimestamp: number; //waiting for timestamp
    waitingForSell: number; //waiting for sell 1, 2 or 3
}

async function handleTransactionUpdate(data: SubscribeUpdate){
    if(!data.transaction) return;
    const trades = await grpcTransactionToTrades(data.transaction);
    if(trades){
        for(const trade of trades){
            if(!wallets.includes(trade.wallet)) continue;
            const tokensPerLamport = Number(trade.tokens) / Number(trade.lamports);
            tokensPerLamportMap.set(trade.mint, tokensPerLamport);
            if(trade.direction == "buy"){
                trackBuy(trade, tokensPerLamport);
            }
        }
    }
}

function createID(){
    return crypto.randomUUID();
}

async function trackBuy(trade: Trade, tokensPerLamport: number){
    const status: Status = {
        positionID: createID(),
        mint: trade.mint,
        address: trade.wallet,
        initialTokensPerLamport: tokensPerLamport,
        waitingForTimestamp: Date.now() + 1000 * 165,
        waitingForSell: 1
    }
    queue.push(status);
    
    // Use Redis List to append trade data for the wallet
    await redisClient.lPush(`${prefixId}:${trade.wallet}`, JSON.stringify({
        positionID: status.positionID,
        amount: -1,  // negative for buy
        timestamp: Date.now(),
        mint: trade.mint
    }));
}

async function sellThird(status: Status){
    const currentTokensPerLamport = tokensPerLamportMap.get(status.mint);
    if(!currentTokensPerLamport) return;
    const sellAmount = (status.initialTokensPerLamport / currentTokensPerLamport) / 3;
    
    // Append sell trade to the wallet's trade list
    await redisClient.lPush(`${prefixId}:${status.address}`, JSON.stringify({
        positionID: status.positionID,  // same ID to connect with buy
        amount: sellAmount,  // positive for sell
        timestamp: Date.now(),
        mint: status.mint
    }));

    if(status.waitingForSell < 3) {
        queue.push({
            ...status,
            waitingForTimestamp: status.waitingForTimestamp + 1000 * 60,
            waitingForSell: status.waitingForSell + 1
        });
    }
}

// Add these functions for memory management
export async function clearRedisMemory() {
    try {
        // Get all keys matching the pattern "papertradeRaydium:*"
        const keys = await redisClient.keys(`${prefixId}:*`);
        
        if (keys.length > 0) {
            // Delete all matched keys
            await redisClient.del(keys);
            logger.info(`Redis memory cleared successfully for ${keys.length} trades keys`);
        } else {
            logger.info('No trades keys found to clear');
        }
    } catch (error) {
        logger.error('Error clearing Redis memory:', error);
    }
}

// Optional: Add a function to get memory usage
export async function getRedisMemoryInfo() {
    const info = await redisClient.info('memory');
    return info;
}


//pnl computation

async function computePnl(): Promise<number> {
  // Group trades by positionID
  const positions = new Map<string, { buyFound: boolean; sellAmounts: number[] }>();

  let firstBuyTimestampMap = new Map<string, number>();
  let firstBuyTradeMap = new Map<string, OurTrade>();

  //get all trades
  const wallets = await redisClient.lRange(`${prefixId}:*`, 0, -1);
  let trades: OurTrade[] = [];
  for(const wallet of wallets){
    const tradesForWallet = await redisClient.lRange(`${prefixId}:${wallet}`, 0, -1);
    for(const trade of tradesForWallet){
      const tradeData = JSON.parse(trade);
      const ourTrade: OurTrade = {
        positionID: tradeData.positionID,
        amount: tradeData.amount,
        timestamp: tradeData.timestamp,
        mint: tradeData.mint
      }
      trades.push(ourTrade);
    }
  }

  // filter out the non-first buys for every token mint, ranked by timestamp
  let filteredTrades: OurTrade[] = [];
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

  //sum of all pnl
  return pnls.reduce((acc, val) => acc + val, 0);
}


export interface OurTrade {
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
    confidenceScore: number;        // used for final ranking
  }

setInterval(async () => {
  const pnl = await computePnl();
  console.log(`PnL for prefix ${prefixId}: ${pnl}`);
}, 120000);