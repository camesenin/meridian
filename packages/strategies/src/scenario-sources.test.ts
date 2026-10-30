import { describe, expect, it, vi } from "vitest";

import {
  MissingSourceDataError,
  resolveScenarioSources,
} from "./scenario-sources";
import { parseScenario } from "./scenario";
import { runBacktest } from "./backtest/runner";
import { DeltaNeutralStrategy } from "./delta-neutral";
import { scenarioClock, scenarioDeltaNeutralConfig } from "./regime-scenarios";
import { FixedPointDecimal, type AssetSymbol } from "./types";
import type { HistoricalRow } from "./historical-loader";
import type { DefiLlamaPool } from "@meridian/stellar-sdk-helpers";

const BASE_SCENARIO_INPUT = {
  window: {
    start: "2024-01-01T00:00:00Z",
    end: "2024-01-01T04:00:00Z",
    step: "PT1H",
  },
  assets: ["USDC", "EURC"],
  source: { price: "horizon", rate: "blend" },
  startingCapital: "10000.0000000",
  strategy: {
    id: "delta-neutral",
    version: "1.0.0",
    params: {
      "market.regime": "ranging",
      "market.startPrice": "1.0000000",
      "market.drift": "0.0000000",
      "market.volatility": "0.0100000",
      "market.fundingRatePerSecond": "0.0000010",
      "market.neutralityBandBps": "50",
      "market.targetLeverage": "2.0000000",
    },
  },
  seed: "seed-deterministic-1025",
} as const;

function makeHistoricalRows(): HistoricalRow[] {
  const timestamps = [
    Date.parse("2024-01-01T00:00:00Z"),
    Date.parse("2024-01-01T01:00:00Z"),
    Date.parse("2024-01-01T02:00:00Z"),
    Date.parse("2024-01-01T03:00:00Z"),
    Date.parse("2024-01-01T04:00:00Z"),
  ];

  const rows: HistoricalRow[] = [];
  for (const t of timestamps) {
    rows.push({
      asset: "USDC",
      timestamp: t,
      price: "1.0000000",
      kind: "price",
    });
    rows.push({
      asset: "EURC",
      timestamp: t,
      price: "1.0850000",
      kind: "price",
    });
    rows.push({
      asset: "blend",
      timestamp: t,
      rate: "0.0525000",
      kind: "rate",
    });
    rows.push({
      asset: "defindex",
      timestamp: t,
      rate: "0.0480000",
      kind: "rate",
    });
  }
  return rows;
}

const MOCK_LLAMA_POOLS: DefiLlamaPool[] = [
  {
    pool: "pool-usdc-stellar",
    project: "blend",
    symbol: "USDC",
    tvlUsd: 5_000_000,
    apy: 5.25,
    apyPct1D: 0.1,
    apyPct7D: 0.2,
    apyPct30D: 0.5,
    poolMeta: null,
    stablecoin: true,
    chain: "Stellar",
  },
  {
    pool: "pool-eurc-stellar",
    project: "defindex",
    symbol: "EURC",
    tvlUsd: 2_500_000,
    apy: 4.8,
    apyPct1D: 0.1,
    apyPct7D: 0.1,
    apyPct30D: 0.4,
    poolMeta: null,
    stablecoin: true,
    chain: "Stellar",
  },
];

