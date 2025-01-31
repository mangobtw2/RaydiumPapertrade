export function computeAverage(values: number[]): number {
    if(values.length == 0) return 0;
    if(values.length == 1) return values[0];
    return values.reduce((acc, v) => acc + v, 0) / values.length;
  }