import { useEffect, useMemo, useRef, useState } from "react";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * 1日のタスク管理ツール（Googleログイン専用 / モダンUI）
 * v3.6.0
 * - Googleカレンダー登録時の説明に「完了条件」を常に含める（未入力でも明示）
 * - 一覧の「工数(予定)」「実績」の幅を「開始」と同じ w-28 に統一
 * - 既存機能維持：担当者/完了条件/IME安全編集/DnD/色/横スクロール/Google連携
 */

const SUPABASE_URL: string = (import.meta as any)?.env?.VITE_SUPABASE_URL || "";
const SUPABASE_ANON_KEY: string = (import.meta as any)?.env?.VITE_SUPABASE_ANON_KEY || "";
const SUPABASE_READY = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
const supabase: SupabaseClient | null = SUPABASE_READY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const CATEGORIES = ["広告運用", "SEO", "新規営業", "AF", "その他"] as const;
const STATUS = ["未着手", "仕掛中", "完了"] as const;

type Category = typeof CATEGORIES[number];
type Status = typeof STATUS[number];

type Task = {
  id: string;
  name: string;
  category: Category;
  plannedHours: number;
  actualHours: number;
  status: Status;
  date: string;       // YYYY-MM-DD
  createdAt: number;  // epoch ms
  member: string;
  ownerId?: string;
  retrospective?: string;
  startTime?: string | null; // "HH:MM"
  endTime?: string | null;   // "HH:MM"
  doneCondition?: string;    // 完了条件
  sortOrder?: number | null; // 並び順
};

type CloudUser = { id: string; email: string; displayName: string };

const todayStr = () => new Date().toISOString().slice(0, 10);
const H_OPTIONS = Array.from({ length: 24 }, (_, i) => i);
const M_OPTIONS = [0, 15, 30, 45];
const CUSTOM_MEMBER_VALUE = "__CUSTOM_MEMBER__";

/* ---------- UI primitives ---------- */
function Chip({ children, className = "" }: { children: any; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${className}`}>
      {children}
    </span>
  );
}
function FieldLabel({ children }: { children: any }) {
  return <label className="block text-xs font-semibold text-slate-600 mb-1.5">{children}</label>;
}
function Input({ className = "", ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-xl border border-slate-200 bg-white/80 px-3.5 py-2 text-sm outline-none ring-0 focus:border-slate-300 focus:ring-4 focus:ring-slate-100 transition ${className}`}
      {...props}
    />
  );
}
function Select({ className = "", ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`w-full rounded-xl border border-slate-200 bg-white/80 px-3.5 py-2 text-sm outline-none ring-0 focus:border-slate-300 focus:ring-4 focus:ring-slate-100 transition ${className}`}
      {...props}
    />
  );
}
function TextArea({ className = "", ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`w-full rounded-xl border border-slate-200 bg-white/80 px-3.5 py-2 text-sm outline-none ring-0 focus:border-slate-300 focus:ring-4 focus:ring-slate-100 transition ${className}`}
      {...props}
    />
  );
}
function Button({ className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`inline-flex items-center justify-center rounded-xl bg-slate-900 text-white px-4 py-2.5 text-sm font-semibold shadow-sm hover:opacity-95 active:opacity-90 focus:outline-none focus:ring-4 focus:ring-slate-200 transition ${className}`}
      {...props}
    />
  );
}
function CategoryPill({ value }: { value: Category }) {
  // 他セルと高さ揃え（h-10=40px）
  const base = "w-full h-10 flex items-center justify-center rounded-xl border text-sm font-medium";
  const map: Record<Category, string> = {
    "広告運用": `${base} bg-indigo-50 text-indigo-700 border-indigo-200`,
    "SEO": `${base} bg-emerald-50 text-emerald-700 border-emerald-200`,
    "新規営業": `${base} bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200`,
    "AF": `${base} bg-amber-50 text-amber-700 border-amber-200`,
    "その他": `${base} bg-slate-50 text-slate-700 border-slate-200`,
  };
  return <div className={map[value]}>{value}</div>;
}
function StatusPill({ value }: { value: Status }) {
  const base = "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold";
  const map: Record<Status, string> = {
    "未着手": `${base} bg-rose-100 text-rose-700 border border-rose-200`,
    "仕掛中": `${base} bg-amber-100 text-amber-700 border border-amber-200`,
    "完了": `${base} bg-emerald-100 text-emerald-700 border border-emerald-200`,
  };
  return <span className={map[value]}>{value}</span>;
}

/* ---------- Supabase helpers ---------- */
function noSuchColumn(err: any, col: string) {
  const msg = (err?.message || err?.hint || err?.details || "").toString().toLowerCase();
  return msg.includes(col.toLowerCase()) && (msg.includes("does not exist") || msg.includes("column"));
}
function logErr(where: string, err: any) {
  console.error(`[${where}]`, { message: err?.message, details: err?.details, hint: err?.hint, code: err?.code, err });
}