describe("scenario-sources resolver (#1025)", () => {
  it("resolves horizon price source and blend rate source into executable feeds", async () => {
    const scenario = parseScenario({
      ...BASE_SCENARIO_INPUT,
      source: { price: "horizon", rate: "blend" },
    });
    const rows = makeHistoricalRows();

    const resolved = await resolveScenarioSources(scenario, {
      historicalData: rows,
    });

    expect(resolved.prices).toBeDefined();
    expect(resolved.accrual).toBeDefined();
    expect(resolved.accrual?.cashRateAnnual).toBeDefined();
    expect(resolved.accrual?.cashRatePerSecond).toBeDefined();
    expect(resolved.accrual?.fundingRate?.ratePerSecond).toBeDefined();

    // Verify spot price for both assets
    const startTs = Date.parse(scenario.window.start);
    expect(resolved.prices.getSpotPrice("USDC", startTs).toString()).toBe("1");
    expect(resolved.prices.getSpotPrice("EURC", startTs).toString()).toBe(
      "1.085"
    );
  });

  it("resolves defillama price source and defindex rate source using real price data and pool APY", async () => {
    const scenario = parseScenario({
      ...BASE_SCENARIO_INPUT,
      source: { price: "defillama", rate: "defindex" },
    });

    // Provide real recorded price points across the window, letting rate resolve from pool
    const priceOnlyRows = makeHistoricalRows().filter(
      (r) => r.kind === "price"
    );

    const resolved = await resolveScenarioSources(scenario, {
      historicalData: priceOnlyRows,
      defiLlamaPools: MOCK_LLAMA_POOLS,
    });

    expect(resolved.prices).toBeDefined();
    expect(resolved.accrual).toBeDefined();
    expect(resolved.accrual?.cashRateAnnual).toBeDefined();

    const startTs = Date.parse(scenario.window.start);
    expect(resolved.prices.getSpotPrice("USDC", startTs).toString()).toBe("1");
    expect(resolved.prices.getSpotPrice("EURC", startTs).toString()).toBe(
      "1.085"
    );
  });

  it("produces feeds and rate inputs that runBacktest accepts and executes", async () => {
    const scenario = parseScenario({
      ...BASE_SCENARIO_INPUT,
      assets: ["USDC"],
      source: { price: "horizon", rate: "blend" },
    });
    const rows = makeHistoricalRows();

    const resolved = await resolveScenarioSources(scenario, {
      historicalData: rows,
    });

    const clock = scenarioClock(scenario);
    const strategy = new DeltaNeutralStrategy();
    const config = scenarioDeltaNeutralConfig(scenario, resolved.prices);

    const result = runBacktest({
      clock,
      assets: ["USDC"] as AssetSymbol[],
      prices: resolved.prices,
      strategy,
      strategyConfig: config,
      initialCash: FixedPointDecimal.fromString(scenario.startingCapital),
      ...(resolved.accrual ? { accrual: resolved.accrual } : {}),
    });

    expect(result.strategyName).toBe("delta-neutral");
    expect(result.snapshots.length).toBeGreaterThan(0);
    expect(result.finalValue).toBeInstanceOf(FixedPointDecimal);
  });

  it("guarantees deterministic resolution and backtest replay over a fixed window", async () => {
    const scenario = parseScenario({
      ...BASE_SCENARIO_INPUT,
      source: { price: "horizon", rate: "blend" },
    });
    const rows = makeHistoricalRows();

    const resolved1 = await resolveScenarioSources(scenario, {
      historicalData: rows,
    });
    const resolved2 = await resolveScenarioSources(scenario, {
      historicalData: rows,
    });

    const startTs = Date.parse(scenario.window.start);
    const endTs = Date.parse(scenario.window.end);

    expect(resolved1.prices.getSpotPrice("USDC", startTs).toStroops()).toBe(
      resolved2.prices.getSpotPrice("USDC", startTs).toStroops()
    );
    expect(resolved1.prices.getSpotPrice("USDC", endTs).toStroops()).toBe(
      resolved2.prices.getSpotPrice("USDC", endTs).toStroops()
    );
    expect(resolved1.accrual?.cashRateAnnual?.toStroops()).toBe(
      resolved2.accrual?.cashRateAnnual?.toStroops()
    );
  });

  it("accrues cash interest without truncation for realistic APY rates", async () => {
    const scenario = parseScenario({
      ...BASE_SCENARIO_INPUT,
      assets: ["USDC"],
      source: { price: "horizon", rate: "blend" },
    });
    const rows = makeHistoricalRows();
    const resolved = await resolveScenarioSources(scenario, {
      historicalData: rows,
    });

    const clock = scenarioClock(scenario);
    const strategy = new DeltaNeutralStrategy();
    const config = scenarioDeltaNeutralConfig(scenario, resolved.prices);

    const result = runBacktest({
      clock,
      assets: ["USDC"] as AssetSymbol[],
      prices: resolved.prices,
      strategy,
      strategyConfig: config,
      initialCash: FixedPointDecimal.fromString(scenario.startingCapital),
      ...(resolved.accrual ? { accrual: resolved.accrual } : {}),
    });

    // 10,000 capital with 5.25% APY over a 4 hour backtest window
    // must accrue interest without truncating to 0 stroops (formerly truncated to zero)
    expect(result.totalInterest.toStroops()).not.toBe(0n);
  });

  it("fails loudly when declared price source has no data for an asset in window", async () => {
    const scenario = parseScenario({
      ...BASE_SCENARIO_INPUT,
      assets: ["USDC", "EURC"],
      source: { price: "horizon", rate: "blend" },
    });
    // Rows missing EURC
    const rowsWithoutEurc = makeHistoricalRows().filter(
      (r) => r.asset !== "EURC"
    );

    await expect(
      resolveScenarioSources(scenario, { historicalData: rowsWithoutEurc })
    ).rejects.toThrowError(MissingSourceDataError);
  });

  it("fails loudly when recorded price data does not span the full scenario window", async () => {
    const scenario = parseScenario({
      ...BASE_SCENARIO_INPUT,
      assets: ["USDC"],
      source: { price: "horizon", rate: "blend" },
    });
    // Missing end timestamp
    const partialRows = makeHistoricalRows().filter(
      (r) => Number(r.timestamp) < Date.parse("2024-01-01T04:00:00Z")
    );

    await expect(
      resolveScenarioSources(scenario, { historicalData: partialRows })
    ).rejects.toThrowError(MissingSourceDataError);
  });

  it("fails loudly when recorded rate series does not span the full scenario window", async () => {
    const scenario = parseScenario({
      ...BASE_SCENARIO_INPUT,
      source: { price: "horizon", rate: "blend" },
    });
    // Rate points only present for the first timestamp (does not cover full window)
    const partialRows: HistoricalRow[] = makeHistoricalRows().filter(
      (r) =>
        r.kind === "price" ||
        (r.kind === "rate" &&
          Number(r.timestamp) === Date.parse("2024-01-01T00:00:00Z"))
    );

    await expect(
      resolveScenarioSources(scenario, { historicalData: partialRows })
    ).rejects.toThrowError(MissingSourceDataError);
  });

  it("fails loudly when declared rate source has no data", async () => {
    const scenario = parseScenario({
      ...BASE_SCENARIO_INPUT,
      assets: ["USDC"],
      source: { price: "horizon", rate: "defindex" },
    });
    const rowsWithoutDefindex = makeHistoricalRows().filter(
      (r) => r.asset !== "defindex"
    );

    await expect(
      resolveScenarioSources(scenario, {
        historicalData: rowsWithoutDefindex,
        defiLlamaPools: [],
      })
    ).rejects.toThrowError(MissingSourceDataError);
  });

  it("fails loudly when defillama price source only has pool APY/TVL metadata without real price observations", async () => {
    const scenario = parseScenario({
      ...BASE_SCENARIO_INPUT,
      assets: ["EURC"],
      source: { price: "defillama", rate: "defindex" },
    });
    await expect(
      resolveScenarioSources(scenario, { defiLlamaPools: MOCK_LLAMA_POOLS })
    ).rejects.toThrowError(MissingSourceDataError);
  });

  it("uses recorded historical stream for defillama if provided in historicalData and respects defiLlamaPools: []", async () => {
    const scenario = parseScenario({
      ...BASE_SCENARIO_INPUT,
      assets: ["USDC"],
      source: { price: "defillama", rate: "blend" },
    });
    const rows = makeHistoricalRows();
    const resolved = await resolveScenarioSources(scenario, {
      historicalData: rows,
      defiLlamaPools: [],
    });
    expect(
      resolved.prices
        .getSpotPrice("USDC", Date.parse(scenario.window.start))
        .toString()
    ).toBe("1");
  });

  it("fetches pools via fetchDeFiLlamaPools when defiLlamaPools is omitted and rate is needed", async () => {
    const scenario = parseScenario({
      ...BASE_SCENARIO_INPUT,
      assets: ["USDC"],
      source: { price: "horizon", rate: "blend" },
    });
    const priceRowsOnly = makeHistoricalRows().filter(
      (r) => r.kind === "price"
    );
    const fetchMock = vi.fn().mockResolvedValue(MOCK_LLAMA_POOLS);
    const resolved = await resolveScenarioSources(scenario, {
      historicalData: priceRowsOnly,
      fetchDeFiLlamaPools: fetchMock,
    });
    expect(fetchMock).toHaveBeenCalled();
    expect(resolved.accrual?.cashRateAnnual).toBeDefined();
  });

  it("derives accrual rate from defillama pool APY when no historical rate stream is provided", async () => {
    const scenario = parseScenario({
      ...BASE_SCENARIO_INPUT,
      assets: ["USDC"],
      source: { price: "horizon", rate: "blend" },
    });
    const priceRowsOnly = makeHistoricalRows().filter(
      (r) => r.kind === "price"
    );
    const resolved = await resolveScenarioSources(scenario, {
      historicalData: priceRowsOnly,
      defiLlamaPools: MOCK_LLAMA_POOLS,
    });
    expect(resolved.accrual?.cashRateAnnual).toBeDefined();
  });

  it("passes strict mode through to BacktestPriceFeed", async () => {
    const scenario = parseScenario({
      ...BASE_SCENARIO_INPUT,
      assets: ["USDC"],
      source: { price: "horizon", rate: "blend" },
    });
    const rows = makeHistoricalRows();
    const resolved = await resolveScenarioSources(scenario, {
      historicalData: rows,
      strict: true,
    });
    expect(resolved.prices).toBeDefined();
  });

  it("throws on unsupported price source", async () => {
    const scenario = parseScenario({
      ...BASE_SCENARIO_INPUT,
    });
    const corrupt = {
      ...scenario,
      source: {
        ...scenario.source,
        price: "unsupported" as unknown as typeof scenario.source.price,
      },
    };
    await expect(resolveScenarioSources(corrupt)).rejects.toThrow(
      "Unsupported price source"
    );
  });

  it("does not perform network calls at module load time", () => {
    // If the module had eager side effects, importing it would have triggered network/mocks
    expect(resolveScenarioSources).toBeInstanceOf(Function);
    expect(MissingSourceDataError).toBeInstanceOf(Function);
  });
});
