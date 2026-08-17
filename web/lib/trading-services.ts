import { api } from "./api";

export const scannerService = {
  dashboard: <T>() => api<T>("/dashboard"),
};

export const paperTradingService = {
  dashboard: <T>() => api<T>("/paper-trading"),
  updateSettings: (settings: unknown) => api("/paper-trading/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  }),
  createTrade: (instrumentKey: string) => api("/paper-trading/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instrumentKey }),
  }),
  exitTrade: (id: string) => api(`/paper-trading/orders/${encodeURIComponent(id)}/exit`, { method: "POST" }),
  resetAccount: () => api("/paper-trading/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: "RESET DEMO ACCOUNT" }) }),
};

export const realTradingService = {
  dashboard: <T>() => api<T>("/real-trading"),
  exitPosition: (instrumentKey: string, product: string) => api("/real-trading/positions/exit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instrumentKey, product }),
  }),
};

export const tradeHistoryService = {
  filter<T extends { exitTime?: string | null; side: string; exitReason?: string | null }>(orders: T[], filter: string, now = new Date()) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return orders.filter((order) => {
      const exited = order.exitTime ? new Date(order.exitTime).getTime() : 0;
      if (filter === "Today") return exited >= start;
      if (filter === "Yesterday") return exited >= start - 86_400_000 && exited < start;
      if (filter === "This Week") return exited >= start - 6 * 86_400_000;
      if (filter === "BUY" || filter === "SELL") return order.side === filter;
      if (filter === "Completed") return !/STOP|MANUAL/i.test(String(order.exitReason ?? ""));
      if (filter === "Stoploss") return /STOP/i.test(String(order.exitReason ?? ""));
      if (filter === "Manual Exit") return /MANUAL/i.test(String(order.exitReason ?? ""));
      return true;
    });
  },
};

export const capitalManagementService = {
  allocation(balance: number, trades: number) {
    return trades > 0 ? balance / trades : 0;
  },
};