/* ---------- DB I/O ---------- */
async function cloudInsertTask(t: Omit<Task, "id">, ownerId: string) {
  if (!supabase) throw new Error("Supabase未設定");
  const base: any = {
    owner_id: ownerId,
    member: t.member,
    name: t.name,
    category: t.category,
    planned_hours: t.plannedHours,
    actual_hours: t.actualHours,
    status: t.status,
    date: t.date,
    created_at: new Date(t.createdAt).toISOString(),
  };
  const first = await supabase.from("tasks").insert({
    ...base,
    retrospective: t.retrospective ?? null,
    start_time: t.startTime ?? null,
    end_time: t.endTime ?? null,
    done_condition: t.doneCondition ?? null,
    sort_order: t.sortOrder ?? null,
  });
  if (first.error) {
    const payload: any = { ...base };
    if (!noSuchColumn(first.error, "retrospective")) payload.retrospective = t.retrospective ?? null;
    if (!noSuchColumn(first.error, "start_time")) payload.start_time = t.startTime ?? null;
    if (!noSuchColumn(first.error, "end_time")) payload.end_time = t.endTime ?? null;
    if (!noSuchColumn(first.error, "done_condition")) payload.done_condition = t.doneCondition ?? null;
    if (!noSuchColumn(first.error, "sort_order")) payload.sort_order = t.sortOrder ?? null;

    if (noSuchColumn(first.error, "retrospective")) delete payload.retrospective;
    if (noSuchColumn(first.error, "start_time")) delete payload.start_time;
    if (noSuchColumn(first.error, "end_time")) delete payload.end_time;
    if (noSuchColumn(first.error, "done_condition")) delete payload.done_condition;
    if (noSuchColumn(first.error, "sort_order")) delete payload.sort_order;

    const retry = await supabase.from("tasks").insert(payload);
    if (retry.error) { logErr("insert(retry)", retry.error); throw retry.error; }
  }
}
async function cloudUpdateTask(id: string, ownerId: string, patch: Partial<Task>) {
  if (!supabase) throw new Error("Supabase未設定");
  const toDb = (p: Partial<Task>) => {
    const o: any = {};
    if (p.actualHours !== undefined) o.actual_hours = p.actualHours;
    if (p.status !== undefined) o.status = p.status;
    if (p.plannedHours !== undefined) o.planned_hours = p.plannedHours;
    if (p.retrospective !== undefined) o.retrospective = p.retrospective;
    if (p.startTime !== undefined) o.start_time = p.startTime;
    if (p.endTime !== undefined) o.end_time = p.endTime;
    if (p.doneCondition !== undefined) o.done_condition = p.doneCondition;
    if (p.sortOrder !== undefined) o.sort_order = p.sortOrder;
    return o;
  };
  const res = await supabase.from("tasks").update(toDb(patch)).eq("id", id).eq("owner_id", ownerId);
  if (res.error) {
    const needRetry =
      ("retrospective" in patch && noSuchColumn(res.error, "retrospective")) ||
      ("startTime" in patch && noSuchColumn(res.error, "start_time")) ||
      ("endTime" in patch && noSuchColumn(res.error, "end_time")) ||
      ("doneCondition" in patch && noSuchColumn(res.error, "done_condition")) ||
      ("sortOrder" in patch && noSuchColumn(res.error, "sort_order"));
    if (needRetry) {
      const p2 = { ...patch } as any;
      if (noSuchColumn(res.error, "retrospective")) delete p2.retrospective;
      if (noSuchColumn(res.error, "start_time")) delete p2.startTime;
      if (noSuchColumn(res.error, "end_time")) delete p2.endTime;
      if (noSuchColumn(res.error, "done_condition")) delete p2.doneCondition;
      if (noSuchColumn(res.error, "sort_order")) delete p2.sortOrder;
      const retry = await supabase.from("tasks").update(toDb(p2)).eq("id", id).eq("owner_id", ownerId);
      if (retry.error) { logErr("update(retry)", retry.error); throw retry.error; }
    } else {
      logErr("update", res.error);
      throw res.error;
    }
  }
}
async function cloudDeleteTask(id: string, ownerId: string) {
  if (!supabase) throw new Error("Supabase未設定");
  const { error } = await supabase.from("tasks").delete().eq("id", id).eq("owner_id", ownerId);
  if (error) { logErr("delete", error); throw error; }
}
async function cloudFetchAll(): Promise<Task[]> {
  if (!supabase) throw new Error("Supabase未設定");
  const { data, error } = await supabase.from("tasks").select("*");
  if (error) { logErr("fetchAll", error); throw error; }
  return (data || []).map((r: any) => toTask(r));
}
async function cloudFetchMine(ownerId: string): Promise<Task[]> {
  if (!supabase) throw new Error("Supabase未設定");
  const { data, error } = await supabase.from("tasks").select("*").eq("owner_id", ownerId);
  if (error) { logErr("fetchMine", error); throw error; }
  return (data || []).map((r: any) => toTask(r));
}
function toTask(r: any): Task {
  return {
    id: r.id,
    ownerId: r.owner_id,
    member: r.member,
    name: r.name,
    category: r.category,
    plannedHours: Number(r.planned_hours || 0),
    actualHours: Number(r.actual_hours || 0),
    status: r.status as Status,
    date: r.date,
    createdAt: new Date(r.created_at).getTime(),
    retrospective: (r as any).retrospective ?? "",
    startTime: (r as any).start_time ?? null,
    endTime: (r as any).end_time ?? null,
    doneCondition: (r as any).done_condition ?? "",
    sortOrder: (r as any).sort_order ?? null,
  };
}

