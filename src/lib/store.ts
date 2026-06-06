import { useSyncExternalStore } from "react";

import { MOCK_CONNECTIONS, type Connection } from "./mockConnections";

export type ActionStatus = "pending" | "approved" | "sending" | "sent" | "rejected" | "failed";

export type Action = {
  id: string;
  type: "connection_request" | "message" | "email" | "profile_view";
  target_id: string;
  target_name: string;
  channel: string;
  subject?: string;
  body: string;
  reasoning: string;
  status: ActionStatus;
  created_at: string;
  sent_at?: string;
};

export type Caps = {
  invitesPerDay: number;
  messagesPerDay: number;
  profileViewsPerDay: number;
};

export type WarmupState = {
  startedAt: string | null;
  // 14-day ramp; recomputed from startedAt
};

export type SessionState = {
  connected: boolean;
  capturedAt?: string;
  userAgent?: string;
  displayName?: string;
  accountId?: string;
};

export type ConnectionsState = {
  source: "mock" | "csv";
  uploadedAt?: string;
  items: Connection[];
};

export type ImportOpState = {
  status: "idle" | "running" | "done" | "failed";
  jobId?: string;
  startedAt?: string;
  finishedAt?: string;
  requestedCount?: number;
  importedCount?: number;
  totalAvailable?: number;
  message?: string;
};

export type AgentMessage = { role: "user" | "assistant"; content: string };

export type AppState = {
  onboarded: boolean;
  session: SessionState & { cookies?: { li_at: string; JSESSIONID: string } };
  caps: Caps;
  warmup: WarmupState;
  connections: ConnectionsState;
  actions: Action[];
  ops: {
    import: ImportOpState;
  };
  // counters: yyyy-mm-dd -> { invites, messages, views }
  daily: Record<string, { invites: number; messages: number; views: number }>;
  messages: AgentMessage[];
};

const KEY = "nm.state.v1";

const DEFAULT: AppState = {
  onboarded: false,
  session: { connected: false },
  caps: { invitesPerDay: 10, messagesPerDay: 20, profileViewsPerDay: 30 },
  warmup: { startedAt: null },
  connections: { source: "mock", items: MOCK_CONNECTIONS },
  actions: [],
  ops: { import: { status: "idle" } },
  daily: {},
  messages: [
    {
      role: "assistant",
      content:
        "Hi! I'm your LinkedIn Network Manager. I can search your connections, draft outreach, manage connection requests, and more. What would you like to do?",
    },
  ],
};

let state: AppState = DEFAULT;
const listeners = new Set<() => void>();

function load() {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) state = { ...DEFAULT, ...JSON.parse(raw) };
  } catch {
    /* noop */
  }
}
function persist() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* noop */
  }
}
function emit() {
  persist();
  listeners.forEach((l) => l());
}

load();

export const store = {
  get: () => state,
  set: (patch: Partial<AppState> | ((s: AppState) => AppState)) => {
    state = typeof patch === "function" ? patch(state) : { ...state, ...patch };
    emit();
  },
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

const SERVER_SNAPSHOT = DEFAULT;
export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    (l) => store.subscribe(l),
    () => selector(store.get()),
    () => selector(SERVER_SNAPSHOT),
  );
}

// --- Derived helpers ---
export function warmupDay(s: AppState = state): number {
  if (!s.warmup.startedAt) return 0;
  const days = Math.floor((Date.now() - new Date(s.warmup.startedAt).getTime()) / 86400000);
  return Math.min(14, Math.max(0, days) + 1);
}

// Effective caps ramp linearly to user caps across 14 days; profile_view starts immediately.
export function effectiveCaps(s: AppState = state): Caps {
  const day = warmupDay(s);
  if (day === 0) return { invitesPerDay: 0, messagesPerDay: 0, profileViewsPerDay: 5 };
  const r = day / 14;
  return {
    invitesPerDay: Math.max(2, Math.round(s.caps.invitesPerDay * r)),
    messagesPerDay: Math.max(2, Math.round(s.caps.messagesPerDay * r)),
    profileViewsPerDay: Math.max(5, Math.round(s.caps.profileViewsPerDay * r)),
  };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function todaysUsage(s: AppState = state) {
  return s.daily[today()] ?? { invites: 0, messages: 0, views: 0 };
}

function bumpUsage(type: Action["type"]) {
  const k = today();
  const cur = state.daily[k] ?? { invites: 0, messages: 0, views: 0 };
  const next = { ...cur };
  if (type === "connection_request") next.invites++;
  else if (type === "message" || type === "email") next.messages++;
  else if (type === "profile_view") next.views++;
  state.daily = { ...state.daily, [k]: next };
}

function canSend(type: Action["type"]): boolean {
  const eff = effectiveCaps();
  const u = todaysUsage();
  if (type === "connection_request") return u.invites < eff.invitesPerDay;
  if (type === "message" || type === "email") return u.messages < eff.messagesPerDay;
  if (type === "profile_view") return u.views < eff.profileViewsPerDay;
  return false;
}

export function addActions(actions: Action[]) {
  store.set((s) => ({ ...s, actions: [...s.actions, ...actions] }));
}

export function decide(id: string, approve: boolean) {
  store.set((s) => ({
    ...s,
    actions: s.actions.map((a) =>
      a.id === id ? { ...a, status: approve ? "approved" : "rejected" } : a,
    ),
  }));
}

export function setAgentMessages(messages: AgentMessage[]) {
  store.set((s) => ({ ...s, messages }));
}

export function clearAgentMessages() {
  store.set((s) => ({
    ...s,
    messages: [
      {
        role: "assistant",
        content:
          "Hi! I'm your LinkedIn Network Manager. I can search your connections, draft outreach, manage connection requests, and more. What would you like to do?",
      },
    ],
  }));
}

// Worker loop: pick one approved action per tick that fits in caps, simulate send.
let workerTimer: ReturnType<typeof setInterval> | null = null;
export function startWorker() {
  if (workerTimer || typeof window === "undefined") return;
  workerTimer = setInterval(() => {
    const s = store.get();
    const next = s.actions.find((a) => a.status === "approved" && canSend(a.type));
    if (!next) return;
    // Mark sending
    store.set((cur) => ({
      ...cur,
      actions: cur.actions.map((a) => (a.id === next.id ? { ...a, status: "sending" } : a)),
    }));
    // Human-like delay 4-10s
    const delay = 4000 + Math.floor(Math.random() * 6000);
    setTimeout(() => {
      bumpUsage(next.type);
      store.set((cur) => ({
        ...cur,
        actions: cur.actions.map((a) =>
          a.id === next.id ? { ...a, status: "sent", sent_at: new Date().toISOString() } : a,
        ),
      }));
    }, delay);
  }, 3000);
}
