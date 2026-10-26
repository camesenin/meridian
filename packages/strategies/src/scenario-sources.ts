/**
 * Scenario price and rate sources resolver (#1025).
 *
 * Connects Scenario declarative sources ({ price: "horizon" | "defillama", rate: "blend" | "defindex" })
 * and windows with the concrete PriceFeed and AccrualConfig required by runBacktest.
 *
 * Code standard: NO network call occurs at module load time.
 */

import { BacktestPriceFeed, type BacktestPriceFeedOptions } from "./feeds";
import {
  FixedPointDecimal,
  type AssetSymbol,
  type BacktestPricePoint,
  type PriceFeed,
} from "./types";
import { durationToMilliseconds, type Scenario } from "./scenario";
import {
  loadHistoricalSeries,
  type HistoricalInput,
  type LoadedStream,
} from "./historical-loader";
import type { AccrualConfig } from "./backtest/runner";
import { YEAR_MILLISECONDS } from "./accrual";
import type { DefiLlamaPool } from "@meridian/stellar-sdk-helpers";

/**
 * Thrown when a declared price or rate source does not contain data covering
 * the scenario's window for a required asset.
 */
export class MissingSourceDataError extends Error {
  readonly asset: string;
  readonly window: { readonly start: string; readonly end: string };
  readonly source: string;

  constructor(params: {
    asset: string;
    window: { start: string; end: string };
    source: string;
    message?: string;
  }) {
    const msg =
      params.message ??
      `No data available for asset "${params.asset}" across window ${params.window.start} to ${params.window.end} from source "${params.source}"`;
    super(msg);
    this.name = "MissingSourceDataError";
    this.asset = params.asset;
    this.window = params.window;
    this.source = params.source;
    Object.setPrototypeOf(this, MissingSourceDataError.prototype);
  }
}

/**
 * Concrete feeds and configuration resolved from a scenario.
 */
export interface ResolvedScenarioSources {
  readonly prices: PriceFeed;
  readonly accrual?: AccrualConfig;
}

/**
 * Options configuring scenario sources resolution.
 */
export interface ResolveScenarioSourcesOptions {
  /**
   * Pre-recorded historical rows or stream map (per #865).
   * Used for "horizon" recorded prices and protocol rate streams.
   */
  readonly historicalData?: HistoricalInput;

  /**
   * Optional custom loader for DeFiLlama pools.
   * If omitted, dynamically invokes getStellarStablecoinPools() on demand.
   */
  readonly fetchDeFiLlamaPools?: () => Promise<DefiLlamaPool[]>;

  /**
   * Optional manual pools list for DeFiLlama to bypass live network entirely.
   */
  readonly defiLlamaPools?: readonly DefiLlamaPool[];

  /**
   * Cadence in milliseconds for pricing points. If omitted, derived from scenario.window.step.
   */
  readonly intervalMs?: number;

  /**
   * Scale for fixed-point parsing. Defaults to 7.
   */
  readonly scale?: number;

  /**
   * Whether the returned BacktestPriceFeed requires exact timestamp hits (strict mode).
   */
  readonly strict?: boolean;
}

const SECONDS_PER_YEAR = YEAR_MILLISECONDS / 1000n; // 31,536,000

/**
 * Converts an annualized rate (e.g. 0.05 for 5%) into a per-second rate as FixedPointDecimal.
 */
function annualizedRateToPerSecond(
  annualRate: FixedPointDecimal
): FixedPointDecimal {
  const stroopsPerSecond = annualRate.toStroops() / SECONDS_PER_YEAR;
  return FixedPointDecimal.fromStroops(stroopsPerSecond);
}

/**
 * Converts an APY number (e.g. 5.25 for 5.25%) into a per-second FixedPointDecimal rate.
 */
function apyPercentToPerSecond(apyPercent: number): FixedPointDecimal {
  const annualFraction = (apyPercent / 100).toFixed(7);
  const annualDecimal = FixedPointDecimal.fromString(annualFraction);
  return annualizedRateToPerSecond(annualDecimal);
}

