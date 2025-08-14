import { useEffect, useMemo, useRef, useState } from "react";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * 1日のタスク管理ツール（Googleログイン専用）
 * v3.0.1
 * - 認証は Supabase OAuth（Google のみ）
 * - 追加フォーム：開始/終了を「時/分(0/15/30/45)」プルダウン（select幅は w-20）
 * - 「Googleカレンダーにも登録」チェックで primary へイベント作成
 * - 一覧はメンバーごとに見出し行でグループ化
 * - 編集可：実績/ステータス/振り返り（IME対応・デバウンス保存）
 * - 仕様：前日から複製なし、メール+パスワードUIなし、ローカル保存なし
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
  plannedHours: number; // 表示は start/end の差分が優先（互換保持）
  actualHours: number;
  status: Status;
  date: string;       // YYYY-MM-DD
  createdAt: number;  // epoch ms
  member: string;
  ownerId?: string;
  retrospective?: string;
  startTime?: string | null; // "HH:MM"
  endTime?: string | null;   // "HH:MM"
};

type CloudUser = { id: string; email: string; displayName: string };

const todayStr = () => new Date().toISOString().slice(0, 10);
const H_OPTIONS = Array.from({ length: 24 }, (_, i) => i); // 0..23
const M_OPTIONS = [0, 15, 30, 45];

// ===== Supabase helpers =====
function noSuchColumn(err: any, col: string) {
  const msg = (err?.message || err?.hint || err?.details || "").toString().toLowerCase();
  return msg.includes(col.toLowerCase()) && (msg.includes("does not exist") || msg.includes("column"));
}
function logErr(where: string, err: any) {
  console.error(`[${where}]`, { message: err?.message, details: err?.details, hint: err?.hint, code: err?.code, err });
}

// ===== Supabase API =====
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
  });
  if (first.error) {
    const payload: any = { ...base };
    if (!noSuchColumn(first.error, "retrospective")) payload.retrospective = t.retrospective ?? null;
    if (!noSuchColumn(first.error, "start_time")) payload.start_time = t.startTime ?? null;
    if (!noSuchColumn(first.error, "end_time")) payload.end_time = t.endTime ?? null;
    if (noSuchColumn(first.error, "retrospective")) delete payload.retrospective;
    if (noSuchColumn(first.error, "start_time")) delete payload.start_time;
    if (noSuchColumn(first.error, "end_time")) delete payload.end_time;

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
    return o;
  };
  const res = await supabase.from("tasks").update(toDb(patch)).eq("id", id).eq("owner_id", ownerId);
  if (res.error) {
    const needRetry =
      ("retrospective" in patch && noSuchColumn(res.error, "retrospective")) ||
      ("startTime" in patch && noSuchColumn(res.error, "start_time")) ||
      ("endTime" in patch && noSuchColumn(res.error, "end_time"));
    if (needRetry) {
      const p2 = { ...patch } as any;
      if (noSuchColumn(res.error, "retrospective")) delete p2.retrospective;
      if (noSuchColumn(res.error, "start_time")) delete p2.startTime;
      if (noSuchColumn(res.error, "end_time")) delete p2.endTime;
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
  };
}

// ===== 時刻・工数ユーティリティ =====
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

