/** 
 * Bayesian Score
 * 
 * We assume: 
 *   prior:  mu ~ Normal(priorMean, priorVar)
 *   data:   x_i ~ Normal(mu, sigma^2) [where sigma^2 ~ sample variance of x_i]
 * 
 * posterior: mu | x ~ Normal(muN, tauN^2), where
 *   muN = [ (mu0 / tau^2) + (n * xbar / sigma^2 ) ] / [ (1 / tau^2) + (n / sigma^2) ]
 *   1/tauN^2 = (1 / tau^2) + (n / sigma^2)
 * 
 * We return the "score" = posteriorMean - z * posteriorStd (like a conservative lower bound).
 */
export function computeBayesianScore(
  data: number[]
): number {
    const z = 1.645;
    const priorMean = -0.05;
    const priorVar = 0.022;
    const n = data.length;
    if (n === 0) {
        // no data => fallback to prior mean as "score"
        return priorMean;
    }

    const cappedData = data.map(x => Math.min(x, 2));

    // sample mean
    const xbar = data.reduce((acc, v) => acc + v, 0) / n;

    // sample variance (with min floor)
    if (n === 1) {
        // approximate no variance with a small floor
        const smallVar = 0.05;
        const tauN2 = 1 / (1 / priorVar + n / smallVar);
        const muN = 
        (priorMean / priorVar + n * xbar / smallVar) / 
        (1 / priorVar + n / smallVar);
        const posteriorStd = Math.sqrt(tauN2);
        return muN - z * posteriorStd;
    }

    let variance =
        data.reduce((acc, v) => acc + (v - xbar) ** 2, 0) / (n - 1);
    // impose a floor to avoid near-zero variance
    if (variance < 0.0001) {
        variance = 0.0001;
    }

    // Now compute posterior
    // posterior precision = (1/tau^2 + n/sigma^2)
    const posteriorPrecision = 1 / priorVar + n / variance;
    const tauN2 = 1 / posteriorPrecision;

    // posterior mean
    const muN =
        (priorMean / priorVar + (n * xbar) / variance) / posteriorPrecision;

    const posteriorStd = Math.sqrt(tauN2);

    // Return lower-bound style score
    const score = muN - z * posteriorStd;
    return score;
}