/* ---------- 時刻・計算 ---------- */
function hhmmToMinutes(hhmm?: string | null): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (h < 0 || h > 23 || ![0, 15, 30, 45].includes(mm)) return null;
  return h * 60 + mm;
}
function diffHoursFromTimes(start?: string | null, end?: string | null): number | null {
  const s = hhmmToMinutes(start);
  const e = hhmmToMinutes(end);
  if (s == null || e == null) return null;
  const diff = e - s;
  if (diff <= 0) return 0;
  return Math.round((diff / 60) * 100) / 100;
}
function displayPlanned(t: Task): number {
  const d = diffHoursFromTimes(t.startTime, t.endTime);
  if (d == null) return Number.isFinite(t.plannedHours) ? t.plannedHours : 0;
  return d;
}
function pad2(n: number) {
  return n.toString().padStart(2, "0");
}

/* ---------- Google Calendar ---------- */
async function createGoogleCalendarEvent(
  date: string,
  startTime: string | null | undefined,
  endTime: string | null | undefined,
  title: string,
  description: string
) {
  if (!supabase) throw new Error("Supabase未設定");
  const { data } = await supabase.auth.getSession();
  const accessToken = (data.session as any)?.provider_token as string | undefined;
  if (!accessToken) throw new Error("Googleのアクセストークンが見つかりません。再ログインしてください。");

  const start = startTime ? new Date(`${date}T${startTime}:00`) : new Date(`${date}T09:00:00`);
  const end = endTime ? new Date(`${date}T${endTime}:00`) : new Date(start.getTime() + 60 * 60 * 1000);
  if (end <= start) end.setTime(start.getTime() + 60 * 60 * 1000);

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Tokyo";

  const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: title,
      // ★ 完了条件を常に含める（未入力なら明記）
      description,
      start: { dateTime: start.toISOString(), timeZone },
      end: { dateTime: end.toISOString(), timeZone },
    }),
  });
  if (!res.ok) throw new Error(`Google Calendar API Error: ${res.status} ${await res.text()}`);
}

/* ---------- Login ---------- */
function CloudLogin({ onLoggedIn }: { onLoggedIn: (u: CloudUser) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const signInWithGoogle = async () => {
    try {
      setLoading(true);
      setError(null);
      if (!SUPABASE_READY) throw new Error("SupabaseのURL/AnonKeyが未設定です。");
      const { error } = await supabase!.auth.signInWithOAuth({
        provider: "google",
        options: {
          scopes: "https://www.googleapis.com/auth/calendar.events",
          redirectTo: window.location.origin,
        },
      });
      if (error) throw error;
    } catch (e: any) {
      setError(e.message || String(e));
      setLoading(false);
    }
  };

  useEffect(() => {
    (async () => {
      if (!supabase) return;
      const { data } = await supabase.auth.getSession();
      const s = data.session;
      if (s?.user) {
        const u = s.user;
        onLoggedIn({
          id: u.id,
          email: u.email || (u.user_metadata?.email as string) || "",
          displayName:
            (u.user_metadata?.full_name as string) ||
            (u.user_metadata?.name as string) ||
            (u.email?.split("@")[0] ?? "user"),
        });
      }
    })();
  }, [onLoggedIn]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-white to-slate-100">
      <div className="w-full max-w-md rounded-3xl border border-slate-200/70 bg-white/80 backdrop-blur-xl shadow-xl p-8 text-center">
        <div className="mx-auto mb-4 h-12 w-12 rounded-2xl bg-slate-900" />
        <h1 className="text-2xl font-bold tracking-tight">1日のタスク管理</h1>
        <p className="text-slate-600 mt-1.5 text-sm">Googleアカウントでログインし、カレンダー連携できます。</p>
        {error && <div className="text-red-600 text-sm mt-3">{error}</div>}
        <Button className="w-full mt-6" onClick={signInWithGoogle} disabled={loading}>
          {loading ? "リダイレクト中..." : "Googleでログイン"}
        </Button>
        {!SUPABASE_READY && (
          <p className="text-xs text-orange-600 mt-3">※ Vercelに VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY を設定してください</p>
        )}
      </div>
    </div>
  );
}

/* ---------- IME-safe editors ---------- */
function RetrospectiveCell({
  initial,
  canEdit,
  onSave,
  placeholder = "今日の気づき/改善点など",
  debounceMs = 600,
}: {
  initial: string;
  canEdit: boolean;
  onSave: (value: string) => void | Promise<void>;
  placeholder?: string;
  debounceMs?: number;
}) {
  const [text, setText] = useState(initial ?? "");
  const composingRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => { if (!composingRef.current) setText(initial ?? ""); }, [initial]);
  useEffect(() => () => { if (timerRef.current) window.clearTimeout(timerRef.current); }, []);

  const scheduleSave = (next: string) => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => { onSave(next); }, debounceMs);
  };

  if (!canEdit) {
    return <div className="w-full min-h-[2.5rem] whitespace-pre-wrap rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2">{(text ?? "").trim() || "—"}</div>;
  }

  return (
    <textarea
      rows={2}
      className="w-full rounded-xl border border-slate-200 bg-white/80 px-3 py-2 text-sm outline-none ring-0 focus:border-slate-300 focus:ring-4 focus:ring-slate-100 transition"
      placeholder={placeholder}
      value={text}
      onChange={(e) => { const next = e.target.value; setText(next); if (!composingRef.current) scheduleSave(next); }}
      onCompositionStart={() => { composingRef.current = true; if (timerRef.current) window.clearTimeout(timerRef.current); }}
      onCompositionEnd={(e) => { composingRef.current = false; const next = (e.target as HTMLTextAreaElement).value; setText(next); scheduleSave(next); }}
      onBlur={(e) => { if (!composingRef.current) { if (timerRef.current) window.clearTimeout(timerRef.current); onSave(e.currentTarget.value); } }}
    />
  );
}

