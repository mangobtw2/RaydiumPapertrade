/**
 * Win Rate x Gain/Loss Ratio Score
 *
 * 1. Win Rate = (# trades with pnl > 0) / total
 * 2. Gain/Loss Ratio = (avg of positive pnls) / |avg of negative pnls|
 * 
 * Score = winRate * gainLossRatio
 */
export function computeWinRateGainLossScore(data: number[]): number {
    const n = data.length;
    if (n === 0) return 0;
  
    let positivePnls: number[] = [];
    let negativePnls: number[] = [];
  
    for (const val of data) {
      if (val > 0) {
        positivePnls.push(val);
      } else if (val < 0) {
        negativePnls.push(val);
      }
    }
  
    const winRate = positivePnls.length / n;
  
    let avgPos = 0;
    if (positivePnls.length > 0) {
      avgPos = positivePnls.reduce((acc, v) => acc + v, 0) / positivePnls.length;
    }
  
    let avgNeg = 0;
    if (negativePnls.length > 0) {
      avgNeg =
        negativePnls.reduce((acc, v) => acc + v, 0) / negativePnls.length;
    }
  
    // If no negative trades, let's define gain/loss ratio as something large
    // but not infinite. E.g., set it to 2x the largest positive if you want
    // or a big number:
    let gainLossRatio: number;
    if (negativePnls.length === 0) {
      gainLossRatio = 5; // arbitrary large ratio
    } else {
      gainLossRatio = avgPos / Math.abs(avgNeg);
    }
  
    // Score
    const score = winRate * gainLossRatio;
    return score;
  }