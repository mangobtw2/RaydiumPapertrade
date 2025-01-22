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
    url: 'redis://localhost:16379',
    socket: {
        reconnectStrategy: retries => Math.min(retries * 50, 1000)
    }
});

// +++ INITIALIZATION & SETUP +++

//init function: needs to be awaited before running
export async function init(clearMemory: boolean = false){
    await redisClient.connect();
    
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
// let messageCount = 0;
// let lastLog = Date.now();
// let bytesReceived = 0;
//sets up the event handlers for the gRPC stream
function setupStreamEventHandlers(stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>){
    stream.on("data", async (data: SubscribeUpdate) => {
        // messageCount++;
        // bytesReceived += JSON.stringify(data).length; // approximate size

        // // Log stats every second
        // const now = Date.now();
        // if (now - lastLog >= 1000) {
        //     console.log({
        //         messagesPerSecond: messageCount,
        //         mbPerSecond: (bytesReceived / 1024 / 1024).toFixed(2),
        //         avgMessageSize: (bytesReceived / messageCount).toFixed(2),
        //         time: data.createdAt?.toTimeString()
        //     });
        //     messageCount = 0;
        //     bytesReceived = 0;
        //     lastLog = now;
        // }

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
    await redisClient.lPush(`trades:${trade.wallet}`, JSON.stringify({
        id: status.positionID,
        amount: -1  // negative for buy
    }));
}

async function sellThird(status: Status){
    const currentTokensPerLamport = tokensPerLamportMap.get(status.mint);
    if(!currentTokensPerLamport) return;
    const sellAmount = (status.initialTokensPerLamport / currentTokensPerLamport) / 3;
    
    // Append sell trade to the wallet's trade list
    await redisClient.lPush(`trades:${status.address}`, JSON.stringify({
        id: status.positionID,  // same ID to connect with buy
        amount: sellAmount  // positive for sell
    }));

    if(status.waitingForSell < 3){
        queue.push({
            ...status,
            waitingForTimestamp: status.waitingForTimestamp + 1000 * 60,
            waitingForSell: status.waitingForSell + 1
        })
    }
}

// Add these functions for memory management
export async function clearRedisMemory() {
    try {
        await redisClient.flushAll();
        logger.info('Redis memory cleared successfully');
    } catch (error) {
        logger.error('Error clearing Redis memory:', error);
    }
}

// Optional: Add a function to get memory usage
export async function getRedisMemoryInfo() {
    const info = await redisClient.info('memory');
    return info;
}