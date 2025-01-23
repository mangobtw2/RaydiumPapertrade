import { Trade } from "./analysis/basic.js";
import { Address } from "@solana/web3.js";
import { getBondingCurveAddress } from "./coreUtils.js";
import {rpc} from "./core/index.js"

async function isFromPump(mint: string){
    const bondingCurveAddress = await getBondingCurveAddress({mintPubkey: mint as Address});
    const existTradesOnChain = await rpc.performanceRpc.getSignaturesForAddress(bondingCurveAddress, {
        limit: 1
    }).send();
    return existTradesOnChain.length > 0;
}

export async function checkRaydium(trades: Trade[]){
    const tradedMints = trades.map(trade => trade.mint);
    //check 1: if no pump trades, filter out
    let existsNonPump = tradedMints.some(mint => mint.endsWith('pump'));
    if(!existsNonPump){
        return false;
    }
    //check 2: if not all trades are pump trades, pass
    const isAllPump = tradedMints.every(mint => mint.endsWith('pump'));
    if(!isAllPump){
        return true;
    }
    //check 3: if all trades are pump trades, check up to 3 pump mints if they are actually from pump.fun
    const mintSet = new Set(tradedMints);
    let iteration = 0;
    for(const mint of mintSet){
        const isPump = await isFromPump(mint);
        if(isPump){
            return true;
        }
        iteration++;
        if(iteration >= 3){
            return false;
        }
    }
    return false;
}