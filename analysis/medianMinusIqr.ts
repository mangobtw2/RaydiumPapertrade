/**
 * Median - IQR Score
 * 
 * score = median(PnLs) - z * IQR
 * 
 * IQR = Q75 - Q25
 */
export function computeMedianIqrScore(
    data: number[],
    z: number = 1.0
  ): number {
    const n = data.length;
    if (n === 0) return 0; 
  
    // Sort data
    const sorted = [...data].sort((a, b) => a - b);
  
    // Median
    let median: number;
    if (n % 2 === 1) {
      median = sorted[Math.floor(n / 2)];
    } else {
      const mid = n / 2;
      median = (sorted[mid - 1] + sorted[mid]) / 2;
    }
  
    // Quartiles
    const q25 = sorted[Math.floor(n * 0.25)];
    const q75 = sorted[Math.floor(n * 0.75)];
    const iqr = q75 - q25;
  
    return median - z * iqr;
  }