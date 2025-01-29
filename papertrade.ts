import ClientPkg, { SubscribeRequest, SubscribeUpdate, SubscribeUpdateSlot, SubscribeUpdateTransaction, txErrDecode } from "@triton-one/yellowstone-grpc";
const Client = (ClientPkg as any).default || ClientPkg;
import { TransactionErrorSolana } from "@triton-one/yellowstone-grpc/dist/types.js";
import { ClientDuplexStream } from "@grpc/grpc-js";
import { Commitment } from "@solana/web3.js";
import * as config from './config.js';
import { createLogger } from "./logger.js";
import { Type } from "typescript";
import { Trade } from "./tradeTypes.js";
import { grpcExistsMigration, grpcTransactionToPoolBalances, grpcTransactionToTrades, tradeToPrice } from "./coreUtils.js";
import bs58 from "bs58";
import { fileURLToPath } from 'url';
import fs from "fs";
import { createClient } from 'redis';
import { getOutAmount } from "./raydiumCalc.js";

const logger = createLogger(fileURLToPath(import.meta.url));

const client = new Client(config.grpc_url, undefined, {});
let stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>;


//let tokensPerLamportMap = new Map<string, number>();
//map from market ids to pool balances
let poolBalancesByAmmId = new Map<string, {solPool: bigint, tokenPool: bigint}>();

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
    ammId: string;
    address: string;
    tokensBought: bigint;
    waitingForTimestamp: number; //waiting for timestamp
    waitingFor: number; //waiting for sell (1, 2 or 3) or buy (0)
}

type PoolBalance = {
    ammId: string;
    solPool: bigint;
    tokenPool: bigint;
}

async function handleTransactionUpdate(data: SubscribeUpdate){
    if(!data.transaction) return;
    //step 1: update pool balances
    const poolBalances = await grpcTransactionToPoolBalances(data.transaction);
    let poolBalance: PoolBalance | undefined;
    if(poolBalances){
        poolBalance = poolBalances[0];
        poolBalancesByAmmId.set(poolBalance.ammId, {
            solPool: poolBalance.solPool,
            tokenPool: poolBalance.tokenPool
        });

        //step 2: update trades
        const trades = await grpcTransactionToTrades(data.transaction);
        if(trades){
            const trade = trades[0];
            if(!wallets.includes(trade.wallet)) return;
            if(trade.direction == "buy"){
                trackBuy(trade, poolBalance.ammId);
            }
        }
    }
}

function createID(){
    return crypto.randomUUID();
}

let addressBoughtMintMap = new Map<string, Map<string, boolean>>();

async function trackBuy(trade: Trade, ammId: string){
    if(trade.lamports < 150000000n) return;
    if(!addressBoughtMintMap.has(trade.wallet)) addressBoughtMintMap.set(trade.wallet, new Map<string, boolean>());
    const mintMap = addressBoughtMintMap.get(trade.wallet)!;
    if(mintMap.get(trade.mint)) return;
    mintMap.set(trade.mint, true);

    const status: Status = {
        positionID: createID(),
        mint: trade.mint,
        ammId: ammId,
        address: trade.wallet,
        tokensBought: 0n,
        waitingForTimestamp: Date.now() + 1000 * 1.5, //wait for 1.5 seconds before buying
        waitingFor: 0
    }
    queue.push(status);
}


