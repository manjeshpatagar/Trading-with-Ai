"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  BrainCircuit,
  Radio,
  RefreshCw,
  ScanLine,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { api, base, token } from "../lib/api";
import { ChartLevel, LiveChartTick, PriceChart } from "./chart";

type TradeRow = {
  instrumentKey: string;
  symbol: string;
  company: string;
  price: number;
  entry?: number | null;
  buyLevel?: number | null;
  sellLevel?: number | null;
  stopLoss?: number | null;
  target1?: number | null;
  target2?: number | null;
  target3?: number | null;
  confidence: number;
  trend: string;
  signal: string;
  lastUpdated: string;
  tradeStatus?: string | null;
  tradeId?: string | null;
  entryTriggeredAt?: string | null;
  target1At?: string | null;
  target2At?: string | null;
  target3At?: string | null;
  stopLossAt?: string | null;
  completedAt?: string | null;
  profitPercent?: number | null;
  riskLevel?: string;
  reason?: string;
  buyProbability?: number;
  sellProbability?: number;
  holdProbability?: number;
  changePercent?: number;
  rsi?: number | null;
  macd?: number | null;
  ema20?: number | null;
  ema50?: number | null;
  vwap?: number | null;
  volume?: number;
  patterns?: string[];
  indicators?: Record<string, any>;
  stopLossDecision?: {
    status: string;
    recoveryProbability: number;
    breakdownProbability: number;
    confidence: number;
    reason: string;
    recommendation: string;
    touchedAt: string;
    timeline: Array<{
      id: string;
      type: string;
      detail: string;
      value?: number | null;
      eventTime: string;
    }>;
  } | null;
};
type Analysis = {
  candles: Candle[];
  indicators: Record<string, any>;
  analysis: { signal: string; confidence: number; reason: string };
};
type Candle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
type PaperOrder = {
  id: string;
  instrumentKey: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  plannedEntry: number;
  entryPrice?: number | null;
  currentPrice: number;
  investment: number;
  pnl: number;
  pnlPercent: number;
  status: string;
  confidence: number;
  target: number;
  stopLoss: number;
  createdAt: string;
  entryTime?: string | null;
  exitTime?: string | null;
  exitPrice?: number | null;
  exitReason?: string | null;
  durationMinutes?: number | null;
};
type PaperDashboard = {
  account: {
    enabled: boolean;
    startingBalance: number;
    maxOpenTrades: number;
    minimumConfidence: number;
    riskPerTrade: number;
    allowAiWait: boolean;
    allowReentry: boolean;
  };
  summary: {
    virtualBalance: number;
    usedCapital: number;
    availableCapital: number;
    todayPnl: number;
    openPositions: number;
    closedTrades: number;
    winRate: number;
  };
  performance: Record<
    | "todayProfit"
    | "todayLoss"
    | "winningTrades"
    | "losingTrades"
    | "averageProfit"
    | "averageLoss"
    | "largestWin"
    | "largestLoss",
    number
  >;
  openPositions: PaperOrder[];
  waitingOrders: PaperOrder[];
  tradeHistory: PaperOrder[];
  riskManager: {
    timezone: "Asia/Kolkata";
    status: "OPEN" | "CLOSING SOON" | "AUTO EXIT RUNNING" | "MARKET CLOSED";
    serverTime: string;
    autoExitAt: string;
    nextSessionAt: string;
    canEnter: boolean;
    closingSoon: boolean;
    secondsUntilAutoExit: number;
    alert?: string | null;
  };
};

