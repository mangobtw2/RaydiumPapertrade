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

//init function: needs to be awaited before running
export async function init(clearMemory: boolean = false){
    try{
        await redisClient.connect();
    }catch(error){
        logger.error("Failed to connect to Redis", error);
    }
    
    if (clearMemory) {
        await clearRedisMemory();
    }
    
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
                        init();
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
        await init();
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
        console.error("gRPC stream ended, attempting to reconnect...");
        setTimeout(() => {
            init();
        }, 500);
    });

    stream.on("close", () => {
        console.error("gRPC stream closed, attempting to reconnect...");
        setTimeout(() => {
            init();
        }, 500);
    });
}

let queue: Status[] = [];

setInterval(() => {
    const now = Date.now();
    // Find expired items
    const expiredItems = queue.filter(item => item.waitingForTimestamp <= now);
    // Process expired items
    for (const item of expiredItems) {
        processStatus(item);
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
            if(trade.direction == "buy"){
                trackBuy(trade, poolBalance.ammId);
            }
        }
    }
    
}

function createID(){
    return crypto.randomUUID();
}

async function trackBuy(trade: Trade, ammId: string){
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

async function processStatus(status: Status){
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
                await redisClient.lPush(`trades:${status.address}`, JSON.stringify({
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
            await redisClient.lPush(`trades:${status.address}`, JSON.stringify({
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
    }
}

// Add these functions for memory management
export async function clearRedisMemory() {
    try {
        // Get all keys matching the pattern "tradesPump:*"
        const keys = await redisClient.keys('trades:*');
        
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