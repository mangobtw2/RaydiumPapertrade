  import { computeStatistics } from "./analysis.js";
  
  /**
   * A simple function to compute a "confidence score" based on
   * mean - Z * stdError. We'll use ~1.645 for a ~90% one-sided interval
   * (you can adjust if you want).
   * 
   * score = avgPnl - z * (stdDev / sqrt(n))
   */
  export function meanMinusStd(
    data: number[]
  ): number {
    const z = 1.645;
    const n = data.length;
    const { average, standardDeviation } = computeStatistics(data);
    if (n <= 1) return average; // not enough data for a true std error, fallback
    const stdError = standardDeviation / Math.sqrt(n);
    return average - z * stdError;
  }