const money = (input: unknown) =>
  Number.isFinite(Number(input))
    ? `₹${Number(input).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
    : "—";
const display = (input: unknown, suffix = "") =>
  input !== null &&
  input !== undefined &&
  input !== "" &&
  (typeof input === "string" || Number.isFinite(Number(input)))
    ? `${input}${suffix}`
    : "Backend data unavailable";
const statusLabel = (status?: string | null) =>
  status ? status.replaceAll("_", " ") : "Waiting";
function Card({
  title,
  children,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`glass-card p-5 ${className}`}>
      <h2 className="text-sm font-extrabold text-white">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}
function Stat({
  label,
  value,
  tone = "",
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-700/70 bg-slate-950/25 p-3">
      <p className="metric-label">{label}</p>
      <p className={`mt-1 text-sm font-bold ${tone || "text-slate-100"}`}>
        {value}
      </p>
    </div>
  );
}

function StrategyTable({
  title,
  rows,
  side,
}: {
  title: string;
  rows: TradeRow[];
  side: "BUY" | "SELL";
}) {
  const tone = side === "BUY" ? "text-emerald-300" : "text-rose-300";
  return (
    <Card title={title}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1180px] text-left text-xs">
          <thead>
            <tr className="border-b border-slate-700 text-slate-500">
              {[
                "Rank",
                "Stock",
                "Current Price",
                "Entry",
                "Stop Loss",
                "Target 1",
                "Target 2",
                "Target 3",
                "Confidence",
                "Trend",
                "Signal Time",
                "Status",
              ].map((heading) => (
                <th
                  key={heading}
                  className="px-3 py-3 font-bold uppercase tracking-wide"
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={row.tradeId ?? row.instrumentKey}
                className="border-b border-slate-800/80 hover:bg-white/[.025]"
              >
                <td className="px-3 py-4 font-black text-slate-400">
                  {index + 1}
                </td>
                <td className="px-3 py-4">
                  <Link
                    href={`/trade-strategy/${encodeURIComponent(row.symbol)}`}
                    className="font-extrabold text-white hover:text-cyan-300"
                  >
                    {row.symbol}
                  </Link>
                  <p className="mt-1 max-w-40 truncate text-[10px] text-slate-500">
                    {row.company}
                  </p>
                </td>
                <td className="px-3 py-4 font-bold text-white">
                  {money(row.price)}
                </td>
                <td
                  className={`px-3 py-4 font-bold ${row.entryTriggeredAt ? "text-emerald-300" : tone}`}
                >
                  {money(
                    row.entry ??
                      (side === "BUY" ? row.buyLevel : row.sellLevel),
                  )}
                </td>
                <td className="px-3 py-4 font-bold text-rose-300">
                  {money(row.stopLoss)}
                </td>
                <td
                  className={`px-3 py-4 ${row.target1At ? "font-bold text-emerald-300" : ""}`}
                >
                  {money(row.target1)}
                </td>
                <td
                  className={`px-3 py-4 ${row.target2At ? "font-bold text-emerald-300" : ""}`}
                >
                  {money(row.target2)}
                </td>
                <td
                  className={`px-3 py-4 ${row.target3At ? "font-bold text-emerald-300" : ""}`}
                >
                  {money(row.target3)}
                </td>
                <td className="px-3 py-4 font-bold">
                  {display(row.confidence, "%")}
                </td>
                <td className={`px-3 py-4 font-bold ${tone}`}>
                  {display(row.trend)}
                </td>
                <td className="px-3 py-4 text-slate-400">
                  {row.lastUpdated
                    ? new Date(row.lastUpdated).toLocaleTimeString("en-IN")
                    : "—"}
                </td>
                <td className="px-3 py-4">
                  <span className="rounded-md border border-sky-400/20 bg-sky-400/10 px-2 py-1 font-bold text-sky-300">
                    {statusLabel(row.tradeStatus)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <div className="py-10 text-center text-sm text-slate-500">
            The backend returned no {side} signals for the current scan.
          </div>
        )}
      </div>
    </Card>
  );
}

export function TradeStrategyScanner({ session }: { session: string }) {
  const client = useQueryClient();
  const scan = useQuery({
    queryKey: ["trade-strategy-scan"],
    queryFn: () =>
      api<{ topBuy: TradeRow[]; topSell: TradeRow[]; scannerCount: number }>(
        "/dashboard",
      ),
    enabled: Boolean(session),
    retry: false,
    refetchInterval: 60_000,
  });
  useEffect(() => {
    if (!session) return;
    const socket = io(base, { auth: { token: token() }, reconnection: true });
    socket.on("market-price-updated", (tick: any) =>
      client.setQueryData<any>(["trade-strategy-scan"], (current: any) =>
        current
          ? {
              ...current,
              topBuy: current.topBuy.map((row: TradeRow) =>
                row.instrumentKey === tick.instrumentKey
                  ? { ...row, price: tick.ltp }
                  : row,
              ),
              topSell: current.topSell.map((row: TradeRow) =>
                row.instrumentKey === tick.instrumentKey
                  ? { ...row, price: tick.ltp }
                  : row,
              ),
            }
          : current,
      ),
    );
    socket.on(
      "signal-history-updated",
      () =>
        void client.invalidateQueries({ queryKey: ["trade-strategy-scan"] }),
    );
    socket.on(
      "paper-trading-updated",
      () => void client.invalidateQueries({ queryKey: ["paper-trading"] }),
    );
    return () => {
      socket.close();
    };
  }, [client, session]);
  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="section-eyebrow">UPSTOX · NSE EQUITIES · ₹60–₹600</p>
          <h1 className="text-3xl font-bold text-white">AI Trade Strategy</h1>
          <p className="mt-2 text-sm text-slate-400">
            Backend-ranked live setups. No synthetic prices, candles, or
            signals.
          </p>
        </div>
        <button
          onClick={() => void scan.refetch()}
          disabled={!session || scan.isFetching}
          className="primary-button"
        >
          <RefreshCw
            className={`h-4 w-4 ${scan.isFetching ? "animate-spin" : ""}`}
          />
          Scan market
        </button>
      </div>
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Stat
          label="Market scanner"
          value={
            scan.isFetching
              ? "Scanning NSE…"
              : scan.isSuccess
                ? "Live"
                : "Waiting"
          }
          tone="text-cyan-300"
        />
        <Stat
          label="Stocks calculated"
          value={scan.data?.scannerCount ?? "—"}
        />
        <Stat
          label="Live updates"
          value={
            <span className="flex items-center gap-2">
              <span className="live-dot" />
              WebSocket
            </span>
          }
          tone="text-emerald-300"
        />
      </div>
      {scan.isError && (
        <div className="glass-card mb-5 border-rose-400/20 p-5 text-sm text-rose-200">
          {scan.error.message}
        </div>
      )}
      {!session && (
        <div className="glass-card mb-5 p-5 text-sm text-amber-200">
          Connect Upstox from the header to start the authenticated scanner.
        </div>
      )}
      <div className="space-y-5">
        <StrategyTable
          title="TOP 10 BUY"
          side="BUY"
          rows={scan.data?.topBuy ?? []}
        />
        <StrategyTable
          title="TOP 10 SELL"
          side="SELL"
          rows={scan.data?.topSell ?? []}
        />
      </div>
      <PaperTradingSection
        session={session}
        scannerRows={[
          ...(scan.data?.topBuy ?? []),
          ...(scan.data?.topSell ?? []),
        ]}
      />
    </div>
  );
}

function PaperTradingSection({
  session,
  scannerRows,
}: {
  session: string;
  scannerRows: TradeRow[];
}) {
  const client = useQueryClient();
  const paper = useQuery({
    queryKey: ["paper-trading"],
    queryFn: () => api<PaperDashboard>("/paper-trading"),
    enabled: Boolean(session),
    retry: false,
    refetchInterval: 15_000,
  });
  const [settings, setSettings] = useState<PaperDashboard["account"] | null>(
    null,
  );
  const [confirmTrade, setConfirmTrade] = useState(false);
  const [startingTrade, setStartingTrade] = useState(false);
  const [tradeError, setTradeError] = useState("");
  useEffect(() => {
    if (paper.data) setSettings(paper.data.account);
  }, [paper.data]);
  const refresh = () =>
    void client.invalidateQueries({ queryKey: ["paper-trading"] });
  const save = async () => {
    if (settings) {
      await api("/paper-trading/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      refresh();
    }
  };
  const exit = async (id: string) => {
    await api(`/paper-trading/orders/${encodeURIComponent(id)}/exit`, {
      method: "POST",
    });
    refresh();
  };
  const startTrade = async (instrumentKey: string) => {
    setStartingTrade(true);
    setTradeError("");
    try {
      await api("/paper-trading/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instrumentKey }),
      });
      setConfirmTrade(false);
      refresh();
    } catch (error) {
      setTradeError(
        error instanceof Error ? error.message : "Unable to start paper trade.",
      );
    } finally {
      setStartingTrade(false);
    }
  };
  if (!session) return null;
  if (paper.isError)
    return (
      <section className="mt-8">
        <Card title="AI Paper Trading">
          <p className="text-sm text-rose-200">{paper.error.message}</p>
        </Card>
      </section>
    );
  const data = paper.data;
  if (!data)
    return (
      <section className="mt-8">
        <Card title="AI Paper Trading">
          <p className="text-sm text-slate-400">Loading paper account…</p>
        </Card>
      </section>
    );
  const active = [...data.openPositions, ...data.waitingOrders];
  const rowsByInstrument = new Map(
    scannerRows.map((row) => [row.instrumentKey, row]),
  );
  const previouslyTraded = new Set(
    [...data.openPositions, ...data.waitingOrders, ...data.tradeHistory].map(
      (order) => order.instrumentKey,
    ),
  );
  const activeCount = active.length;
  const availableSlots = Math.max(
    0,
    data.account.maxOpenTrades - activeCount,
  );
  const bestNextTrade =
    availableSlots > 0
      ? scannerRows
          .filter(
            (row) =>
              !previouslyTraded.has(row.instrumentKey) &&
              ["BUY", "SELL"].includes(row.signal) &&
              row.confidence >= data.account.minimumConfidence &&
              Number.isFinite(Number(row.price)) &&
              Number.isFinite(Number(row.entry)) &&
              Number.isFinite(Number(row.stopLoss)) &&
              Number.isFinite(Number(row.target3)) &&
              !["HIGH", "EXTREME"].includes(
                String(row.riskLevel ?? "").toUpperCase(),
              ) &&
              !["HOLD", "NEUTRAL"].includes(row.trend.toUpperCase()),
          )
          .sort((left, right) => right.confidence - left.confidence)[0]
      : undefined;
  const roi = data.account.startingBalance
    ? (data.summary.todayPnl / data.account.startingBalance) * 100
    : 0;
  const buyCapital = data.openPositions
    .filter((order) => order.side === "BUY")
    .reduce((sum, order) => sum + order.investment, 0);
  const sellCapital = data.openPositions
    .filter((order) => order.side === "SELL")
    .reduce((sum, order) => sum + order.investment, 0);
  const cash = Math.max(0, data.summary.availableCapital);
  const allocationTotal = Math.max(1, cash + buyCapital + sellCapital);
  const grossProfit = data.tradeHistory
    .filter((order) => order.pnl > 0)
    .reduce((sum, order) => sum + order.pnl, 0);
  const grossLoss = Math.abs(
    data.tradeHistory
      .filter((order) => order.pnl < 0)
      .reduce((sum, order) => sum + order.pnl, 0),
  );
  const profitFactor = grossLoss
    ? grossProfit / grossLoss
    : grossProfit
      ? Infinity
      : 0;
  const riskReward = data.performance.averageLoss
    ? data.performance.averageProfit / data.performance.averageLoss
    : 0;
  const liveProfit = data.openPositions
    .filter((order) => order.pnl > 0)
    .reduce((sum, order) => sum + order.pnl, 0);
  const liveLoss = Math.abs(
    data.openPositions
      .filter((order) => order.pnl < 0)
      .reduce((sum, order) => sum + order.pnl, 0),
  );
  const netPnl = liveProfit - liveLoss;
  const currentPortfolioValue = data.openPositions.reduce(
    (sum, order) => sum + order.investment + order.pnl,
    0,
  );
  const timeline = [
    ...data.waitingOrders.map((order) => ({
      time: order.createdAt,
      tone: "orange",
      text: `${order.side} ${order.symbol} waiting for entry`,
    })),
    ...data.openPositions.map((order) => ({
      time: order.entryTime!,
      tone: order.pnl >= 0 ? "green" : "red",
      text: `${order.side} ${order.symbol} executed at ${money(order.entryPrice)}`,
    })),
    ...data.tradeHistory.map((order) => ({
      time: order.exitTime!,
      tone: order.pnl >= 0 ? "green" : "red",
      text: `${order.symbol} closed · ${order.exitReason}`,
    })),
  ]
    .filter((event) => event.time)
    .sort(
      (left, right) =>
        new Date(right.time).getTime() - new Date(left.time).getTime(),
    );
  const summary = [
    ["Virtual Balance", money(data.summary.virtualBalance)],
    ["Used Capital", money(data.summary.usedCapital)],
    ["Available Capital", money(data.summary.availableCapital)],
    ["Today's P&L", money(data.summary.todayPnl)],
    ["Open Positions", data.summary.openPositions],
    ["Closed Trades", data.summary.closedTrades],
    ["Win Rate", `${data.summary.winRate.toFixed(1)}%`],
  ];
  const metrics = [
    ["Today's Profit", money(data.performance.todayProfit)],
    ["Today's Loss", money(data.performance.todayLoss)],
    ["Winning Trades", data.performance.winningTrades],
    ["Losing Trades", data.performance.losingTrades],
    ["Average Profit", money(data.performance.averageProfit)],
    ["Average Loss", money(data.performance.averageLoss)],
    ["Largest Win", money(data.performance.largestWin)],
    ["Largest Loss", money(data.performance.largestLoss)],
  ];
  return (
    <section className="mt-10 space-y-6 rounded-2xl border border-slate-800/80 bg-[#080d18]/70 p-4 shadow-2xl shadow-black/30 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="section-eyebrow">PAPER EXECUTION · LIVE DATA</p>
          <h2 className="text-2xl font-black tracking-tight text-white">
            AI Paper Trading
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Virtual trading using live Upstox market data.
          </p>
        </div>
        <StatusBadge status={data.account.enabled ? "LIVE" : "OFF"} />
      </div>
      <div className="hidden">
        {summary.map(([label, value]) => (
          <Stat key={String(label)} label={String(label)} value={value} />
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-9">
        <TerminalMetric
          label="Virtual Balance"
          value={money(data.summary.virtualBalance)}
          tone="green"
          icon="₹"
        />
        <TerminalMetric
          label="Available Capital"
          value={money(data.summary.availableCapital)}
          tone="green"
          icon="◈"
        />
        <TerminalMetric
          label="Used Capital"
          value={money(data.summary.usedCapital)}
          tone="blue"
          icon="▣"
        />
        <TerminalMetric
          label="Real-time Total Profit"
          value={money(liveProfit)}
          tone="green"
          icon="↗"
        />
        <TerminalMetric
          label="Real-time Total Loss"
          value={money(liveLoss)}
          tone="red"
          icon="↘"
        />
        <TerminalMetric
          label="Net P&L"
          value={`${netPnl >= 0 ? "+" : ""}${money(netPnl)}`}
          tone={netPnl >= 0 ? "green" : "red"}
          icon="◎"
        />
        <TerminalMetric
          label="ROI"
          value={`${roi >= 0 ? "+" : ""}${roi.toFixed(2)}%`}
          tone={roi >= 0 ? "green" : "red"}
          icon="◆"
        />
        <TerminalMetric
          label="Winning Trades"
          value={String(data.performance.winningTrades)}
          tone="green"
          icon="↑"
        />
        <TerminalMetric
          label="Losing Trades"
          value={String(data.performance.losingTrades)}
          tone="red"
          icon="↓"
        />
      </div>
      <TerminalPanel title="Portfolio Summary">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {[
            ["Total Invested", money(data.summary.usedCapital), "text-sky-300"],
            [
              "Current Portfolio Value",
              money(currentPortfolioValue),
              "text-white",
            ],
            ["Total Unrealized Profit", money(liveProfit), "text-emerald-300"],
            ["Total Unrealized Loss", money(liveLoss), "text-rose-300"],
            [
              "Cash Available",
              money(data.summary.availableCapital),
              "text-emerald-300",
            ],
          ].map(([label, value, tone]) => (
            <div
              key={String(label)}
              className="rounded-xl border border-slate-800 bg-slate-950/40 p-4"
            >
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                {label}
              </p>
              <p className={`mt-2 text-lg font-black tabular-nums ${tone}`}>
                {value}
              </p>
            </div>
          ))}
        </div>
      </TerminalPanel>
      <RiskManagerWidget risk={data.riskManager} />
      <AvailableTradeSlotsCard
        account={data.account}
        activeCount={activeCount}
        availableSlots={availableSlots}
        candidate={bestNextTrade}
        availableCapital={data.summary.availableCapital}
        marketCanEnter={data.riskManager.canEnter}
        marketStatus={data.riskManager.status}
        onTrade={() => {
          setTradeError("");
          setConfirmTrade(true);
        }}
      />
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-extrabold text-white">Live Positions</h3>
          <span className="text-xs text-slate-500">
            {active.length} tracked orders
          </span>
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          {active.map((order) => (
            <PaperTradeCard
              key={order.id}
              order={order}
              scanner={rowsByInstrument.get(order.instrumentKey)}
              closingSoon={data.riskManager.closingSoon}
              onExit={exit}
            />
          ))}
        </div>
        {!active.length && (
          <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/30 py-12 text-center text-sm text-slate-500">
            No live paper orders meet the configured confidence threshold.
          </div>
        )}
      </div>
      {confirmTrade && bestNextTrade && (
        <TradeConfirmationDialog
          candidate={bestNextTrade}
          account={data.account}
          availableCapital={data.summary.availableCapital}
          pending={startingTrade}
          error={tradeError}
          onCancel={() => setConfirmTrade(false)}
          onConfirm={() => void startTrade(bestNextTrade.instrumentKey)}
        />
      )}
      <div className="grid gap-5 xl:grid-cols-[.8fr_1.2fr]">
        <TerminalPanel title="Live Portfolio Allocation">
          <p className="text-2xl font-black text-white">
            {money(data.summary.virtualBalance)}
          </p>
          <p className="mb-5 text-xs text-slate-500">Total capital</p>
          <AllocationBar
            label="Cash"
            value={(cash / allocationTotal) * 100}
            color="bg-emerald-400"
          />
          <AllocationBar
            label="BUY"
            value={(buyCapital / allocationTotal) * 100}
            color="bg-cyan-400"
          />
          <AllocationBar
            label="SELL"
            value={(sellCapital / allocationTotal) * 100}
            color="bg-rose-400"
          />
        </TerminalPanel>
        <TerminalPanel title="Trade Performance">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              [
                "Winning Trades",
                data.performance.winningTrades,
                "text-emerald-300",
              ],
              ["Losing Trades", data.performance.losingTrades, "text-rose-300"],
              [
                "Average Profit",
                money(data.performance.averageProfit),
                "text-emerald-300",
              ],
              [
                "Average Loss",
                money(data.performance.averageLoss),
                "text-rose-300",
              ],
              [
                "Largest Win",
                money(data.performance.largestWin),
                "text-emerald-300",
              ],
              [
                "Largest Loss",
                money(data.performance.largestLoss),
                "text-rose-300",
              ],
              ["Risk Reward Ratio", riskReward.toFixed(2), "text-sky-300"],
              [
                "Profit Factor",
                Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : "∞",
                "text-violet-300",
              ],
            ].map(([label, value, tone]) => (
              <div
                key={String(label)}
                className="rounded-xl border border-slate-800 bg-slate-950/40 p-3"
              >
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  {label}
                </p>
                <p className={`mt-2 text-lg font-black ${tone}`}>{value}</p>
              </div>
            ))}
          </div>
        </TerminalPanel>
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <TerminalPanel title="Live Trade Timeline">
          <div className="max-h-80 space-y-4 overflow-y-auto pr-2">
            {timeline.slice(0, 30).map((event, index) => (
              <div
                key={`${event.time}-${index}`}
                className={`border-l-2 pl-4 ${event.tone === "green" ? "border-emerald-400" : event.tone === "red" ? "border-rose-400" : "border-orange-400"}`}
              >
                <p className="text-[10px] font-bold text-slate-500">
                  {new Date(event.time).toLocaleTimeString("en-IN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
                <p className="mt-1 text-sm font-semibold text-slate-200">
                  {event.text}
                </p>
              </div>
            ))}
            {!timeline.length && (
              <p className="text-sm text-slate-500">
                Timeline will populate from real paper-order events.
              </p>
            )}
          </div>
        </TerminalPanel>
        <TerminalPanel title="AI Recommendations">
          <div className="space-y-3">
            {active.map((order) => {
              const row = rowsByInstrument.get(order.instrumentKey);
              const recovery = row
                ? Number(
                    order.side === "BUY"
                      ? row.buyProbability
                      : row.sellProbability,
                  )
                : null;
              const recommendation =
                row?.signal ??
                (order.status === "WAITING" ? "WAIT" : "MONITOR");
              return (
                <RecommendationCard
                  key={order.id}
                  order={order}
                  row={row}
                  recommendation={recommendation}
                  recovery={recovery}
                />
              );
            })}
            {!active.length && (
              <p className="text-sm text-slate-500">
                Recommendations appear for live paper orders.
              </p>
            )}
          </div>
        </TerminalPanel>
      </div>
      <Card title="Open Positions" className="hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-left text-xs">
            <thead>
              <tr className="border-b border-slate-700 text-slate-500">
                {[
                  "Stock",
                  "Side",
                  "Quantity",
                  "Entry",
                  "Current Price",
                  "Investment",
                  "Current Value",
                  "PnL ₹",
                  "PnL %",
                  "Status",
                  "Action",
                ].map((heading) => (
                  <th key={heading} className="px-3 py-3 uppercase">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {active.map((order) => (
                <tr key={order.id} className="border-b border-slate-800">
                  <td className="px-3 py-3 font-bold text-white">
                    {order.symbol}
                  </td>
                  <td
                    className={`px-3 py-3 font-bold ${order.side === "BUY" ? "text-emerald-300" : "text-rose-300"}`}
                  >
                    {order.side}
                  </td>
                  <td className="px-3 py-3">{order.quantity}</td>
                  <td className="px-3 py-3">
                    {money(order.entryPrice ?? order.plannedEntry)}
                  </td>
                  <td className="px-3 py-3">{money(order.currentPrice)}</td>
                  <td className="px-3 py-3">{money(order.investment)}</td>
                  <td className="px-3 py-3">
                    {money(order.investment + order.pnl)}
                  </td>
                  <td className="px-3 py-3">{money(order.pnl)}</td>
                  <td className="px-3 py-3">{order.pnlPercent.toFixed(2)}%</td>
                  <td className="px-3 py-3">{order.status}</td>
                  <td className="px-3 py-3">
                    {order.status === "OPEN" ? (
                      <button
                        onClick={() => void exit(order.id)}
                        className="rounded-md border border-rose-400/30 px-2 py-1 font-bold text-rose-300"
                      >
                        Exit Trade
                      </button>
                    ) : (
                      "Waiting for entry"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!active.length && (
            <p className="py-8 text-center text-sm text-slate-500">
              No paper orders meet the configured confidence threshold.
            </p>
          )}
        </div>
      </Card>
      <Card title="Trade History">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1250px] text-left text-xs">
            <thead>
              <tr className="border-b border-slate-700 text-slate-500">
                {[
                  "Entry Time",
                  "Exit Time",
                  "Stock",
                  "BUY / SELL",
                  "Entry Price",
                  "Exit Price",
                  "Quantity",
                  "PnL ₹",
                  "PnL %",
                  "Exit Reason",
                  "Duration",
                ].map((heading) => (
                  <th key={heading} className="px-3 py-3 uppercase">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.tradeHistory.map((order) => (
                <tr key={order.id} className="border-b border-slate-800">
                  <td className="px-3 py-3">
                    {order.entryTime
                      ? new Date(order.entryTime).toLocaleString("en-IN")
                      : "—"}
                  </td>
                  <td className="px-3 py-3">
                    {order.exitTime
                      ? new Date(order.exitTime).toLocaleString("en-IN")
                      : "—"}
                  </td>
                  <td className="px-3 py-3 font-bold text-white">
                    {order.symbol}
                  </td>
                  <td className="px-3 py-3">{order.side}</td>
                  <td className="px-3 py-3">{money(order.entryPrice)}</td>
                  <td className="px-3 py-3">{money(order.exitPrice)}</td>
                  <td className="px-3 py-3">{order.quantity}</td>
                  <td className="px-3 py-3">{money(order.pnl)}</td>
                  <td className="px-3 py-3">{order.pnlPercent.toFixed(2)}%</td>
                  <td className="px-3 py-3">{order.exitReason}</td>
                  <td className="px-3 py-3">
                    {Number.isFinite(Number(order.durationMinutes))
                      ? `${order.durationMinutes} min`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.tradeHistory.length && (
            <p className="py-8 text-center text-sm text-slate-500">
              No closed paper trades yet.
            </p>
          )}
        </div>
      </Card>
      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="Paper Trading Performance">
          <div className="grid grid-cols-2 gap-3">
            {metrics.map(([label, value]) => (
              <Stat key={String(label)} label={String(label)} value={value} />
            ))}
          </div>
        </Card>
        {settings && (
          <Card title="Settings">
            <div className="grid grid-cols-2 gap-3 text-xs">
              <SettingToggle
                label="Paper Trading"
                value={settings.enabled}
                onChange={(value) =>
                  setSettings({ ...settings, enabled: value })
                }
              />
              {(
                [
                  ["Starting Balance", "startingBalance"],
                  ["Max Open Trades", "maxOpenTrades"],
                  ["Minimum Confidence", "minimumConfidence"],
                  ["Risk Per Trade", "riskPerTrade"],
                ] as const
              ).map(([label, key]) => (
                <label key={key} className="text-slate-400">
                  {label}
                  <input
                    type="number"
                    value={settings[key]}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        [key]: Number(event.target.value),
                      })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-white"
                  />
                </label>
              ))}
              <SettingToggle
                label="Allow AI Wait"
                value={settings.allowAiWait}
                onChange={(value) =>
                  setSettings({ ...settings, allowAiWait: value })
                }
              />
              <SettingToggle
                label="Allow Re-entry"
                value={settings.allowReentry}
                onChange={(value) =>
                  setSettings({ ...settings, allowReentry: value })
                }
              />
            </div>
            <button onClick={() => void save()} className="primary-button mt-4">
              Save Settings
            </button>
          </Card>
        )}
      </div>
    </section>
  );
}

function TerminalMetric({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: string;
  tone: "green" | "red" | "blue" | "purple";
  icon: string;
}) {
  const colors = {
    green: "border-emerald-400/20 text-emerald-300",
    red: "border-rose-400/20 text-rose-300",
    blue: "border-sky-400/20 text-sky-300",
    purple: "border-violet-400/20 text-violet-300",
  };
  return (
    <div
      className={`rounded-xl border bg-gradient-to-br from-slate-900 to-slate-950 p-4 shadow-lg transition-all duration-300 hover:-translate-y-0.5 ${colors[tone]}`}
    >
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
          {label}
        </p>
        <span className="text-lg">{icon}</span>
      </div>
      <p className="mt-3 text-xl font-black tabular-nums">{value}</p>
    </div>
  );
}

function CircleMetric({
  label,
  value,
  signed = false,
}: {
  label: string;
  value: number;
  signed?: boolean;
}) {
  const progress = Math.min(100, Math.max(0, signed ? Math.abs(value) : value));
  const color = signed && value < 0 ? "#fb7185" : "#34d399";
  return (
    <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/70 p-3">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
          {label}
        </p>
        <p className="mt-1 font-black text-white">
          {signed && value > 0 ? "+" : ""}
          {value.toFixed(2)}%
        </p>
      </div>
      <svg viewBox="0 0 42 42" className="h-12 w-12 -rotate-90">
        <circle
          cx="21"
          cy="21"
          r="16"
          fill="none"
          stroke="#1e293b"
          strokeWidth="4"
        />
        <circle
          cx="21"
          cy="21"
          r="16"
          fill="none"
          stroke={color}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${progress} ${100 - progress}`}
          pathLength="100"
          className="transition-all duration-700"
        />
      </svg>
    </div>
  );
}

