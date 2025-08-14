import { useEffect, useMemo, useRef, useState } from "react";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * 1日のタスク管理ツール
 * v2.8.2
 * - 追加フォーム: 開始/終了 時刻 (24h) を「時」「分(0/15/30/45)」のプルダウンで入力
 * - 工数(予定)の手動入力は廃止。一覧では開始⇄終了の差分から自動算出
 * - タスク名/カテゴリ/工数(予定)は一覧で編集不可のまま
 * - 振り返りはIME対応(変換中は保存しない/確定・デバウンス保存)
 * - Supabase: start_time/end_time/retrospective が無くてもフォールバックで動作
 * - UI: 時/分のセレクト幅を w-20 でコンパクト化
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
  plannedHours: number; // 互換用に保持はするが、表示は start/end の差分を優先
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

type LocalUser = { username: string };
type CloudUser = { id: string; email: string; displayName: string };
type User =
  | { mode: "local"; local: LocalUser }
  | { mode: "cloud"; cloud: CloudUser };

const todayStr = () => new Date().toISOString().slice(0, 10);
// 時/分プルダウン
const H_OPTIONS = Array.from({ length: 24 }, (_, i) => i); // 0..23
const M_OPTIONS = [0, 15, 30, 45];

const isCloud = () => SUPABASE_READY;
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// ===== Local Storage =====
const storageKey = (u: string) => `daily_tasks_v2__${u}`;
function loadLocalTasks(username: string): Task[] {
  try {
    const raw = localStorage.getItem(storageKey(username));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return (arr as Task[]).map((t) => ({ ...t, member: (t as any).member || username }));
  } catch { return []; }
}
function loadLocalAll(): Task[] {
  const all: Task[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (!key.startsWith("daily_tasks_v2__")) continue;
    const username = key.replace("daily_tasks_v2__", "");
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) continue;
      for (const t of arr as Task[]) {
        all.push({ ...t, member: (t as any).member || username });
      }
    } catch {}
  }
  return all;
}
function saveLocalTasks(username: string, tasks: Task[]) {
  localStorage.setItem(storageKey(username), JSON.stringify(tasks));
}

// ===== Supabase helpers =====
function noSuchColumn(err: any, col: string) {
  const msg = (err?.message || err?.hint || err?.details || "").toString().toLowerCase();
  return msg.includes(col.toLowerCase()) && (msg.includes("does not exist") || msg.includes("column"));
}
function logErr(where: string, err: any) {
  console.error(`[${where}]`, { message: err?.message, details: err?.details, hint: err?.hint, code: err?.code, err });
}

// ===== Supabase API =====
async function cloudSignIn(email: string, password: string) {
  if (!supabase) throw new Error("Supabase未設定");
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) { logErr("signIn", error); throw error; }
  return data.user;
}
async function cloudSignUp(email: string, password: string) {
  if (!supabase) throw new Error("Supabase未設定");
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) { logErr("signUp", error); throw error; }
  return data.user;
}