function DoneConditionCell({
  initial,
  canEdit,
  onSave,
  placeholder = "完了の判断基準（例：◯◯の承認取得まで）",
  debounceMs = 600,
}: {
  initial: string;
  canEdit: boolean;
  onSave: (value: string) => void | Promise<void>;
  placeholder?: string;
  debounceMs?: number;
}) {
  const [text, setText] = useState(initial ?? "");
  const composingRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => { if (!composingRef.current) setText(initial ?? ""); }, [initial]);
  useEffect(() => () => { if (timerRef.current) window.clearTimeout(timerRef.current); }, []);

  const scheduleSave = (next: string) => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => { onSave(next); }, debounceMs);
  };

  if (!canEdit) {
    return <div className="w-full min-h-[2.5rem] whitespace-pre-wrap rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2">{(text ?? "").trim() || "—"}</div>;
  }

  return (
    <textarea
      rows={2}
      className="w-full rounded-xl border border-slate-200 bg-white/80 px-3 py-2 text-sm outline-none ring-0 focus:border-slate-300 focus:ring-4 focus:ring-slate-100 transition"
      placeholder={placeholder}
      value={text}
      onChange={(e) => { const next = e.target.value; setText(next); if (!composingRef.current) scheduleSave(next); }}
      onCompositionStart={() => { composingRef.current = true; if (timerRef.current) window.clearTimeout(timerRef.current); }}
      onCompositionEnd={(e) => { composingRef.current = false; const next = (e.target as HTMLTextAreaElement).value; setText(next); scheduleSave(next); }}
      onBlur={(e) => { if (!composingRef.current) { if (timerRef.current) window.clearTimeout(timerRef.current); onSave(e.currentTarget.value); } }}
    />
  );
}