function TerminalPanel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-800 bg-[#0d1422]/90 p-5 shadow-xl shadow-black/20">
      <h3 className="text-sm font-extrabold text-white">{title}</h3>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function AllocationBar({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="mb-4">
      <div className="mb-1.5 flex justify-between text-xs">
        <span className="font-bold text-slate-300">{label}</span>
        <span className="tabular-nums text-slate-500">{value.toFixed(1)}%</span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-slate-800">
        <div
          className={`h-full rounded-full transition-all duration-700 ${color}`}
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const normalized = status.toUpperCase();
  const tone = /BUY|COMPLETED|TARGET|READY/.test(normalized)
    ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
    : /SELL|EXIT|STOP|FULL|MARKET CLOSED/.test(normalized)
      ? "border-rose-400/30 bg-rose-400/10 text-rose-300"
      : /OPEN|RUNNING|LIVE/.test(normalized)
        ? "border-sky-400/30 bg-sky-400/10 text-sky-300"
        : "border-orange-400/30 bg-orange-400/10 text-orange-300";
  return (
    <span
      className={`rounded-full border px-2.5 py-1 text-[10px] font-black ${tone}`}
    >
      {normalized}
    </span>
  );
}

function RiskManagerWidget({
  risk,
}: {
  risk: PaperDashboard["riskManager"];
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const serverOffset = new Date(risk.serverTime).getTime() - Date.now();
    setNow(Date.now() + serverOffset);
    const timer = window.setInterval(
      () => setNow(Date.now() + serverOffset),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, [risk.serverTime]);
  const remaining = Math.max(
    0,
    Math.floor((new Date(risk.autoExitAt).getTime() - now) / 1_000),
  );
  const countdown = [Math.floor(remaining / 3600), Math.floor((remaining % 3600) / 60), remaining % 60]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
  return (
    <TerminalPanel title="EOD Risk Manager">
      <div className="flex flex-wrap items-center justify-between gap-5">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Market Status
          </p>
          <div className="mt-2">
            <StatusBadge status={risk.status} />
          </div>
          {risk.status === "MARKET CLOSED" && (
            <p className="mt-3 text-sm text-slate-300">
              Next Session:{" "}
              {new Date(risk.nextSessionAt).toLocaleString("en-IN", {
                timeZone: "Asia/Kolkata",
                weekday: "long",
                hour: "2-digit",
                minute: "2-digit",
              })}{" "}
              IST
            </p>
          )}
        </div>
        <div className="text-right">
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Auto Exit in
          </p>
          <p className="mt-1 font-mono text-3xl font-black tabular-nums text-orange-300">
            {risk.status === "MARKET CLOSED" ? "00:00:00" : countdown}
          </p>
          <p className="mt-1 text-[10px] text-slate-500">
            Server time · Asia/Kolkata
          </p>
        </div>
      </div>
      {risk.alert && (
        <p className="mt-4 rounded-lg border border-rose-400/25 bg-rose-400/10 p-3 text-sm text-rose-200">
          Live exit alert: {risk.alert}
        </p>
      )}
    </TerminalPanel>
  );
}

function paperTradeSizing(
  candidate: TradeRow,
  account: PaperDashboard["account"],
) {
  const entry = Number(candidate.entry);
  const stopLoss = Number(candidate.stopLoss);
  const target3 = Number(candidate.target3);
  const recommendedInvestment =
    (account.startingBalance * 0.9) / Math.min(account.maxOpenTrades, 4);
  const budgetQuantity =
    entry > 0 ? Math.floor(recommendedInvestment / entry) : 0;
  const riskPerShare = Math.abs(entry - stopLoss);
  const riskCapital =
    (account.startingBalance * account.riskPerTrade) / 100;
  const riskQuantity =
    riskPerShare > 0 ? Math.floor(riskCapital / riskPerShare) : budgetQuantity;
  const quantity = Math.max(0, Math.min(budgetQuantity, riskQuantity));
  const expectedRisk = riskPerShare * quantity;
  const expectedReward = Math.abs(target3 - entry) * quantity;
  return {
    entry,
    stopLoss,
    recommendedInvestment,
    quantity,
    expectedRisk,
    expectedReward,
    riskReward: expectedRisk > 0 ? expectedReward / expectedRisk : 0,
  };
}

function AvailableTradeSlotsCard({
  account,
  activeCount,
  availableSlots,
  candidate,
  availableCapital,
  marketCanEnter,
  marketStatus,
  onTrade,
}: {
  account: PaperDashboard["account"];
  activeCount: number;
  availableSlots: number;
  candidate?: TradeRow;
  availableCapital: number;
  marketCanEnter: boolean;
  marketStatus: PaperDashboard["riskManager"]["status"];
  onTrade: () => void;
}) {
  const full = availableSlots === 0;
  const sizing = candidate ? paperTradeSizing(candidate, account) : null;
  const recovery = candidate
    ? Number(
        candidate.signal === "BUY"
          ? candidate.buyProbability
          : candidate.sellProbability,
      )
    : Number.NaN;
  const canTrade =
    marketCanEnter &&
    !full &&
    Boolean(candidate) &&
    Boolean(sizing?.quantity) &&
    Number.isFinite(availableCapital) &&
    availableCapital >= Number(sizing?.entry);
  const status = full ? "FULL" : candidate ? "READY" : "WAITING";

  return (
    <TerminalPanel title="Available Trade Slots">
      <div className="grid gap-5 xl:grid-cols-[.34fr_1fr]">
        <div className="rounded-xl border border-slate-800 bg-slate-950/45 p-5">
          <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-1">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Open Trades
              </p>
              <p className="mt-1 text-2xl font-black text-white">
                {activeCount} / {account.maxOpenTrades}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Available Slots
              </p>
              <p className="mt-1 text-2xl font-black text-sky-300">
                {availableSlots}
              </p>
            </div>
            <div>
              <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Status
              </p>
              <StatusBadge status={status} />
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-gradient-to-br from-[#101827] to-[#090e18] p-5">
          <p className="text-[10px] font-bold uppercase tracking-[.16em] text-slate-500">
            Best Next Trade
          </p>
          {full ? (
            <div className="mt-4">
              <p className="text-lg font-black text-rose-300">
                Maximum open trades reached.
              </p>
            </div>
          ) : candidate && sizing ? (
            <>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <StatusBadge status={candidate.signal} />
                <p className="text-2xl font-black text-white">
                  {candidate.symbol}
                </p>
                <span className="text-sm font-bold text-cyan-300">
                  {candidate.confidence}% confidence
                </span>
              </div>
              <div className="mt-5 grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
                {[
                  ["Current Price", money(candidate.price)],
                  ["Entry", money(sizing.entry)],
                  ["Stop Loss", money(sizing.stopLoss)],
                  ["Target 1", money(candidate.target1)],
                  ["Target 2", money(candidate.target2)],
                  ["Target 3", money(candidate.target3)],
                  [
                    "Recommended Investment",
                    money(sizing.recommendedInvestment),
                  ],
                  ["Quantity", `${sizing.quantity} Shares`],
                  ["Expected Risk", money(sizing.expectedRisk)],
                  ["Expected Reward", money(sizing.expectedReward)],
                  [
                    "Risk Reward Ratio",
                    `1 : ${sizing.riskReward.toFixed(1)}`,
                  ],
                  [
                    "Recovery Probability",
                    Number.isFinite(recovery) ? `${recovery}%` : "—",
                  ],
                  ["Trend", candidate.trend],
                  ["AI Recommendation", "HIGH CONFIDENCE"],
                ].map(([label, value]) => (
                  <div key={String(label)}>
                    <p className="text-[9px] font-bold uppercase tracking-wider text-slate-500">
                      {label}
                    </p>
                    <p
                      className={`mt-1 font-black tabular-nums ${label === "Stop Loss" || label === "Expected Risk" ? "text-rose-300" : label === "Expected Reward" || label === "AI Recommendation" ? "text-emerald-300" : "text-slate-100"}`}
                    >
                      {value}
                    </p>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="mt-4">
              <p className="text-lg font-black text-orange-300">
                No High-Confidence Trade Available
              </p>
              <p className="mt-4 text-xs font-bold uppercase text-slate-500">
                Recommendation
              </p>
              <p className="mt-1 text-sm text-slate-200">
                Wait for the next scanner update.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-4">
                <div>
                  <p className="text-[10px] uppercase text-slate-500">
                    Recovery Probability
                  </p>
                  <p className="mt-1 font-black text-slate-400">--</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase text-slate-500">
                    Confidence
                  </p>
                  <p className="mt-1 font-black text-slate-400">--</p>
                </div>
              </div>
              <p className="mt-4 text-sm text-slate-400">
                No stock currently satisfies the minimum confidence, trend, and
                risk requirements.
              </p>
            </div>
          )}
          <button
            type="button"
            disabled={!canTrade}
            onClick={onTrade}
            className="mt-6 min-h-12 w-full rounded-lg bg-emerald-500 px-5 text-sm font-black text-slate-950 shadow-lg shadow-emerald-950/40 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400 disabled:shadow-none"
          >
            {canTrade
              ? "Trade Now"
              : !marketCanEnter
                ? "Market Closed"
                : full
                  ? "Trade Now"
                  : "Waiting for Opportunity"}
          </button>
          {!marketCanEnter && (
            <p className="mt-2 text-center text-xs text-slate-500">
              {marketStatus === "CLOSING SOON"
                ? "New entries closed at 03:15 PM IST."
                : "Auto Entry is disabled until the next market session."}
            </p>
          )}
        </div>
      </div>
    </TerminalPanel>
  );
}

function TradeConfirmationDialog({
  candidate,
  account,
  availableCapital,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  candidate: TradeRow;
  account: PaperDashboard["account"];
  availableCapital: number;
  pending: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const sizing = paperTradeSizing(candidate, account);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="paper-trade-confirmation-title"
      className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !pending) onCancel();
      }}
    >
      <div className="w-full max-w-lg rounded-2xl border border-slate-700 bg-[#0d1422] p-6 shadow-2xl shadow-black">
        <p className="section-eyebrow">AI RECOMMENDED TRADE</p>
        <h3
          id="paper-trade-confirmation-title"
          className="mt-1 text-xl font-black text-white"
        >
          Confirm Paper Trade
        </h3>
        <div className="mt-5 flex items-center gap-2">
          <StatusBadge status={candidate.signal} />
          <span className="text-xl font-black text-white">
            {candidate.symbol}
          </span>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-4 rounded-xl border border-slate-800 bg-slate-950/40 p-4 sm:grid-cols-3">
          {[
            ["Confidence", `${candidate.confidence}%`],
            ["Entry", money(sizing.entry)],
            ["Stop Loss", money(sizing.stopLoss)],
            ["Target 1", money(candidate.target1)],
            ["Target 2", money(candidate.target2)],
            ["Target 3", money(candidate.target3)],
            ["Investment", money(sizing.recommendedInvestment)],
            ["Quantity", `${sizing.quantity} Shares`],
            ["Cash Available", money(availableCapital)],
          ].map(([label, value]) => (
            <div key={String(label)}>
              <p className="text-[9px] font-bold uppercase tracking-wider text-slate-500">
                {label}
              </p>
              <p className="mt-1 font-black text-slate-100">{value}</p>
            </div>
          ))}
        </div>
        {error && (
          <p className="mt-4 rounded-lg border border-rose-400/20 bg-rose-400/10 p-3 text-sm text-rose-200">
            {error}
          </p>
        )}
        <div className="mt-6 flex gap-3">
          <button
            type="button"
            disabled={pending}
            onClick={onCancel}
            className="min-h-11 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-4 text-sm font-bold text-slate-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={onConfirm}
            className="min-h-11 flex-1 rounded-lg bg-emerald-500 px-4 text-sm font-black text-slate-950 disabled:opacity-50"
          >
            {pending ? "Starting…" : "Start Trade"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PaperTradeCard({
  order,
  scanner,
  closingSoon,
  onExit,
}: {
  order: PaperOrder;
  scanner?: TradeRow;
  closingSoon: boolean;
  onExit: (id: string) => Promise<void>;
}) {
  const previousPnl = useRef(order.pnl);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (order.pnl !== previousPnl.current) {
      setFlash(order.pnl > previousPnl.current ? "up" : "down");
      previousPnl.current = order.pnl;
      const timer = window.setTimeout(() => setFlash(null), 500);
      return () => window.clearTimeout(timer);
    }
  }, [order.pnl]);
  const positive = order.pnl >= 0;
  const entry = Number(order.entryPrice ?? order.plannedEntry);
  const targets = [
    scanner?.target1,
    scanner?.target2,
    scanner?.target3 ?? order.target,
  ]
    .filter((value): value is number => Number.isFinite(Number(value)))
    .map(Number);
  const finalTarget = targets.at(-1) ?? order.target;
  const progress =
    finalTarget === entry
      ? 0
      : Math.min(
          100,
          Math.max(
            0,
            ((order.currentPrice - entry) / (finalTarget - entry)) * 100,
          ),
        );
  const recovery = scanner
    ? Number(
        order.side === "BUY" ? scanner.buyProbability : scanner.sellProbability,
      )
    : null;
  const recommendation =
    scanner?.stopLossDecision?.recommendation?.toUpperCase() ??
    (order.status === "WAITING"
      ? "WAIT"
      : scanner?.signal === "BUY"
        ? "BUY"
        : scanner?.signal === "EXIT"
          ? "EXIT"
          : "WAIT");
  const currentValue = order.investment + order.pnl;
  const enteredAt = order.entryTime ? new Date(order.entryTime) : null;
  const durationMs = enteredAt
    ? Math.max(0, Date.now() - enteredAt.getTime())
    : 0;
  const durationMinutes = Math.floor(durationMs / 60_000);
  const duration = enteredAt
    ? durationMinutes >= 60
      ? `${Math.floor(durationMinutes / 60)}h ${durationMinutes % 60}m`
      : `${durationMinutes}m`
    : "Not entered";
  const status =
    order.status === "OPEN"
      ? "RUNNING"
      : order.status === "CLOSED"
        ? order.exitReason?.includes("STOP")
          ? "STOP LOSS"
          : "COMPLETED"
        : "WAITING";
  return (
    <article
      className={`relative overflow-hidden rounded-2xl border border-slate-800 bg-gradient-to-br from-[#111a2b] to-[#090e19] p-5 shadow-xl transition-all duration-300 ${positive ? "border-l-4 border-l-emerald-400 shadow-emerald-950/20" : "border-l-4 border-l-rose-400 shadow-rose-950/20"} ${flash === "up" ? "ring-2 ring-emerald-400/50" : flash === "down" ? "ring-2 ring-rose-400/50" : ""}`}
    >
      {closingSoon && order.status === "OPEN" && (
        <div className="-mx-5 -mt-5 mb-4 border-b border-orange-400/20 bg-orange-400/10 px-5 py-2 text-xs font-black uppercase tracking-wider text-orange-300">
          Market closing soon
        </div>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-xl font-black text-white">{order.symbol}</h4>
            <StatusBadge status={order.side} />
            <StatusBadge status={status} />
          </div>
          <p className="mt-2 text-xs font-bold uppercase tracking-wider text-slate-500">
            Confidence{" "}
            <span className="text-cyan-300">{order.confidence}%</span>
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-bold uppercase text-slate-500">
            Current Price
          </p>
          <p className="text-2xl font-black text-white">
            {money(order.currentPrice)}
          </p>
        </div>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 rounded-xl border border-slate-800 bg-slate-950/35 p-4 text-xs sm:grid-cols-4">
        {[
          ["Entry Price", money(entry)],
          ["Current Price", money(order.currentPrice)],
          ["Quantity", order.quantity],
          ["Investment", money(order.investment)],
          ["Current Value", money(currentValue)],
          [
            "Current P&L",
            `${order.pnl >= 0 ? "+" : ""}${money(order.pnl)}`,
          ],
          [
            "Current P&L %",
            `${order.pnlPercent >= 0 ? "+" : ""}${order.pnlPercent.toFixed(2)}%`,
          ],
          [
            "Today's P&L",
            `${order.pnl >= 0 ? "+" : ""}${money(order.pnl)}`,
          ],
        ].map(([label, value]) => (
          <div key={String(label)}>
            <p className="text-[10px] font-bold uppercase text-slate-500">
              {label}
            </p>
            <p
              className={`mt-1 font-black tabular-nums ${String(label).includes("P&L") ? (positive ? "text-emerald-300" : "text-rose-300") : "text-slate-100"}`}
            >
              {value}
            </p>
          </div>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ["Target 1", targets[0]],
          ["Target 2", targets[1]],
          ["Target 3", targets[2] ?? order.target],
          ["Stop Loss", order.stopLoss],
        ].map(([label, value]) => (
          <div
            key={String(label)}
            className={`rounded-lg border p-3 ${label === "Stop Loss" ? "border-rose-400/20 bg-rose-400/5" : "border-emerald-400/15 bg-emerald-400/5"}`}
          >
            <p className="text-[9px] font-bold uppercase tracking-wider text-slate-500">
              {label}
            </p>
            <p
              className={`mt-1 font-black tabular-nums ${label === "Stop Loss" ? "text-rose-300" : "text-emerald-300"}`}
            >
              {money(value)}
            </p>
          </div>
        ))}
      </div>
      <div className="mt-5">
        <div className="relative h-2 rounded-full bg-slate-800">
          <div
            className={`h-full rounded-full transition-all duration-700 ${positive ? "bg-emerald-400" : "bg-rose-400"}`}
            style={{ width: `${progress}%` }}
          />
          <span
            className="absolute top-1/2 h-4 w-1 -translate-y-1/2 rounded bg-white shadow"
            style={{ left: `${progress}%` }}
          />
        </div>
        <div className="mt-2 flex justify-between text-[9px] font-bold uppercase text-slate-600">
          <span>Entry</span>
          <span>Target 1</span>
          <span>Target 2</span>
          <span>Target 3</span>
        </div>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
          <p className="text-[10px] font-bold uppercase text-slate-500">
            Recovery Probability
          </p>
          <p className="mt-1 text-lg font-black text-cyan-300">
            {recovery == null || !Number.isFinite(recovery)
              ? "Monitoring"
              : `${recovery}%`}
          </p>
        </div>
        <RiskGauge risk={scanner?.riskLevel ?? "Monitoring"} />
        <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
          <p className="text-[10px] font-bold uppercase text-slate-500">
            AI Recommendation
          </p>
          <p
            className={`mt-1 text-lg font-black ${recommendation === "EXIT" ? "text-rose-300" : recommendation === "BUY" ? "text-emerald-300" : "text-orange-300"}`}
          >
            {recommendation}
          </p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
          <p className="text-[10px] font-bold uppercase text-slate-500">
            Trade Duration
          </p>
          <p className="mt-1 text-lg font-black text-white">{duration}</p>
          <p className="mt-1 text-[10px] text-slate-500">
            {enteredAt
              ? enteredAt.toLocaleTimeString("en-IN", {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "Entry time pending"}
          </p>
        </div>
      </div>
      <div className="mt-5 flex gap-3">
        <Link
          href={`/analysis/${encodeURIComponent(order.instrumentKey)}`}
          className="grid min-h-11 flex-1 place-items-center rounded-lg border border-sky-400/30 bg-sky-400/10 px-4 text-sm font-bold text-sky-300"
        >
          View Details
        </Link>
        {order.status === "OPEN" && (
          <button
            onClick={() => void onExit(order.id)}
            className="min-h-11 flex-1 rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 text-sm font-bold text-rose-300"
          >
            Exit Trade
          </button>
        )}
      </div>
    </article>
  );
}

function RiskGauge({ risk }: { risk: string }) {
  const labels = ["VERY LOW", "LOW", "MEDIUM", "HIGH", "EXTREME"],
    normalized = risk.toUpperCase(),
    active = labels.indexOf(normalized);
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
      <div className="flex justify-between">
        <p className="text-[10px] font-bold uppercase text-slate-500">
          Risk Meter
        </p>
        <p className="text-[10px] font-black text-white">{risk}</p>
      </div>
      <div className="mt-3 flex gap-1">
        {labels.map((label, index) => (
          <span
            key={label}
            className={`h-2 flex-1 rounded-full ${index <= active ? (index < 2 ? "bg-emerald-400" : index === 2 ? "bg-amber-400" : "bg-rose-400") : "bg-slate-800"}`}
          />
        ))}
      </div>
    </div>
  );
}

function RecommendationCard({
  order,
  row,
  recommendation,
  recovery,
}: {
  order: PaperOrder;
  row?: TradeRow;
  recommendation: string;
  recovery: number | null;
}) {
  const tone =
    recommendation === "BUY"
      ? "border-emerald-400/25 bg-emerald-400/[.07]"
      : /SELL|EXIT/.test(recommendation)
        ? "border-rose-400/25 bg-rose-400/[.07]"
        : "border-amber-400/25 bg-amber-400/[.07]";
  return (
    <div className={`rounded-xl border p-4 ${tone}`}>
      <div className="flex items-center justify-between">
        <p className="font-black text-white">{order.symbol}</p>
        <StatusBadge status={recommendation} />
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-400">
        {row?.reason ?? "Monitoring the existing AI confidence engine."}
      </p>
      <div className="mt-3 flex flex-wrap gap-4 text-xs">
        <span>
          Confidence <b className="text-white">{order.confidence}%</b>
        </span>
        <span>
          Recovery{" "}
          <b className="text-white">
            {recovery == null || !Number.isFinite(recovery)
              ? "Monitoring"
              : `${recovery}%`}
          </b>
        </span>
        <span>
          Breakdown{" "}
          <b className="text-white">
            {recovery == null || !Number.isFinite(recovery)
              ? "Monitoring"
              : `${100 - recovery}%`}
          </b>
        </span>
      </div>
    </div>
  );
}

function SettingToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="text-slate-400">
      {label}
      <select
        value={String(value)}
        onChange={(event) => onChange(event.target.value === "true")}
        className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-white"
      >
        <option value="true">ON</option>
        <option value="false">OFF</option>
      </select>
    </label>
  );
}

function CandleAnalysis({
  timeframe,
  data,
}: {
  timeframe: string;
  data?: Analysis;
}) {
  const candle = data?.candles?.at(-1);
  const indicators = data?.indicators ?? {};
  const macd = indicators.macd;
  const rows = [
    [
      "Current Candle",
      candle?.time ? new Date(candle.time).toLocaleString("en-IN") : null,
    ],
    [
      "Pattern",
      Array.isArray(indicators.patterns)
        ? indicators.patterns.join(", ") || "None detected"
        : null,
    ],
    ["Trend", data?.analysis?.signal],
    ["Volume", candle?.volume],
    ["RSI", indicators.rsi],
    ["MACD", macd?.MACD],
    ["VWAP", indicators.vwap],
    ["EMA", indicators.ema20],
    ["ADX", indicators.adx],
    ["ATR", indicators.atr],
    ["Support", indicators.support],
    ["Resistance", indicators.resistance],
    [
      "Confidence",
      data?.analysis?.confidence == null
        ? null
        : `${data.analysis.confidence}%`,
    ],
    ["Reason", data?.analysis?.reason],
    ["Recommendation", data?.analysis?.signal],
  ];
  return (
    <Card title={`${timeframe} completed candle analysis`}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map(([label, value]) => (
          <Stat
            key={String(label)}
            label={String(label)}
            value={display(value)}
          />
        ))}
      </div>
    </Card>
  );
}

function StopLossDecisionPanels({ row }: { row: TradeRow }) {
  const decision = row.stopLossDecision;
  const distance =
    row.stopLoss == null
      ? null
      : row.signal === "SELL"
        ? Number(row.stopLoss) - row.price
        : row.price - Number(row.stopLoss);
  const waiting = decision?.status === "WAIT";
  const exiting = decision?.status === "EXIT";
  const tone = exiting
    ? "text-rose-300"
    : waiting
      ? "text-orange-300"
      : decision?.status === "CONTINUED"
        ? "text-emerald-300"
        : "text-slate-400";
  const tradeStatus = exiting
    ? "Exit Recommended"
    : waiting
      ? "Waiting For Confirmation"
      : decision?.status === "CONTINUED"
        ? "Trade Continued"
        : decision
          ? "Stop Loss Confirmed"
          : "Monitoring";
  return (
    <>
      <Card title="AI Stop Loss Decision">
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Current Price" value={money(row.price)} />
          <Stat label="Entry" value={money(row.entry)} />
          <Stat
            label="Stop Loss"
            value={money(row.stopLoss)}
            tone="text-rose-300"
          />
          <Stat
            label="Distance from Stop Loss"
            value={distance == null ? "Monitoring" : money(distance)}
          />
          <Stat
            label="Recovery Probability"
            value={decision ? `${decision.recoveryProbability}%` : "Monitoring"}
          />
          <Stat
            label="Breakdown Probability"
            value={
              decision ? `${decision.breakdownProbability}%` : "Monitoring"
            }
          />
          <Stat
            label="AI Confidence"
            value={decision ? `${decision.confidence}%` : "Monitoring"}
          />
          <Stat
            label="Current Decision"
            value={decision?.status ?? "MONITORING"}
            tone={tone}
          />
          <Stat label="Trade Status" value={tradeStatus} tone={tone} />
          <Stat
            label="Recommendation"
            value={
              decision?.recommendation ??
              "Engine activates when stop loss is touched"
            }
            tone={tone}
          />
        </div>
        {decision?.reason && (
          <p className="mt-4 text-sm leading-6 text-slate-300">
            {decision.reason}
          </p>
        )}
      </Card>
      <Card title="Decision Timeline">
        {decision?.timeline?.length ? (
          <div className="space-y-3">
            {decision.timeline.map((event) => (
              <div key={event.id} className="border-l-2 border-slate-700 pl-3">
                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
                  {new Date(event.eventTime).toLocaleTimeString("en-IN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
                <p className="mt-1 text-sm font-semibold text-slate-200">
                  {event.detail}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-400">
            Monitoring live Upstox prices for a stop loss touch.
          </p>
        )}
      </Card>
    </>
  );
}

export function TradeStrategyDetail({
  symbol,
  session,
}: {
  symbol: string;
  session: string;
}) {
  const client = useQueryClient();
  const [timeframe, setTimeframe] = useState<"3m" | "5m">("3m");
  const [liveTick, setLiveTick] = useState<LiveChartTick | null>(null);
  const lastHistoryReloadRef = useRef(0);
  const scanner = useQuery({
    queryKey: ["trade-strategy-row", symbol],
    queryFn: () => api<TradeRow[]>("/scanner?filter=all"),
    enabled: Boolean(session),
    retry: false,
    refetchInterval: 60_000,
  });
  const row = scanner.data?.find(
    (item) => item.symbol.toUpperCase() === symbol.toUpperCase(),
  );
  const key = row?.instrumentKey;
  const analysis3 = useQuery({
    queryKey: ["trade-strategy-analysis", key, "3m"],
    queryFn: () =>
      api<Analysis>(
        `/stocks/${encodeURIComponent(key!)}/analysis?unit=minutes&interval=3`,
      ),
    enabled: Boolean(key),
    retry: false,
    refetchInterval: 180_000,
  });
  const analysis5 = useQuery({
    queryKey: ["trade-strategy-analysis", key, "5m"],
    queryFn: () =>
      api<Analysis>(
        `/stocks/${encodeURIComponent(key!)}/analysis?unit=minutes&interval=5`,
      ),
    enabled: Boolean(key),
    retry: false,
    refetchInterval: 300_000,
  });
  useEffect(() => {
    if (!key || !session) return;
    const socket = io(base, { auth: { token: token() }, reconnection: true });
    socket.on("connect", () =>
      console.info("[Trading Chart] WebSocket Connected"),
    );
    socket.on("market-price-updated", (tick: any) => {
      if (tick.instrumentKey !== key || !Number.isFinite(Number(tick.ltp)))
        return;
      const nextTick = {
        ltp: Number(tick.ltp),
        timestamp: Number(tick.timestamp ?? Date.now()),
        volume: tick.volume == null ? null : Number(tick.volume),
      };
      setLiveTick(nextTick);
      client.setQueryData<TradeRow[]>(["trade-strategy-row", symbol], (rows) =>
        rows?.map((item) =>
          item.instrumentKey === key ? { ...item, price: nextTick.ltp } : item,
        ),
      );
    });
    socket.on("signal-history-updated", (event: any) => {
      if (event.instrumentKey === key)
        void client.invalidateQueries({
          queryKey: ["trade-strategy-row", symbol],
        });
    });
    return () => {
      socket.close();
    };
  }, [client, key, session, symbol]);
  const analysis = timeframe === "3m" ? analysis3.data : analysis5.data;
  const historicalLast = analysis?.candles?.at(-1);
  const historicalDifference =
    row?.price && historicalLast?.close
      ? (Math.abs(row.price - historicalLast.close) / row.price) * 100
      : 0;
  const staleHistory = Boolean(historicalLast && historicalDifference > 3);
  useEffect(() => {
    if (!row || !historicalLast) return;
    const currentTradingDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    console.info("[Trading Chart] Historical Last Candle", historicalLast);
    console.info("[Trading Chart] Live Price", row.price);
    console.info("[Trading Chart] Difference %", historicalDifference);
    console.info(
      "[Trading Chart] History Date",
      historicalLast.time.slice(0, 10),
    );
    console.info("[Trading Chart] Current Trading Date", currentTradingDate);
    if (!staleHistory || Date.now() - lastHistoryReloadRef.current < 15_000)
      return;
    lastHistoryReloadRef.current = Date.now();
    console.warn(
      "[Trading Chart] Historical cache is stale; reloading current-session candles",
      { timeframe, differencePercent: historicalDifference },
    );
    void (timeframe === "3m" ? analysis3.refetch() : analysis5.refetch());
  }, [
    analysis3,
    analysis5,
    historicalDifference,
    historicalLast,
    row,
    staleHistory,
    timeframe,
  ]);
  const levels: ChartLevel[] = useMemo(
    () =>
      row
        ? [
            { price: row.entry, label: "ENTRY", color: "#4ade80" },
            { price: row.stopLoss, label: "STOP LOSS", color: "#fb7185" },
            { price: row.target1, label: "TARGET 1", color: "#60a5fa" },
            { price: row.target2, label: "TARGET 2", color: "#60a5fa" },
            { price: row.target3, label: "TARGET 3", color: "#60a5fa" },
          ]
        : [],
    [row?.entry, row?.stopLoss, row?.target1, row?.target2, row?.target3],
  );
  const tradeStatus = statusLabel(row?.tradeStatus);
  const closed = Boolean(row?.completedAt);
  const pnl = row?.profitPercent;
  const statusTone = row?.stopLossAt
    ? "text-rose-300"
    : closed
      ? "text-slate-400"
      : row?.entryTriggeredAt
        ? "text-emerald-300"
        : "text-sky-300";
  const moveRows = [
    [
      "Current Move %",
      row?.changePercent == null ? null : `${row.changePercent.toFixed(2)}%`,
    ],
    ["Previous Move %", null],
    ["Pullback %", null],
    ["Recovery %", null],
    ["Distance to Entry", null],
    ["Distance to Stop Loss", null],
    ["Distance to Target 1", null],
    ["Distance to Target 2", null],
    ["Distance to Target 3", null],
  ];
  if (scanner.isLoading)
    return (
      <div className="py-20 text-center text-slate-400">
        Loading backend strategy data…
      </div>
    );
  if (!row)
    return (
      <div>
        <Link href="/trade-strategy" className="text-cyan-300">
          ← Back to AI Trade Strategy
        </Link>
        <div className="glass-card mt-6 p-8 text-center text-slate-400">
          This symbol is not present in the current backend scanner response.
        </div>
      </div>
    );
  return (
    <div>
      <Link
        href="/trade-strategy"
        className="inline-flex items-center gap-2 text-xs font-bold text-slate-400 hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to market scanner
      </Link>
      <header className="mt-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="section-eyebrow">AI TRADE STRATEGY · NSE</p>
          <h1 className="text-3xl font-bold text-white">{row.company}</h1>
          <p className="mt-1 text-sm text-slate-400">
            {row.symbol} · {row.signal} · Live Upstox feed
          </p>
        </div>
        <div className="text-right">
          <p className="text-3xl font-black text-white">{money(row.price)}</p>
          <p className={`mt-1 text-sm font-bold ${statusTone}`}>
            {tradeStatus}
          </p>
        </div>
      </header>
      <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card title="Trading chart">
          <div className="mb-3 flex gap-2">
            {(["3m", "5m"] as const).map((item) => (
              <button
                key={item}
                onClick={() => setTimeframe(item)}
                className={`rounded-lg px-4 py-2 text-xs font-bold ${timeframe === item ? "bg-cyan-400/15 text-cyan-300" : "bg-slate-800 text-slate-400"}`}
              >
                {item === "3m" ? "3 Minute" : "5 Minute"}
              </button>
            ))}
          </div>
          <PriceChart
            candles={staleHistory ? [] : analysis?.candles}
            levels={levels}
            liveTick={liveTick}
            timeframeMinutes={timeframe === "3m" ? 3 : 5}
          />
        </Card>
        <div className="space-y-5">
          <Card title="Trade Information">
            <div className="grid grid-cols-2 gap-3">
              <Stat
                label="Entry"
                value={money(row.entry)}
                tone={
                  row.entryTriggeredAt ? "text-emerald-300" : "text-sky-300"
                }
              />
              <Stat
                label="Stop Loss"
                value={money(row.stopLoss)}
                tone={row.stopLossAt ? "text-rose-300" : ""}
              />
              <Stat
                label="Target 1"
                value={money(row.target1)}
                tone={row.target1At ? "text-emerald-300" : ""}
              />
              <Stat
                label="Target 2"
                value={money(row.target2)}
                tone={row.target2At ? "text-emerald-300" : ""}
              />
              <Stat
                label="Target 3"
                value={money(row.target3)}
                tone={row.target3At ? "text-emerald-300" : ""}
              />
              <Stat label="Current Price" value={money(row.price)} />
              <Stat
                label="Current PNL"
                value={
                  pnl == null
                    ? "Backend data unavailable"
                    : `${pnl.toFixed(2)}%`
                }
                tone={Number(pnl) >= 0 ? "text-emerald-300" : "text-rose-300"}
              />
              <Stat
                label="Trade Status"
                value={tradeStatus}
                tone={statusTone}
              />
            </div>
          </Card>
          <StopLossDecisionPanels row={row} />
        </div>
      </div>
      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <CandleAnalysis timeframe="3 Minute" data={analysis3.data} />
        <CandleAnalysis timeframe="5 Minute" data={analysis5.data} />
        <Card title="Trade Behaviour Analysis">
          <p className="text-sm leading-6 text-slate-300">
            {row.reason || "Backend data unavailable"}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {[
              "Buying pressure",
              "Selling pressure",
              "Profit booking",
              "Breakout",
              "Breakdown",
              "Support holding",
              "Resistance holding",
            ].map((item) => (
              <span
                key={item}
                className="rounded-md border border-slate-700 px-2 py-1 text-[10px] font-bold text-slate-400"
              >
                {item}: backend data unavailable
              </span>
            ))}
          </div>
        </Card>
        <Card title="Movement Analysis">
          <div className="grid gap-3 sm:grid-cols-3">
            {moveRows.map(([label, amount]) => (
              <Stat
                key={String(label)}
                label={String(label)}
                value={display(amount)}
              />
            ))}
          </div>
        </Card>
        <Card title="AI Decision Panel" className="xl:col-span-2">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <Stat
              label="Current Trend"
              value={display(row.trend)}
              tone={
                row.trend === "BULLISH" ? "text-emerald-300" : "text-rose-300"
              }
            />
            <Stat label="Confidence" value={display(row.confidence, "%")} />
            <Stat
              label="Probability of continuation"
              value={display(
                row.signal === "BUY" ? row.buyProbability : row.sellProbability,
                "%",
              )}
            />
            <Stat
              label="Probability of pullback"
              value="Backend data unavailable"
            />
            <Stat label="Risk" value={display(row.riskLevel)} />
            <Stat label="Recommendation" value={display(row.signal)} />
          </div>
        </Card>
      </div>
    </div>
  );
}