async function cloudInsertTask(t: Omit<Task, "id">, ownerId: string) {
  if (!supabase) throw new Error("Supabase未設定");
  const base: any = {
    owner_id: ownerId,
    member: t.member,
    name: t.name,
    category: t.category,
    planned_hours: t.plannedHours, // 互換
    actual_hours: t.actualHours,
    status: t.status,
    date: t.date,
    created_at: new Date(t.createdAt).toISOString(),
  };
  // まず全部含めて試す
  const first = await supabase.from("tasks").insert({
    ...base,
    retrospective: t.retrospective ?? null,
    start_time: t.startTime ?? null,
    end_time: t.endTime ?? null,
  });
  if (first.error) {
    // 列欠如は外してリトライ
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
    if (p.plannedHours !== undefined) o.planned_hours = p.plannedHours; // 互換
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

// ===== 時刻・工数の算出 =====
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
  if (diff <= 0) return 0; // 同日扱い。終了≦開始なら0h
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

// ===== ログインUI =====
function CloudLogin({ onLoggedIn }: { onLoggedIn: (u: CloudUser) => void }) {
  const [isSignup, setIsSignup] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit() {
    try {
      setLoading(true);
      setError(null);
      if (!SUPABASE_READY) throw new Error("SupabaseのURL/AnonKeyが未設定です。");
      const u = isSignup ? await cloudSignUp(email, password) : await cloudSignIn(email, password);
      if (!u) throw new Error("Auth failed");
      onLoggedIn({ id: u.id, email: u.email || email, displayName: displayName || email.split("@")[0] });
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
      <div className="w-full max-w-md bg-white rounded-2xl shadow p-6">
        <h1 className="text-2xl font-semibold mb-4">1日のタスク管理 – クラウド同期</h1>
        <p className="text-gray-600 mb-4">メールとパスワードで{isSignup ? "サインアップ" : "ログイン"}。</p>
        <div className="grid gap-3">
          <div>
            <label className="block text-sm font-medium mb-1">メール</label>
            <input className="w-full border rounded-xl px-3 py-2" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">パスワード</label>
            <input type="password" className="w-full border rounded-xl px-3 py-2" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">表示名（メンバー名）</label>
            <input className="w-full border rounded-xl px-3 py-2" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="例: yamada" />
          </div>
          {error && <div className="text-red-600 text-sm">{error}</div>}
          <button className="rounded-xl bg-black text-white py-2.5 font-medium hover:opacity-90" onClick={submit} disabled={loading}>
            {loading ? "処理中..." : isSignup ? "サインアップ" : "ログイン"}
          </button>
          <button className="text-sm text-gray-600 hover:text-black" onClick={() => setIsSignup((v) => !v)}>
            {isSignup ? "既にアカウントがあります" : "初めての方はこちら（サインアップ）"}
          </button>
          {!SUPABASE_READY && <p className="text-xs text-orange-600">※ Vercelの環境変数に VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY を設定してください</p>}
        </div>
      </div>
    </div>
  );
}

function LocalLogin({ onLoggedIn }: { onLoggedIn: (u: LocalUser) => void }) {
  const [username, setUsername] = useState("");
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
      <div className="w-full max-w-md bg-white rounded-2xl shadow p-6">
        <h1 className="text-2xl font-semibold mb-4">1日のタスク管理 – ローカル</h1>
        <p className="text-gray-600 mb-6">ユーザー名でログイン（ローカル保存のみ / サーバー不要）</p>
        <label className="block text-sm font-medium mb-1">ユーザー名</label>
        <input className="w-full border rounded-xl px-3 py-2" placeholder="例: yamada" value={username} onChange={(e) => setUsername(e.target.value.trim())} />
        <button className="mt-4 w-full rounded-xl bg-black text-white py-2.5 font-medium hover:opacity-90" onClick={() => username && onLoggedIn({ username })}>
          ログイン
        </button>
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
  const [user, setUser] = useState<User | null>(null);
  const [date, setDate] = useState<string>(todayStr());
  const [tasksMine, setTasksMine] = useState<Task[]>([]);
  const [tasksAll, setTasksAll] = useState<Task[]>([]);
  const [viewMode, setViewMode] = useState<"mine" | "all">("mine");
  const [memberFilter, setMemberFilter] = useState<string>("all");

  // 追加フォーム: 基本項目 + 時分セレクト
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

  // 初期ロード
  useEffect(() => {
    (async () => {
      if (!user) return;
      try {
        if (user.mode === "local") {
          setTasksMine(loadLocalTasks(user.local.username));
          setTasksAll(loadLocalAll());
        } else {
          const mine = await cloudFetchMine(user.cloud.id);
          const all = await cloudFetchAll();
          setTasksMine(mine);
          setTasksAll(all);
        }
      } catch (e) { console.error("[initial load]", e); }
    })();
  }, [user && (user.mode === "local" ? user.local.username : user.cloud.id)]);

  // Local保存
  useEffect(() => {
    if (!user || user.mode !== "local") return;
    saveLocalTasks(user.local.username, tasksMine);
    setTasksAll(loadLocalAll());
  }, [tasksMine, user && user.mode === "local" ? user.local.username : null]);

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
    if (!newTask.name.trim()) return;

    const startTime = `${pad2(newTask.sH)}:${pad2(newTask.sM)}`;
    const endTime = `${pad2(newTask.eH)}:${pad2(newTask.eM)}`;
    const planned = diffHoursFromTimes(startTime, endTime) ?? 0;

    const base = {
      name: newTask.name.trim(),
      category: newTask.category,
      plannedHours: planned, // 互換のため保存（表示はstart/end差分を使用）
      actualHours: 0,
      status: "未着手" as Status,
      date,
      createdAt: Date.now(),
      member: user.mode === "local" ? user.local.username : user.cloud.displayName,
      ownerId: user.mode === "cloud" ? user.cloud.id : undefined,
      retrospective: "",
      startTime,
      endTime,
    };

    try {
      if (user.mode === "local") {
        const withId: Task = { id: uid(), ...base };
        setTasksMine((prev: Task[]) => [...prev, withId]);
      } else {
        await cloudInsertTask(base as Omit<Task, "id">, user.cloud.id);
        const mine = await cloudFetchMine(user.cloud.id);
        const all = await cloudFetchAll();
        setTasksMine(mine);
        setTasksAll(all);
      }
      // 入力値キープ（カテゴリ・時刻）は残し、名前だけクリア
      setNewTask((v) => ({ ...v, name: "" }));
    } catch (e) {
      console.error("[addTask]", e);
      alert("タスク追加に失敗しました。コンソールのエラーを確認してください。");
    }
  }

  // 更新（実績/ステータス/振り返りのみ。開始/終了・名前・カテゴリ・工数(予定)は編集禁止）
  async function updateTask(id: string, patch: Partial<Task>, canEdit: boolean) {
    if (!canEdit || !user) return;
    try {
      if (user.mode === "local") {
        setTasksMine((prev: Task[]) => prev.map((t) => (t.id === id ? ({ ...t, ...patch } as Task) : t)));
      } else {
        await cloudUpdateTask(id, user.cloud.id, patch);
        const mine = await cloudFetchMine(user.cloud.id);
        const all = await cloudFetchAll();
        setTasksMine(mine);
        setTasksAll(all);
      }
    } catch (e) {
      console.error("[updateTask]", e);
      alert("更新に失敗しました。");
    }
  }

  async function deleteTask(id: string, canEdit: boolean) {
    if (!canEdit || !user) return;
    try {
      if (user.mode === "local") {
        setTasksMine((prev: Task[]) => prev.filter((t) => t.id !== id));
      } else {
        await cloudDeleteTask(id, user.cloud.id);
        const mine = await cloudFetchMine(user.cloud.id);
        const all = await cloudFetchAll();
        setTasksMine(mine);
        setTasksAll(all);
      }
    } catch (e) {
      console.error("[deleteTask]", e);
      alert("削除に失敗しました。");
    }
  }

  function logout() { setUser(null); }

  if (!user) {
    return isCloud()
      ? <CloudLogin onLoggedIn={(u) => setUser({ mode: "cloud", cloud: u })} />
      : <LocalLogin onLoggedIn={(u) => setUser({ mode: "local", local: u })} />;
  }

  const myName = user.mode === "local" ? user.local.username : user.cloud.displayName;
  const canEditTask = (t: Task) => (user.mode === "local" ? t.member === myName : t.ownerId === user.cloud.id);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-black" />
            <h1 className="text-lg sm:text-xl font-semibold">1日のタスク管理</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-600">
              {myName}{isCloud() ? "（クラウド）" : "（ローカル）"}
            </span>
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
          <button
            className="rounded-xl border px-3 py-2 hover:bg-white"
            title="前日タスクを複製（実績・振り返りはリセット）"
            onClick={() => {
              if (user.mode === "local") {
                const dt = new Date(date); dt.setDate(dt.getDate() - 1);
                const y = dt.toISOString().slice(0, 10);
                const yTasks = tasksMine.filter((t) => t.date === y);
                if (!yTasks.length) return;
                const clones: Task[] = yTasks.map((t) => ({
                  ...t, id: uid(), date,
                  actualHours: 0, status: "未着手",
                  createdAt: Date.now(), retrospective: "",
                  startTime: t.startTime ?? null,
                  endTime: t.endTime ?? null,
                  plannedHours: displayPlanned(t), // 互換（表示は時刻差分）
                }));
                setTasksMine((prev: Task[]) => [...prev, ...clones]);
              } else {
                (async () => {
                  const dt = new Date(date); dt.setDate(dt.getDate() - 1);
                  const y = dt.toISOString().slice(0, 10);
                  const yTasks = tasksMine.filter((t) => t.date === y);
                  for (const t of yTasks) {
                    const planned = displayPlanned(t);
                    await cloudInsertTask({
                      name: t.name, category: t.category,
                      plannedHours: planned, actualHours: 0,
                      status: "未着手", date, createdAt: Date.now(),
                      member: myName, ownerId: user.cloud.id,
                      retrospective: "", startTime: t.startTime ?? null, endTime: t.endTime ?? null
                    } as Omit<Task, "id">, user.cloud.id);
                  }
                  const mine = await cloudFetchMine(user.cloud.id);
                  const all = await cloudFetchAll();
                  setTasksMine(mine); setTasksAll(all);
                })();
              }
            }}
          >前日から複製</button>
        </div>

        {/* 追加フォーム（工数予定は無くし、時刻入力を追加） */}
        <div className="bg-white rounded-2xl shadow p-4 md:p-5 mb-6">
          <h2 className="text-base font-semibold mb-4">タスクを追加（所有者: {myName}）</h2>
          <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium mb-1">タスク名</label>
              <input
                className="w-full border rounded-xl px-3 py-2"
                placeholder="例: Google広告 週次レポート作成"
                value={newTask.name}
                onChange={(e) => setNewTask((v) => ({ ...v, name: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">カテゴリ</label>
              <select
                className="w-full border rounded-xl px-3 py-2"
                value={newTask.category}
                onChange={(e) => setNewTask((v) => ({ ...v, category: e.target.value as Category }))}
              >
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            {/* 開始 */}
            <div>
              <label className="block text-sm font-medium mb-1">開始(時)</label>
              <select
                className="border rounded-xl px-3 py-2 w-20"   // 幅を絞る
                value={newTask.sH}
                onChange={(e) => setNewTask((v) => ({ ...v, sH: parseInt(e.target.value, 10) }))}
              >
                {H_OPTIONS.map((h) => <option key={h} value={h}>{pad2(h)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">開始(分)</label>
              <select
                className="border rounded-xl px-3 py-2 w-20"   // 幅を絞る
                value={newTask.sM}
                onChange={(e) => setNewTask((v) => ({ ...v, sM: parseInt(e.target.value, 10) }))}
              >
                {M_OPTIONS.map((m) => <option key={m} value={m}>{pad2(m)}</option>)}
              </select>
            </div>

            {/* 終了 */}
            <div>
              <label className="block text-sm font-medium mb-1">終了(時)</label>
              <select
                className="border rounded-xl px-3 py-2 w-20"   // 幅を絞る
                value={newTask.eH}
                onChange={(e) => setNewTask((v) => ({ ...v, eH: parseInt(e.target.value, 10) }))}
              >
                {H_OPTIONS.map((h) => <option key={h} value={h}>{pad2(h)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">終了(分)</label>
              <select
                className="border rounded-xl px-3 py-2 w-20"   // 幅を絞る
                value={newTask.eM}
                onChange={(e) => setNewTask((v) => ({ ...v, eM: parseInt(e.target.value, 10) }))}
              >
                {M_OPTIONS.map((m) => <option key={m} value={m}>{pad2(m)}</option>)}
              </select>
            </div>

            <div className="md:col-span-6 flex items-end">
              <button className="w-full md:w-auto rounded-xl bg-black text-white px-4 py-2.5 font-medium hover:opacity-90" onClick={addTask}>
                追加
              </button>
            </div>
          </div>
        </div>

        {/* 一覧 */}
        <div className="bg-white rounded-2xl shadow overflow-hidden">
          <div className="px-4 py-3 border-b flex itemsセンター justify-between">
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
                  grouped.map(([member, rows]) => (
                    <>
                      <tr key={`header-${member}`} className="bg-gray-100 border-b">
                        <td className="p-2 font-semibold" colSpan={9}>👤 {member}</td>
                      </tr>
                      {rows.map((row) => {
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
                                  onChange={(e) => updateTask(row.id, { actualHours: Number(e.target.value) }, true)}
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
                                  onChange={(e) => updateTask(row.id, { status: e.target.value as Status }, true)}
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
                                onSave={(val) => updateTask(row.id, { retrospective: val }, true)}
                              />
                            </td>
                            <td className="p-2 align-top w-16 text-right">
                              {canEdit ? (
                                <button className="text-red-600 hover:underline" onClick={() => deleteTask(row.id, true)} title="削除">
                                  削除
                                </button>
                              ) : <span className="text-gray-400">-</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <p className="text-xs text-gray-500 mt-6">
          v2.8.2 – 追加時に開始/終了を選択、工数(予定)は自動算出。セレクト幅をw-20に最適化。</p>
      </main>
    </div>
  );
}

// ===== Self test =====
(function selfTest() {
  try {
    console.assert(/\d{4}-\d{2}-\d{2}/.test(todayStr()), "todayStr");
    const t = diffHoursFromTimes("09:00", "18:15"); // 9.25
    console.assert(Math.abs((t ?? 0) - 9.25) < 1e-9, "diff 9:00→18:15");
    const bad = diffHoursFromTimes("18:00", "09:00"); // 0
    console.assert((bad ?? -1) === 0, "end<=start => 0");
    const setU = new Set<string>(); for (let i = 0; i < 50; i++) setU.add(uid()); console.assert(setU.size === 50, "uid uniqueness");
  } catch (e) { console.warn("Self test failed:", e); }
})();
