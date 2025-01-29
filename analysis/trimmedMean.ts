export function computeTrimmedMean(values: number[], trimPercent: number = 0.1): number {
    if(values.length == 0) return 0;
    if(values.length == 1) return values[0];
    const sorted = [...values].sort((a, b) => a - b).map(x => Math.min(x, 2)); //maximum pnl of 2 sol
    const n = values.length;
    const trimCount = Math.ceil(n * trimPercent);

    //only trim the top, not the bottom

    //const start = Math.min(trimCount, n - 1);
    const start = 0;
    const end = Math.max(n - trimCount, start);

    const trimmed = sorted.slice(start, end);
    const mean =
      trimmed.reduce((acc, v) => acc + v, 0) / (trimmed.length || 1);
    return mean;
  }