/* ---------- App ---------- */
export default function App() {
  const [user, setUser] = useState<CloudUser | null>(null);
  const [date, setDate] = useState<string>(todayStr());
  const [tasksMine, setTasksMine] = useState<Task[]>([]);
  const [tasksAll, setTasksAll] = useState<Task[]>([]);
  const [viewMode, setViewMode] = useState<"mine" | "all">("mine");
  const [memberFilter, setMemberFilter] = useState<string>("all");
  const [addToGoogleCalendar, setAddToGoogleCalendar] = useState<boolean>(false);

  // 追加：担当者UI切替
  const [assigneeMode, setAssigneeMode] = useState<"select" | "custom">("select");

  // セッション復元 + 監視
  useEffect(() => {
    (async () => {
      if (!supabase) return;
      const { data } = await supabase.auth.getSession();
      const s = data.session;
      if (s?.user) {
        const u = s.user;
        setUser({
          id: u.id,
          email: u.email || (u.user_metadata?.email as string) || "",
          displayName:
            (u.user_metadata?.full_name as string) ||
            (u.user_metadata?.name as string) ||
            (u.email?.split("@")[0] ?? "user"),
        });
      }
    })();

    const sub = supabase?.auth.onAuthStateChange((_e, sess) => {
      const u = sess?.user;
      if (u) {
        setUser({
          id: u.id,
          email: u.email || (u.user_metadata?.email as string) || "",
          displayName:
            (u.user_metadata?.full_name as string) ||
            (u.user_metadata?.name as string) ||
            (u.email?.split("@")[0] ?? "user"),
        });
      } else {
        setUser(null);
      }
    });
    return () => { sub?.data.subscription.unsubscribe(); };
  }, []);

  // データ取得
  useEffect(() => {
    (async () => {
      if (!user) return;
      try {
        const mine = await cloudFetchMine(user.id);
        const all = await cloudFetchAll();
        setTasksMine(mine);
        setTasksAll(all);
      } catch (e) { console.error("[initial load]", e); }
    })();
  }, [user?.id]);

  // 表示計算
  const sourceTasks = viewMode === "all" ? tasksAll : tasksMine;

  // 既知メンバー候補
  const memberOptions = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasksAll) if (t.member?.trim()) set.add(t.member.trim());
    const arr = Array.from(set).sort();
    const my = user?.displayName || "";
    if (my && !arr.includes(my)) arr.unshift(my);
    return arr;
  }, [tasksAll, user?.displayName]);

  const membersFilterList = useMemo(() => ["all", ...memberOptions], [memberOptions]);

  const filteredByMember = useMemo(() => {
    if (viewMode !== "all" || memberFilter === "all") return sourceTasks;
    return sourceTasks.filter((t) => (t.member || "-") === memberFilter);
  }, [sourceTasks, viewMode, memberFilter]);

  const tasksForDay = useMemo(
    () => filteredByMember.filter((t) => t.date === date),
    [filteredByMember, date]
  );

  // 並び順：sortOrder→createdAt
  const grouped = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasksForDay) {
      const key = t.member || "-";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => {
        const sa = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
        const sb = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
        if (sa !== sb) return sa - sb;
        return a.createdAt - b.createdAt;
      });
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [tasksForDay]);

  const totals = useMemo(() => {
    const p = tasksForDay.reduce((acc, t) => acc + displayPlanned(t), 0);
    const a = tasksForDay.reduce((acc, t) => acc + (Number.isFinite(t.actualHours) ? t.actualHours : 0), 0);
    return { planned: Math.round(p * 100) / 100, actual: a };
  }, [tasksForDay]);

  // 追加フォーム state
  const [newTask, setNewTask] = useState<{
    name: string;
    category: Category;
    sH: number; sM: number;
    eH: number; eM: number;
    member: string;           // 担当者
    doneCondition: string;    // 完了条件
  }>({
    name: "",
    category: CATEGORIES[0],
    sH: 9, sM: 0,
    eH: 18, eM: 0,
    member: "",
    doneCondition: "",
  });

  useEffect(() => {
    if (user && !newTask.member) {
      setNewTask((v) => ({ ...v, member: user.displayName }));
    }
  }, [user]); // eslint-disable-line

  // 追加
  async function addTask() {
    if (!user) return;
    const startTime = `${pad2(newTask.sH)}:${pad2(newTask.sM)}`;
    const endTime = `${pad2(newTask.eH)}:${pad2(newTask.eM)}`;
    if (!newTask.name.trim()) return;
    if (!newTask.member.trim()) return;

    const planned = diffHoursFromTimes(startTime, endTime) ?? 0;

    // 並び順：同グループの最大+10
    const sameGroup = tasksAll
      .filter(t => t.date === date && t.member === newTask.member && t.ownerId === user.id);
    const maxOrder = sameGroup.reduce((m, t) => Math.max(m, t.sortOrder ?? 0), 0);
    const nextOrder = (maxOrder || 0) + 10;

    const base: Omit<Task, "id"> = {
      name: newTask.name.trim(),
      category: newTask.category,
      plannedHours: planned,
      actualHours: 0,
      status: "未着手",
      date,
      createdAt: Date.now(),
      member: newTask.member.trim(),
      ownerId: user.id,
      retrospective: "",
      startTime,
      endTime,
      doneCondition: newTask.doneCondition.trim(),
      sortOrder: nextOrder,
    };

    try {
      await cloudInsertTask(base, user.id);

      // Googleカレンダー登録（任意）
      if (addToGoogleCalendar) {
        try {
          // ★ 完了条件は常に説明に含める（空でも "(未入力)"）
          const desc =
            `カテゴリ: ${base.category}\n` +
            `担当: ${base.member}\n` +
            `完了条件:\n${(base.doneCondition && base.doneCondition.trim()) ? base.doneCondition.trim() : "(未入力)"}`;

            await createGoogleCalendarEvent(date, startTime, endTime, base.name, desc);
        } catch (e) {
          console.error("[google calendar]", e);
          alert("Googleカレンダー登録に失敗しました。権限やログイン状態を確認してください。");
        }
      }

      const mine = await cloudFetchMine(user.id);
      const all = await cloudFetchAll();
      setTasksMine(mine);
      setTasksAll(all);

      // 入力欄の初期化（担当者は維持）
      setNewTask((v) => ({ ...v, name: "", doneCondition: "" }));
    } catch (e) {
      console.error("[addTask]", e);
      alert("タスク追加に失敗しました。コンソールのエラーを確認してください。");
    }
  }

  async function updateTask(id: string, patch: Partial<Task>) {
    if (!user) return;
    try {
      await cloudUpdateTask(id, user.id, patch);
      const mine = await cloudFetchMine(user.id);
      const all = await cloudFetchAll();
      setTasksMine(mine);
      setTasksAll(all);
    } catch (e) {
      console.error("[updateTask]", e);
      alert("更新に失敗しました。");
    }
  }

  async function deleteTask(id: string) {
    if (!user) return;
    try {
      await cloudDeleteTask(id, user.id);
      const mine = await cloudFetchMine(user.id);
      const all = await cloudFetchAll();
      setTasksMine(mine);
      setTasksAll(all);
    } catch (e) {
      console.error("[deleteTask]", e);
      alert("削除に失敗しました。");
    }
  }

  function logout() { supabase?.auth.signOut(); }

  // ---------- Drag & Drop ----------
  const draggingId = useRef<string | null>(null);
  function handleDragStart(id: string) { draggingId.current = id; }
  function handleDragOver(e: React.DragEvent) { e.preventDefault(); }
  async function handleDrop(targetRow: Task) {
    const dragId = draggingId.current;
    draggingId.current = null;
    if (!dragId || !user) return;
    if (dragId === targetRow.id) return;

    // 同日・同メンバー・自分のタスクのみ並び替え
    const allByGroup = tasksAll
      .filter(t => t.date === targetRow.date && t.member === targetRow.member && t.ownerId === user.id)
      .sort((a, b) => {
        const sa = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
        const sb = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
        if (sa !== sb) return sa - sb;
        return a.createdAt - b.createdAt;
      });

    const fromIdx = allByGroup.findIndex(t => t.id === dragId);
    const toIdx = allByGroup.findIndex(t => t.id === targetRow.id);
    if (fromIdx < 0 || toIdx < 0) return;

    const next = [...allByGroup];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);

    // 10刻みで採番し直し
    const updates = next.map((t, i) => ({ id: t.id, sortOrder: (i + 1) * 10 }));

    try {
      for (const u of updates) {
        await cloudUpdateTask(u.id, user.id, { sortOrder: u.sortOrder });
      }
      const mine = await cloudFetchMine(user.id);
      const all = await cloudFetchAll();
      setTasksMine(mine);
      setTasksAll(all);
    } catch (e) {
      console.error("[reorder]", e);
      alert("並び替えの保存に失敗しました。");
    }
  }

  if (!user) return <CloudLogin onLoggedIn={(u) => setUser(u)} />;

  const myName = user.displayName;
  const canEditTask = (t: Task) => t.ownerId === user.id;

  return (
    <div className="min-h-screen bg-[radial-gradient(1200px_800px_at_10%_-10%,#eef2ff,transparent),radial-gradient(1000px_600px_at_110%_10%,#fdf2f8,transparent),linear-gradient(to_bottom,#ffffff,70%,#f8fafc)] text-slate-900">
      {/* Glass Header */}
      <header className="sticky top-0 z-20 border-b border-slate-200/70 bg-white/70 backdrop-blur-xl">
        <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-2xl bg-slate-900 shadow-sm" />
            <div>
              <h1 className="text-lg sm:text-xl font-bold tracking-tight">1日のタスク管理</h1>
              <p className="text-xs text-slate-500 -mt-0.5">Google連携・クラウド同期</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Chip className="bg-white/70 border-slate-200 text-slate-700 shadow-sm">{myName}</Chip>
            <Button className="bg-white text-slate-700 border border-slate-200 hover:bg-slate-50" onClick={logout}>
              ログアウト
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        {/* フィルタ */}
        <div className="mb-6 grid grid-cols-12 gap-4">
          <div className="col-span-12 sm:col-span-4 md:col-span-3">
            <FieldLabel>対象日</FieldLabel>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="col-span-6 sm:col-span-4 md:col-span-3">
            <FieldLabel>表示範囲</FieldLabel>
            <Select value={viewMode} onChange={(e) => setViewMode(e.target.value as any)}>
              <option value="mine">自分のみ</option>
              <option value="all">全員</option>
            </Select>
          </div>
          {viewMode === "all" && (
            <div className="col-span-6 sm:col-span-4 md:col-span-3">
              <FieldLabel>メンバー</FieldLabel>
              <Select value={memberFilter} onChange={(e) => setMemberFilter(e.target.value)}>
                {membersFilterList.map((m) => <option key={m} value={m}>{m === "all" ? "すべて" : m}</option>)}
              </Select>
            </div>
          )}
          <div className="col-span-12 md:col-span-3 flex items-end">
            <div className="ml-auto flex items-center gap-2 rounded-xl border border-slate-200 bg-white/70 px-3 py-2 text-sm">
              <span className="text-slate-500">合計</span>
              <Chip className="bg-indigo-50 border-indigo-200 text-indigo-700">予定 {totals.planned.toFixed(2)}h</Chip>
              <Chip className="bg-emerald-50 border-emerald-200 text-emerald-700">実績 {totals.actual.toFixed(2)}h</Chip>
            </div>
          </div>
        </div>

        {/* 追加フォーム */}
        <div className="mb-8 rounded-3xl border border-slate-200/70 bg-white/80 backdrop-blur-xl shadow-xl p-5">
          <h2 className="text-base font-semibold mb-4">タスクを追加（所有者: {myName}）</h2>

          <div className="grid grid-cols-12 gap-4 items-start">
            {/* タスク名 */}
            <div className="col-span-12 md:col-span-5">
              <FieldLabel>タスク名</FieldLabel>
              <Input
                placeholder="例: Google広告 週次レポート作成"
                value={newTask.name}
                onChange={(e) => setNewTask((v) => ({ ...v, name: e.target.value }))}
              />
            </div>

            {/* カテゴリ */}
            <div className="col-span-6 md:col-span-2">
              <FieldLabel>カテゴリ</FieldLabel>
              <Select
                value={newTask.category}
                onChange={(e) => setNewTask((v) => ({ ...v, category: e.target.value as Category }))}
              >
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </div>

            {/* 担当者 */}
            <div className="col-span-6 md:col-span-2">
              <FieldLabel>担当者</FieldLabel>
              {assigneeMode === "select" ? (
                <Select
                  value={memberOptions.includes(newTask.member) ? newTask.member : CUSTOM_MEMBER_VALUE}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === CUSTOM_MEMBER_VALUE) {
                      setAssigneeMode("custom");
                      setNewTask((s) => ({ ...s, member: "" }));
                    } else {
                      setNewTask((s) => ({ ...s, member: v }));
                    }
                  }}
                >
                  {memberOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                  <option value={CUSTOM_MEMBER_VALUE}>その他（直接入力）</option>
                </Select>
              ) : (
                <div className="flex gap-2">
                  <Input
                    placeholder="担当者名を入力"
                    value={newTask.member}
                    onChange={(e) => setNewTask((s) => ({ ...s, member: e.target.value }))}
                  />
                  <Button type="button" className="bg-white text-slate-700 border border-slate-200"
                    onClick={() => setAssigneeMode("select")}>
                    OK
                  </Button>
                </div>
              )}
            </div>

            {/* 時間選択（開始・終了） */}
            <div className="col-span-12 md:col-span-3 flex flex-wrap gap-3">
              <div>
                <FieldLabel>開始(時)</FieldLabel>
                <Select
                  className="w-24"
                  value={newTask.sH}
                  onChange={(e) => setNewTask((v) => ({ ...v, sH: parseInt(e.target.value, 10) }))}
                >
                  {H_OPTIONS.map((h) => <option key={h} value={h}>{pad2(h)}</option>)}
                </Select>
              </div>
              <div>
                <FieldLabel>開始(分)</FieldLabel>
                <Select
                  className="w-24"
                  value={newTask.sM}
                  onChange={(e) => setNewTask((v) => ({ ...v, sM: parseInt(e.target.value, 10) }))}
                >
                  {M_OPTIONS.map((m) => <option key={m} value={m}>{pad2(m)}</option>)}
                </Select>
              </div>
              <div>
                <FieldLabel>終了(時)</FieldLabel>
                <Select
                  className="w-24"
                  value={newTask.eH}
                  onChange={(e) => setNewTask((v) => ({ ...v, eH: parseInt(e.target.value, 10) }))}
                >
                  {H_OPTIONS.map((h) => <option key={h} value={h}>{pad2(h)}</option>)}
                </Select>
              </div>
              <div>
                <FieldLabel>終了(分)</FieldLabel>
                <Select
                  className="w-24"
                  value={newTask.eM}
                  onChange={(e) => setNewTask((v) => ({ ...v, eM: parseInt(e.target.value, 10) }))}
                >
                  {M_OPTIONS.map((m) => <option key={m} value={m}>{pad2(m)}</option>)}
                </Select>
              </div>
            </div>

            {/* 完了条件（複数行） */}
            <div className="col-span-12">
              <FieldLabel>完了条件</FieldLabel>
              <TextArea
                rows={3}
                placeholder="このタスクが完了したと判断できる条件を記入（例：資料のドラフト提出＋レビュー反映まで）"
                value={newTask.doneCondition}
                onChange={(e) => setNewTask((v) => ({ ...v, doneCondition: e.target.value }))}
              />
            </div>

            {/* Googleカレンダー登録チェック */}
            <div className="col-span-12">
              <label className="inline-flex items-center gap-2 select-none">
                <input
                  id="addToGoogleCal"
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-200"
                  checked={addToGoogleCalendar}
                  onChange={(e) => setAddToGoogleCalendar(e.target.checked)}
                />
                <span className="text-sm text-slate-700">Googleカレンダーにも登録</span>
              </label>
            </div>

            {/* 追加ボタン */}
            <div className="col-span-12 md:col-span-2 md:col-start-11">
              <Button className="w-full" onClick={addTask}>追加</Button>
            </div>
          </div>
        </div>

        {/* 一覧（横スクロール対応） */}
        <div className="rounded-3xl border border-slate-200/70 bg-white/80 backdrop-blur-xl shadow-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-200/70 flex items-center justify-between">
            <h2 className="text-base font-semibold">タスク一覧（{date}）</h2>
            <div className="hidden sm:flex items-center gap-2">
              <Chip className="bg-indigo-50 border-indigo-200 text-indigo-700">予定 {totals.planned.toFixed(2)}h</Chip>
              <Chip className="bg-emerald-50 border-emerald-200 text-emerald-700">実績 {totals.actual.toFixed(2)}h</Chip>
            </div>
          </div>

          <div className="overflow-x-auto">
            {/* 追加列に合わせ最小幅を拡張 */}
            <table className="min-w-[1500px] text-sm table-fixed">
              <thead>
                {/* ヘッダーは全て中央揃え＆幅広め */}
                <tr className="bg-slate-50/80 border-b border-slate-200/70 text-slate-600">
                  <th className="p-3 font-semibold text-center w-56">タスク名</th>
                  <th className="p-3 font-semibold text-center w-40">カテゴリ</th>
                  <th className="p-3 font-semibold text-center w-28">開始</th>
                  <th className="p-3 font-semibold text-center w-28">終了</th>
                  {/* ★ 工数(予定) と 実績 を開始と同じ w-28 に */}
                  <th className="p-3 font-semibold text-center w-28">工数(予定)</th>
                  <th className="p-3 font-semibold text-center w-28">実績</th>
                  <th className="p-3 font-semibold text-center w-40">ステータス</th>
                  <th className="p-3 font-semibold text-center w-64">完了条件</th>
                  <th className="p-3 font-semibold text-center w-64">振り返り</th>
                  <th className="p-3 font-semibold text-center w-16"></th>
                </tr>
              </thead>
              <tbody onDragOver={handleDragOver}>
                {grouped.length === 0 ? (
                  <tr><td className="p-6 text-slate-500" colSpan={10}>該当タスクがありません。</td></tr>
                ) : (
                  grouped.flatMap(([member, rows]) => {
                    return [
                      <tr key={`header-${member}`} className="bg-slate-50/60 border-y border-slate-200/70">
                        <td className="p-3 font-semibold text-slate-700" colSpan={10}>👤 {member}</td>
                      </tr>,
                      ...rows.map((row) => {
                        const canEdit = canEditTask(row);
                        const planned = displayPlanned(row);
                        return (
                          <tr
                            key={row.id}
                            className="border-b border-slate-200/70 hover:bg-slate-50/50 transition"
                            draggable={canEdit}
                            onDragStart={() => handleDragStart(row.id)}
                            onDrop={() => handleDrop(row)}
                          >
                            <td className="p-3 align-top w-56">
                              <div className="w-full rounded-xl border border-slate-200 bg-slate-50/70 px-2.5 py-1.5">
                                {row.name}
                              </div>
                            </td>
                            <td className="p-3 align-top w-40 text-center">
                              <CategoryPill value={row.category} />
                            </td>
                            <td className="p-3 align-top w-28 text-center">
                              <div className="w-full rounded-xl border border-slate-200 bg-slate-50/70 px-2.5 py-1.5 text-center">
                                {row.startTime ?? "—"}
                              </div>
                            </td>
                            <td className="p-3 align-top w-28 text-center">
                              <div className="w-full rounded-xl border border-slate-200 bg-slate-50/70 px-2.5 py-1.5 text-center">
                                {row.endTime ?? "—"}
                              </div>
                            </td>
                            {/* ★ 工数(予定) を w-28 に */}
                            <td className="p-3 align-top w-28">
                              <div className="w-full rounded-xl border border-slate-200 bg-slate-50/70 px-2.5 py-1.5 text-right font-medium">
                                {planned.toFixed(2)}
                              </div>
                            </td>
                            {/* ★ 実績 も w-28 に */}
                            <td className="p-3 align-top w-28">
                              {canEdit ? (
                                <Input
                                  type="number" min={0} step={0.25}
                                  className="w-full text-right"
                                  value={row.actualHours}
                                  onChange={(e) => updateTask(row.id, { actualHours: Number(e.target.value) })}
                                />
                              ) : (
                                <div className="w-full rounded-xl border border-slate-200 bg-slate-50/70 px-2.5 py-1.5 text-right">
                                  {Number(row.actualHours || 0).toFixed(2)}
                                </div>
                              )}
                            </td>
                            <td className="p-3 align-top w-40 text-center">
                              {canEdit ? (
                                <Select
                                  value={row.status}
                                  onChange={(e) => updateTask(row.id, { status: e.target.value as Status })}
                                >
                                  {STATUS.map((s) => <option key={s} value={s}>{s}</option>)}
                                </Select>
                              ) : (
                                <StatusPill value={row.status} />
                              )}
                            </td>
                            {/* 完了条件（編集可） */}
                            <td className="p-3 align-top w-64">
                              <DoneConditionCell
                                initial={row.doneCondition ?? ""}
                                canEdit={canEdit}
                                onSave={(val) => updateTask(row.id, { doneCondition: val })}
                                placeholder="完了の判断基準を記入"
                              />
                            </td>
                            {/* 振り返り（編集可） */}
                            <td className="p-3 align-top w-64">
                              <RetrospectiveCell
                                initial={row.retrospective ?? ""}
                                canEdit={canEdit}
                                onSave={(val) => updateTask(row.id, { retrospective: val })}
                              />
                            </td>
                            <td className="p-3 align-top w-16 text-center">
                              {canEdit ? (
                                <button
                                  className="text-slate-400 hover:text-rose-600 hover:scale-110 transition-transform"
                                  onClick={() => deleteTask(row.id)}
                                  title="削除"
                                  aria-label="削除"
                                >
                                  ×
                                </button>
                              ) : <span className="text-slate-300">—</span>}
                            </td>
                          </tr>
                        );
                      }),
                    ];
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        <p className="text-xs text-slate-500 mt-6">
          v3.6.0 – カレンダー説明に完了条件を常時含める / 工数(予定)・実績の列幅を w-28 に統一。
        </p>
      </main>
    </div>
  );
}