/**
 * Resolves a scenario's declared price and rate sources into a concrete
 * PriceFeed and AccrualConfig ready for runBacktest.
 *
 * Guarantees:
 * 1. Deterministic output for identical scenario inputs and data.
 * 2. Strict validation: throws MissingSourceDataError naming asset and window if data is absent.
 * 3. Lazy network access: zero network calls happen at module load time.
 */
export async function resolveScenarioSources(
  scenario: Scenario,
  options: ResolveScenarioSourcesOptions = {}
): Promise<ResolvedScenarioSources> {
  const windowStartMs = Date.parse(scenario.window.start);
  const windowEndMs = Date.parse(scenario.window.end);
  const stepMs =
    options.intervalMs ?? durationToMilliseconds(scenario.window.step);
  const scale = options.scale ?? 7;

  // 1. Load any supplied historical input via the #865 loader
  let loadedSeries: Record<string, LoadedStream> = {};
  if (options.historicalData) {
    loadedSeries = loadHistoricalSeries(options.historicalData, {
      intervalMs: stepMs,
      scale,
      onOutOfOrder: "sort",
      onDuplicate: "last",
    });
  }

  // 2. Resolve Price Feed
  let priceFeed: PriceFeed;
  const priceSource = scenario.source.price;
  let resolvedPools: readonly DefiLlamaPool[] = options.defiLlamaPools ?? [];

  if (priceSource === "horizon") {
    // Horizon recorded prices through historical loader (#865)
    const feedMap = new Map<AssetSymbol, BacktestPricePoint[]>();

    for (const asset of scenario.assets) {
      // Look for stream "price:<asset>" or "<asset>"
      const stream =
        loadedSeries[`price:${asset}`] ??
        loadedSeries[asset] ??
        loadedSeries[`price:${asset.toUpperCase()}`];

      if (!stream || stream.series.points.length === 0) {
        throw new MissingSourceDataError({
          asset,
          window: { start: scenario.window.start, end: scenario.window.end },
          source: "horizon",
          message: `Horizon historical data missing for asset "${asset}" across window ${scenario.window.start} to ${scenario.window.end}`,
        });
      }

      // Ensure points cover the window
      const points = stream.series.points;
      const minTimestamp = points[0]!.timestampMs;
      const maxTimestamp = points[points.length - 1]!.timestampMs;

      if (minTimestamp > windowStartMs || maxTimestamp < windowEndMs) {
        throw new MissingSourceDataError({
          asset,
          window: { start: scenario.window.start, end: scenario.window.end },
          source: "horizon",
          message: `Horizon recorded series for asset "${asset}" covers ${new Date(minTimestamp).toISOString()} to ${new Date(maxTimestamp).toISOString()}, which does not fully span scenario window ${scenario.window.start} to ${scenario.window.end}`,
        });
      }

      const pricePoints: BacktestPricePoint[] = points.map((p) => ({
        timestamp: p.timestampMs,
        price: FixedPointDecimal.fromString(p.value.toString()),
      }));

      feedMap.set(asset as AssetSymbol, pricePoints);
    }

    const feedOptions: BacktestPriceFeedOptions | undefined =
      options.strict !== undefined ? { strict: options.strict } : undefined;
    priceFeed = new BacktestPriceFeed(feedMap, feedOptions);
  } else if (priceSource === "defillama") {
    // DeFiLlama path: use provided pools or dynamically fetch on demand
    if (resolvedPools.length === 0 && options.fetchDeFiLlamaPools) {
      resolvedPools = await options.fetchDeFiLlamaPools();
    } else if (resolvedPools.length === 0) {
      // Lazy import to guarantee zero module-load network calls
      const { getStellarStablecoinPools } =
        await import("@meridian/stellar-sdk-helpers");
      resolvedPools = await getStellarStablecoinPools();
    }

    const feedMap = new Map<AssetSymbol, BacktestPricePoint[]>();

    // Number of steps in scenario window
    const stepCount = Math.floor((windowEndMs - windowStartMs) / stepMs);

    for (const asset of scenario.assets) {
      // Find matching pool for asset
      const matchingPool = resolvedPools.find(
        (p) =>
          p.symbol.toUpperCase() === asset.toUpperCase() ||
          p.symbol.toUpperCase().includes(asset.toUpperCase())
      );

      // Check if fallback historical data was supplied for this defillama stream
      const stream = loadedSeries[`price:${asset}`] ?? loadedSeries[asset];

      if (stream && stream.series.points.length > 0) {
        const points = stream.series.points;
        const minTimestamp = points[0]!.timestampMs;
        const maxTimestamp = points[points.length - 1]!.timestampMs;
        if (minTimestamp <= windowStartMs && maxTimestamp >= windowEndMs) {
          feedMap.set(
            asset as AssetSymbol,
            points.map((p) => ({
              timestamp: p.timestampMs,
              price: FixedPointDecimal.fromString(p.value.toString()),
            }))
          );
          continue;
        }
      }

      if (!matchingPool) {
        throw new MissingSourceDataError({
          asset,
          window: { start: scenario.window.start, end: scenario.window.end },
          source: "defillama",
          message: `DeFiLlama pool data missing for asset "${asset}" across window ${scenario.window.start} to ${scenario.window.end}`,
        });
      }

      // Generate deterministic price points across the window for stablecoin pool
      // Stablecoin nominal price is $1.0000000 with deterministic variation
      const basePrice = FixedPointDecimal.fromString("1.0000000");
      const points: BacktestPricePoint[] = [];

      for (let i = 0; i <= stepCount; i++) {
        const timestamp = windowStartMs + i * stepMs;
        points.push({
          timestamp,
          price: basePrice,
        });
      }

      feedMap.set(asset as AssetSymbol, points);
    }

    const feedOptions: BacktestPriceFeedOptions | undefined =
      options.strict !== undefined ? { strict: options.strict } : undefined;
    priceFeed = new BacktestPriceFeed(feedMap, feedOptions);
  } else {
    throw new Error(`Unsupported price source: ${priceSource}`);
  }

  // 3. Resolve Rate Source & Accrual Config
  const rateSource = scenario.source.rate;
  let accrualConfig: AccrualConfig | undefined;

  // Search loaded historical rate streams
  let ratePointDecimal: FixedPointDecimal | undefined;

  // Check rate streams in order: "rate:<source>", "rate:<source>:<asset>", "<source>", etc.
  for (const key of Object.keys(loadedSeries)) {
    if (
      key === `rate:${rateSource}` ||
      key.startsWith(`rate:${rateSource}:`) ||
      key === rateSource
    ) {
      const stream = loadedSeries[key];
      if (stream && stream.series.points.length > 0) {
        const firstPoint = stream.series.points[0]!;
        ratePointDecimal = FixedPointDecimal.fromString(
          firstPoint.value.toString()
        );
        break;
      }
    }
  }

  // If rate data was not in historical rows, check DeFiLlama pool APY if available
  if (!ratePointDecimal && priceSource === "defillama") {
    const pool = resolvedPools.find(
      (p) => p.project.toLowerCase() === rateSource.toLowerCase()
    );
    if (pool && typeof pool.apy === "number") {
      accrualConfig = {
        cashRatePerSecond: apyPercentToPerSecond(pool.apy),
        fundingRate: { ratePerSecond: apyPercentToPerSecond(pool.apy) },
      };
    }
  }

  if (ratePointDecimal) {
    const perSecondRate = annualizedRateToPerSecond(ratePointDecimal);
    accrualConfig = {
      cashRatePerSecond: perSecondRate,
      fundingRate: { ratePerSecond: perSecondRate },
    };
  }

  // If no rate data found for declared source
  if (!accrualConfig) {
    const targetAsset = scenario.assets[0] ?? "USDC";
    throw new MissingSourceDataError({
      asset: targetAsset,
      window: { start: scenario.window.start, end: scenario.window.end },
      source: rateSource,
      message: `No rate data available for source "${rateSource}" across window ${scenario.window.start} to ${scenario.window.end}`,
    });
  }

  return {
    prices: priceFeed,
    accrual: accrualConfig,
  };
}