async function sellThird(status: Status){
    const poolBalance = poolBalancesByAmmId.get(status.ammId);
    if(!poolBalance) return;
    if(status.waitingFor == 0){
        //adding buy to redis & status for waitng for sell
        const tokensBought = getOutAmount(poolBalance.solPool, poolBalance.tokenPool, 1000000000n); //buy for 1 sol (1000000000 lamports)
        const newStatus: Status = {
            positionID: status.positionID,
            mint: status.mint,
            ammId: status.ammId,
            address: status.address,
            tokensBought: tokensBought,
            waitingForTimestamp: Date.now() + 1000 * 165,
            waitingFor: 1
        }
        queue.push(newStatus);

        for(let attempt = 0; attempt < 3; attempt++){
            try{
                await redisClient.lPush(`${prefixId}:${status.address}`, JSON.stringify({
                    positionID: status.positionID,
                    amount: -1,  // negative for buy
                    timestamp: Date.now(),
                    mint: status.mint
                }));
                break;
            }catch(error){
                console.error("Failed to append buy trade to Redis, retrying in 10 seconds...", error);
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
        }
        return;
    }
    //this is a sell status
    const sellAmountTokens = status.tokensBought / 3n;
    const sellAmountSol = Number(getOutAmount(poolBalance.tokenPool, poolBalance.solPool, sellAmountTokens)) / 1000000000; //getting how much we get out for selling
    
    // Append sell trade to the wallet's trade list
    for(let attempt = 0; attempt < 3; attempt++){
        try{
            await redisClient.lPush(`${prefixId}:${status.address}`, JSON.stringify({
                positionID: status.positionID,  // same ID to connect with buy
                amount: sellAmountSol,  // positive for sell
                timestamp: Date.now(),
                mint: status.mint
            }));
            break;
        }catch(error){
            console.error("Failed to sell third, retrying in 10 seconds...", error);
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }
    

    if(status.waitingFor < 3) {
        queue.push({
            ...status,
            waitingForTimestamp: status.waitingForTimestamp + 1000 * 60,
            waitingFor: status.waitingFor + 1
        });
    }else{
        addressBoughtMintMap.get(status.address)!.set(status.mint, false);
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

export async function computePnl(extensive: boolean = false): Promise<number> {
  // Group trades by positionID
  const positions = new Map<string, { buyFound: boolean; sellAmounts: number[]; wallet: string }>();

  let firstBuyTimestampMap = new Map<string, number>();
  let firstBuyTradeMap = new Map<string, OurTrade>();

  //get all trades
  const wallets = await redisClient.keys(`${prefixId}:*`);
  let trades: OurTrade[] = [];
  for(const wallet of wallets){
    const tradesForWallet = await redisClient.lRange(wallet, 0, -1);
    for(const trade of tradesForWallet){
      const tradeData = JSON.parse(trade);
      const ourTrade: OurTrade = {
        positionID: tradeData.positionID,
        amount: tradeData.amount,
        timestamp: tradeData.timestamp,
        mint: tradeData.mint,
        wallet: wallet.split(":")[1]
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
      positions.set(positionID, { buyFound: false, sellAmounts: [], wallet: trade.wallet });
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
  const pnlsByWallet: Map<string, number[]> = new Map();
  positions.forEach((posData) => {
    // we only consider positions with exactly 3 sells in your example
    if (posData.buyFound && posData.sellAmounts.length === 3) {
      const totalSells = posData.sellAmounts.reduce((acc, val) => acc + val, 0);
      const pnl = totalSells - 1; // net result of buying for 1 SOL and selling
      pnls.push(pnl);
      pnlsByWallet.get(posData.wallet)!.push(pnl);
    }
  });

  if(extensive){
    let walletPnls: {wallet: string, pnlList: number[], totalPnl: number}[] = [];
    for(const wallet of pnlsByWallet.keys()){
      const pnlList = pnlsByWallet.get(wallet)!;
      const totalPnl = pnlList.reduce((acc, val) => acc + val, 0);
      walletPnls.push({wallet, pnlList, totalPnl});
    }
    walletPnls.sort((a, b) => a.totalPnl - b.totalPnl);
    console.log(walletPnls);
  }

  //sum of all pnl
  return pnls.reduce((acc, val) => acc + val, 0);
}


export interface OurTrade {
    positionID: string;
    amount: number;      // -1 means "bought for 1 SOL"; positive means partial sells
    timestamp: number;
    mint: string;        // e.g., "3Jy9X..."
    wallet: string;
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