// ===== Googleカレンダー連携 =====
async function createGoogleCalendarEvent(
  date: string,
  startTime: string | null | undefined,
  endTime: string | null | undefined,
  title: string,
  description: string
) {
  if (!supabase) throw new Error("Supabase未設定");
  const { data } = await supabase.auth.getSession();
  // Supabase OAuth（Google）で得た access token
  const accessToken = (data.session as any)?.provider_token as string | undefined;

  if (!accessToken) {
    throw new Error("Googleのアクセストークンが見つかりません。Googleでログインし直してください。");
  }

  const start = startTime ? new Date(`${date}T${startTime}:00`) : new Date(`${date}T09:00:00`);
  const end = endTime ? new Date(`${date}T${endTime}:00`) : new Date(start.getTime() + 60 * 60 * 1000);
  if (end <= start) end.setTime(start.getTime() + 60 * 60 * 1000);

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Tokyo";

  const body = {
    summary: title,
    description,
    start: { dateTime: start.toISOString(), timeZone },
    end: { dateTime: end.toISOString(), timeZone },
  };

  const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Calendar API Error: ${res.status} ${text}`);
  }
}

// ===== Googleログイン画面 =====
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
          redirectTo: window.location.origin, // ローカル/Vercel双方OK
        },
      });
      if (error) throw error;
      // リダイレクト後は useEffect で session を拾う
    } catch (e: any) {
      setError(e.message || String(e));
      setLoading(false);
    }
  };

  // リダイレクト後のセッションキャッチ
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
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
      <div className="w-full max-w-md bg-white rounded-2xl shadow p-6 text-center">
        <h1 className="text-2xl font-semibold mb-4">1日のタスク管理 – Googleログイン</h1>
        <p className="text-gray-600 mb-4">Googleアカウントでログインし、カレンダー連携できます。</p>
        {error && <div className="text-red-600 text-sm mb-3">{error}</div>}
        <button
          className="inline-flex items-center gap-2 rounded-xl bg-black text-white px-4 py-2.5 font-medium hover:opacity-90 disabled:opacity-60"
          onClick={signInWithGoogle}
          disabled={loading}
        >
          {loading ? "リダイレクト中..." : "Googleでログイン"}
        </button>
        {!SUPABASE_READY && (
          <p className="text-xs text-orange-600 mt-3">
            ※ Vercelの環境変数に VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY を設定してください
          </p>
        )}
      </div>
    </div>
  );
}

// ===== 振り返りセル（IME対応・デバウンス保存） =====
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
    return <div className="w-full border rounded-lg px-2 py-1 bg-gray-50 whitespace-pre-wrap min-h-[2.5rem]">{(text ?? "").trim() || "—"}</div>;
  }

  return (
    <textarea
      rows={2}
      className="w-full border rounded-lg px-2 py-1"
      placeholder={placeholder}
      value={text}
      onChange={(e) => { const next = e.target.value; setText(next); if (!composingRef.current) scheduleSave(next); }}
      onCompositionStart={() => { composingRef.current = true; if (timerRef.current) window.clearTimeout(timerRef.current); }}
      onCompositionEnd={(e) => { composingRef.current = false; const next = (e.target as HTMLTextAreaElement).value; setText(next); scheduleSave(next); }}
      onBlur={(e) => { if (!composingRef.current) { if (timerRef.current) window.clearTimeout(timerRef.current); onSave(e.currentTarget.value); } }}
    />
  );
}

// ===== App =====
export default function App() {
  const [user, setUser] = useState<CloudUser | null>(null);
  const [date, setDate] = useState<string>(todayStr());
  const [tasksMine, setTasksMine] = useState<Task[]>([]);
  const [tasksAll, setTasksAll] = useState<Task[]>([]);
  const [viewMode, setViewMode] = useState<"mine" | "all">("mine");
  const [memberFilter, setMemberFilter] = useState<string>("all");
  const [addToGoogleCalendar, setAddToGoogleCalendar] = useState<boolean>(false);

  // 起動時：既存セッションで自動ログイン + auth変更監視
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

  // 初期/ユーザ切替時にデータ取得
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

  // 表示用
  const sourceTasks = viewMode === "all" ? tasksAll : tasksMine;
  const members = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasksAll) set.add(t.member || "-");
    return ["all", ...Array.from(set).sort()];
  }, [tasksAll]);
  const filteredByMember = useMemo(() => {
    if (viewMode !== "all" || memberFilter === "all") return sourceTasks;
    return sourceTasks.filter((t) => (t.member || "-") === memberFilter);
  }, [sourceTasks, viewMode, memberFilter]);
  const tasksForDay = useMemo(() => filteredByMember.filter((t) => t.date === date), [filteredByMember, date]);

  const grouped = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasksForDay) {
      const key = t.member || "-";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.createdAt - b.createdAt);
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [tasksForDay]);

  const totals = useMemo(() => {
    const p = tasksForDay.reduce((acc, t) => acc + displayPlanned(t), 0);
    const a = tasksForDay.reduce((acc, t) => acc + (Number.isFinite(t.actualHours) ? t.actualHours : 0), 0);
    return { planned: Math.round(p * 100) / 100, actual: a };
  }, [tasksForDay]);

  // 追加
  async function addTask() {
    if (!user) return;
    const myName = user.displayName;
    const startTime = `${pad2(newTask.sH)}:${pad2(newTask.sM)}`;
    const endTime = `${pad2(newTask.eH)}:${pad2(newTask.eM)}`;

    if (!newTask.name.trim()) return;

    const planned = diffHoursFromTimes(startTime, endTime) ?? 0;

    const base = {
      name: newTask.name.trim(),
      category: newTask.category,
      plannedHours: planned,
      actualHours: 0,
      status: "未着手" as Status,
      date,
      createdAt: Date.now(),
      member: myName,
      ownerId: user.id,
      retrospective: "",
      startTime,
      endTime,
    };

    try {
      await cloudInsertTask(base as Omit<Task, "id">, user.id);

      // Googleカレンダー
      if (addToGoogleCalendar) {
        try {
          await createGoogleCalendarEvent(
            date,
            startTime,
            endTime,
            base.name,
            `カテゴリ: ${base.category}`
          );
        } catch (e) {
          console.error("[google calendar]", e);
          alert("Googleカレンダー登録に失敗しました。権限やログイン状態を確認してください。");
        }
      }

      const mine = await cloudFetchMine(user.id);
      const all = await cloudFetchAll();
      setTasksMine(mine);
      setTasksAll(all);

      // 名前だけクリア（カテゴリ・時間はキープ）
      setNewTask((v) => ({ ...v, name: "" }));
    } catch (e) {
      console.error("[addTask]", e);
      alert("タスク追加に失敗しました。コンソールのエラーを確認してください。");
    }
  }

  // 更新（実績/ステータス/振り返りのみ）
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

  // 追加フォーム state
  const [newTask, setNewTask] = useState<{
    name: string;
    category: Category;
    sH: number; sM: number;
    eH: number; eM: number;
  }>({
    name: "",
    category: CATEGORIES[0],
    sH: 9, sM: 0,
    eH: 18, eM: 0,
  });

  if (!user) {
    return <CloudLogin onLoggedIn={(u) => setUser(u)} />;
  }

  const myName = user.displayName;
  const canEditTask = (t: Task) => t.ownerId === user.id;

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-black" />
            <h1 className="text-lg sm:text-xl font-semibold">1日のタスク管理</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-600">{myName}（Google）</span>
            <button className="text-sm text-gray-500 hover:text-black" onClick={logout}>ログアウト</button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        {/* フィルタ */}
        <div className="flex flex-col md:flex-row md:items-end gap-3 md:gap-4 mb-6">
          <div>
            <label className="block text-sm font-medium mb-1">対象日</label>
            <input type="date" className="border rounded-xl px-3 py-2 bg-white" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">表示範囲</label>
            <select className="border rounded-xl px-3 py-2 bg-white" value={viewMode} onChange={(e) => setViewMode(e.target.value as any)}>
              <option value="mine">自分のみ</option>
              <option value="all">全員</option>
            </select>
          </div>
          {viewMode === "all" && (
            <div>
              <label className="block text-sm font-medium mb-1">メンバー</label>
              <select className="border rounded-xl px-3 py-2 bg-white" value={memberFilter} onChange={(e) => setMemberFilter(e.target.value)}>
                {members.map((m) => <option key={m} value={m}>{m === "all" ? "すべて" : m}</option>)}
              </select>
            </div>
          )}
          <div className="flex-1" />
        </div>

        {/* 追加フォーム */}
        <div className="bg-white rounded-2xl shadow p-4 md:p-5 mb-6">
          <h2 className="text-base font-semibold mb-4">タスクを追加（所有者: {myName}）</h2>

          {/* 12分割で1行に詰める */}
          <div className="grid grid-cols-12 gap-3 items-end">
            {/* タスク名：4カラム */}
            <div className="col-span-12 md:col-span-4">
              <label className="block text-sm font-medium mb-1">タスク名</label>
              <input
                className="w-full border rounded-xl px-3 py-2"
                placeholder="例: Google広告 週次レポート作成"
                value={newTask.name}
                onChange={(e) => setNewTask((v) => ({ ...v, name: e.target.value }))}
              />
            </div>

            {/* カテゴリ：2カラム */}
            <div className="col-span-6 md:col-span-2">
              <label className="block text-sm font-medium mb-1">カテゴリ</label>
              <select
                className="w-full border rounded-xl px-3 py-2"
                value={newTask.category}
                onChange={(e) => setNewTask((v) => ({ ...v, category: e.target.value as Category }))}
              >
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            {/* 開始(時)：1カラム */}
            <div className="col-span-3 md:col-span-1">
              <label className="block text-sm font-medium mb-1">開始(時)</label>
              <select
                className="border rounded-xl px-3 py-2 w-20"
                value={newTask.sH}
                onChange={(e) => setNewTask((v) => ({ ...v, sH: parseInt(e.target.value, 10) }))}
              >
                {H_OPTIONS.map((h) => <option key={h} value={h}>{pad2(h)}</option>)}
              </select>
            </div>

            {/* 開始(分)：1カラム */}
            <div className="col-span-3 md:col-span-1">
              <label className="block text-sm font-medium mb-1">開始(分)</label>
              <select
                className="border rounded-xl px-3 py-2 w-20"
                value={newTask.sM}
                onChange={(e) => setNewTask((v) => ({ ...v, sM: parseInt(e.target.value, 10) }))}
              >
                {M_OPTIONS.map((m) => <option key={m} value={m}>{pad2(m)}</option>)}
              </select>
            </div>

            {/* 終了(時)：1カラム */}
            <div className="col-span-3 md:col-span-1">
              <label className="block text-sm font-medium mb-1">終了(時)</label>
              <select
                className="border rounded-xl px-3 py-2 w-20"
                value={newTask.eH}
                onChange={(e) => setNewTask((v) => ({ ...v, eH: parseInt(e.target.value, 10) }))}
              >
                {H_OPTIONS.map((h) => <option key={h} value={h}>{pad2(h)}</option>)}
              </select>
            </div>

            {/* 終了(分)：1カラム */}
            <div className="col-span-3 md:col-span-1">
              <label className="block text-sm font-medium mb-1">終了(分)</label>
              <select
                className="border rounded-xl px-3 py-2 w-20"
                value={newTask.eM}
                onChange={(e) => setNewTask((v) => ({ ...v, eM: parseInt(e.target.value, 10) }))}
              >
                {M_OPTIONS.map((m) => <option key={m} value={m}>{pad2(m)}</option>)}
              </select>
            </div>

            {/* Googleカレンダー登録チェック：2カラム */}
            <div className="col-span-12 md:col-span-2 flex items-center gap-2">
              <input
                id="addToGoogleCal"
                type="checkbox"
                className="w-4 h-4"
                checked={addToGoogleCalendar}
                onChange={(e) => setAddToGoogleCalendar(e.target.checked)}
              />
              <label htmlFor="addToGoogleCal" className="text-sm text-gray-700">
                Googleカレンダーにも登録
              </label>
            </div>

            {/* 追加ボタン：1カラム */}
            <div className="col-span-12 md:col-span-1">
              <button
                className="w-full rounded-xl bg-black text-white px-4 py-2.5 font-medium hover:opacity-90"
                onClick={addTask}
              >
                追加
              </button>
            </div>
          </div>
        </div>

        {/* 一覧 */}
        <div className="bg-white rounded-2xl shadow overflow-hidden">
          <div className="px-4 py-3 border-b flex items-center justify-between">
            <h2 className="text-base font-semibold">タスク一覧（{date}）</h2>
            <div className="text-sm text-gray-600">
              合計: 予定 {totals.planned.toFixed(2)}h / 実績 {totals.actual.toFixed(2)}h
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left border-b">
                  <th className="p-2">タスク名</th>
                  <th className="p-2">カテゴリ</th>
                  <th className="p-2 w-24">開始</th>
                  <th className="p-2 w-24">終了</th>
                  <th className="p-2 w-28">工数(予定)</th>
                  <th className="p-2 w-28">実績</th>
                  <th className="p-2 w-32">ステータス</th>
                  <th className="p-2">振り返り</th>
                  <th className="p-2 w-16 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {grouped.length === 0 ? (
                  <tr><td className="p-4 text-gray-500" colSpan={9}>該当タスクがありません。</td></tr>
                ) : (
                  grouped.flatMap(([member, rows]) => {
                    return [
                      <tr key={`header-${member}`} className="bg-gray-100 border-b">
                        <td className="p-2 font-semibold" colSpan={9}>👤 {member}</td>
                      </tr>,
                      ...rows.map((row) => {
                        const canEdit = canEditTask(row);
                        const planned = displayPlanned(row);
                        return (
                          <tr key={row.id} className="border-b last:border-b-0">
                            <td className="p-2 align-top">
                              <div className="w-full border rounded-lg px-2 py-1 bg-gray-50">{row.name}</div>
                            </td>
                            <td className="p-2 align-top">
                              <div className="w-full border rounded-lg px-2 py-1 bg-gray-50">{row.category}</div>
                            </td>
                            <td className="p-2 align-top w-24">
                              <div className="w-full border rounded-lg px-2 py-1 bg-gray-50 text-center">{row.startTime ?? "—"}</div>
                            </td>
                            <td className="p-2 align-top w-24">
                              <div className="w-full border rounded-lg px-2 py-1 bg-gray-50 text-center">{row.endTime ?? "—"}</div>
                            </td>
                            <td className="p-2 align-top w-28">
                              <div className="w-full border rounded-lg px-2 py-1 bg-gray-50 text-right">{planned.toFixed(2)}</div>
                            </td>
                            <td className="p-2 align-top w-28">
                              {canEdit ? (
                                <input
                                  type="number" min={0} step={0.25}
                                  className="w-full border rounded-lg px-2 py-1"
                                  value={row.actualHours}
                                  onChange={(e) => updateTask(row.id, { actualHours: Number(e.target.value) })}
                                />
                              ) : (
                                <div className="w-full border rounded-lg px-2 py-1 bg-gray-50 text-right">
                                  {Number(row.actualHours || 0).toFixed(2)}
                                </div>
                              )}
                            </td>
                            <td className="p-2 align-top w-32">
                              {canEdit ? (
                                <select
                                  className="w-full border rounded-lg px-2 py-1"
                                  value={row.status}
                                  onChange={(e) => updateTask(row.id, { status: e.target.value as Status })}
                                >
                                  {STATUS.map((s) => <option key={s} value={s}>{s}</option>)}
                                </select>
                              ) : (
                                <div className="w-full border rounded-lg px-2 py-1 bg-gray-50">{row.status}</div>
                              )}
                            </td>
                            <td className="p-2 align-top">
                              <RetrospectiveCell
                                initial={row.retrospective ?? ""}
                                canEdit={canEdit}
                                onSave={(val) => updateTask(row.id, { retrospective: val })}
                              />
                            </td>
                            <td className="p-2 align-top w-16 text-right">
                              {canEdit ? (
                                <button className="text-red-600 hover:underline" onClick={() => deleteTask(row.id)} title="削除">
                                  削除
                                </button>
                              ) : <span className="text-gray-400">-</span>}
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

        <p className="text-xs text-gray-500 mt-6">
          v3.0.1 – Googleログイン専用、追加時にカレンダー登録（任意）。開始/終了はプルダウン、一覧はメンバー見出しでグループ化。
        </p>
      </main>
    </div>
  );
}
