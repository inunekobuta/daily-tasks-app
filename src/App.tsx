import { useEffect, useMemo, useState } from "react";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ==========================================================
// 1日のタスク管理ツール（ログイン・工数/実績/ステータス/メンバー）
// v2.4 – Vercel向け修正
//  - 環境変数: import.meta.env.VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
//  - Insert時に id を送らず DB 自動採番（UUID）
//  - setState アップデータの型注釈
// ==========================================================

// ====== 環境変数（Vercel / Vite） ======
const SUPABASE_URL: string = (import.meta as any)?.env?.VITE_SUPABASE_URL || "";
const SUPABASE_ANON_KEY: string = (import.meta as any)?.env?.VITE_SUPABASE_ANON_KEY || "";

// Supabaseが設定されているか
const SUPABASE_READY = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
const supabase: SupabaseClient | null = SUPABASE_READY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

// ====== 型・定数 ======
const CATEGORIES = ["広告運用", "SEO", "新規営業", "AF", "その他"] as const;
const STATUS = ["未着手", "仕掛中", "完了"] as const;

type Category = typeof CATEGORIES[number];
type Status = typeof STATUS[number];

type Task = {
  id: string; // uuid or local id
  name: string;
  category: Category;
  plannedHours: number;
  actualHours: number;
  status: Status;
  date: string; // YYYY-MM-DD
  createdAt: number; // epoch ms
  member: string; // 表示名
  ownerId?: string; // cloud の auth.user.id
};

type LocalUser = { username: string };
type CloudUser = { id: string; email: string; displayName: string };

type User =
  | { mode: "local"; local: LocalUser }
  | { mode: "cloud"; cloud: CloudUser };

// ====== 共通ユーティリティ ======
const todayStr = () => new Date().toISOString().slice(0, 10);
const hoursOptions = Array.from({ length: 25 }, (_, i) => i * 0.5);
const isCloud = () => SUPABASE_READY;
function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// ====== Local Storage ======
function storageKey(username: string) {
  return `daily_tasks_v2__${username}`;
}
function loadLocalTasks(username: string): Task[] {
  try {
    const raw = localStorage.getItem(storageKey(username));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return (arr as Task[]).map((t) => ({ ...t, member: (t as any).member || username }));
  } catch {
    return [];
  }
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

// ====== Supabase ======
async function cloudSignIn(email: string, password: string) {
  if (!supabase) throw new Error("Supabase未設定");
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}
async function cloudSignUp(email: string, password: string) {
  if (!supabase) throw new Error("Supabase未設定");
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data.user;
}
/** 重要：id は送らない（DBの default gen_random_uuid() に任せる） */
async function cloudInsertTask(t: Omit<Task, "id">, ownerId: string) {
  if (!supabase) throw new Error("Supabase未設定");
  const payload = {
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
  const { error } = await supabase.from("tasks").insert(payload);
  if (error) throw error;
}
async function cloudUpdateTask(id: string, ownerId: string, patch: Partial<Task>) {
  if (!supabase) throw new Error("Supabase未設定");
  const payload: any = {};
  if (patch.actualHours !== undefined) payload.actual_hours = patch.actualHours;
  if (patch.status !== undefined) payload.status = patch.status;
  if (patch.plannedHours !== undefined) payload.planned_hours = patch.plannedHours;
  const { error } = await supabase.from("tasks").update(payload).eq("id", id).eq("owner_id", ownerId);
  if (error) throw error;
}
async function cloudDeleteTask(id: string, ownerId: string) {
  if (!supabase) throw new Error("Supabase未設定");
  const { error } = await supabase.from("tasks").delete().eq("id", id).eq("owner_id", ownerId);
  if (error) throw error;
}
async function cloudFetchAll(): Promise<Task[]> {
  if (!supabase) throw new Error("Supabase未設定");
  const { data, error } = await supabase
    .from("tasks")
    .select("id, owner_id, member, name, category, planned_hours, actual_hours, status, date, created_at");
  if (error) throw error;
  return (data || []).map((r: any) => ({
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
  }));
}
async function cloudFetchMine(ownerId: string): Promise<Task[]> {
  if (!supabase) throw new Error("Supabase未設定");
  const { data, error } = await supabase
    .from("tasks")
    .select("id, owner_id, member, name, category, planned_hours, actual_hours, status, date, created_at")
    .eq("owner_id", ownerId);
  if (error) throw error;
  return (data || []).map((r: any) => ({
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
  }));
}

// ====== UI ======
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

function NumberWheel({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <select className="w-full border rounded-xl px-3 py-2 bg-white" value={value} onChange={(e) => onChange(parseFloat(e.target.value))}>
      {hoursOptions.map((h) => (
        <option key={h} value={h}>
          {h.toFixed(1)}
        </option>
      ))}
    </select>
  );
}

function TaskRow({
  t,
  onUpdate,
  onDelete,
  canEdit,
}: {
  t: Task;
  onUpdate: (patch: Partial<Task>) => void;
  onDelete: () => void;
  canEdit: boolean;
}) {
  return (
    <tr className="border-b last:border-b-0">
      <td className="p-2 align-top whitespace-nowrap">
        <div className="w-full border rounded-lg px-2 py-1 bg-gray-50">{t.member || "-"}</div>
      </td>
      <td className="p-2 align-top">
        <div className="w-full border rounded-lg px-2 py-1 bg-gray-50">{t.name}</div>
      </td>
      <td className="p-2 align-top">
        <div className="w-full border rounded-lg px-2 py-1 bg-gray-50">{t.category}</div>
      </td>
      <td className="p-2 align-top w-32">
        <div className="w-full border rounded-lg px-2 py-1 bg-gray-50 text-right">{t.plannedHours.toFixed(1)}</div>
      </td>
      <td className="p-2 align-top w-28">
        {canEdit ? (
          <input
            type="number"
            min={0}
            step={0.25}
            className="w-full border rounded-lg px-2 py-1"
            value={t.actualHours}
            onChange={(e) => onUpdate({ actualHours: Number(e.target.value) })}
          />
        ) : (
          <div className="w-full border rounded-lg px-2 py-1 bg-gray-50 text-right">{Number(t.actualHours || 0).toFixed(2)}</div>
        )}
      </td>
      <td className="p-2 align-top w-32">
        {canEdit ? (
          <select className="w-full border rounded-lg px-2 py-1" value={t.status} onChange={(e) => onUpdate({ status: e.target.value as Status })}>
            {STATUS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : (
          <div className="w-full border rounded-lg px-2 py-1 bg-gray-50">{t.status}</div>
        )}
      </td>
      <td className="p-2 align-top w-16 text-right">
        {canEdit ? (
          <button className="text-red-600 hover:underline" onClick={onDelete} title="削除">
            削除
          </button>
        ) : (
          <span className="text-gray-400">-</span>
        )}
      </td>
    </tr>
  );
}

// ====== App ======
export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [date, setDate] = useState<string>(todayStr());

  const [tasksMine, setTasksMine] = useState<Task[]>([]);
  const [tasksAll, setTasksAll] = useState<Task[]>([]);
  const [viewMode, setViewMode] = useState<"mine" | "all">("mine");
  const [memberFilter, setMemberFilter] = useState<string>("all");

  // 初期ログイン画面
  if (!user) {
    if (isCloud()) {
      return <CloudLogin onLoggedIn={(u) => setUser({ mode: "cloud", cloud: u })} />;
    }
    return <LocalLogin onLoggedIn={(u) => setUser({ mode: "local", local: u })} />;
  }

  // ロード
  useEffect(() => {
    (async () => {
      if (!user) return;
      if (user.mode === "local") {
        setTasksMine(loadLocalTasks(user.local.username));
        setTasksAll(loadLocalAll());
      } else {
        const mine = await cloudFetchMine(user.cloud.id);
        const all = await cloudFetchAll();
        setTasksMine(mine);
        setTasksAll(all);
      }
    })();
  }, [user && (user.mode === "local" ? user.local.username : user.cloud.id)]);

  // Local: 保存 & 全体再構築
  useEffect(() => {
    if (!user || user.mode !== "local") return;
    saveLocalTasks(user.local.username, tasksMine);
    setTasksAll(loadLocalAll());
  }, [tasksMine, user && user.mode === "local" ? user.local.username : null]);

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

  const tasksForDay = useMemo(
    () => filteredByMember.filter((t) => t.date === date).sort((a, b) => a.createdAt - b.createdAt),
    [filteredByMember, date]
  );

  const totals = useMemo(() => {
    const p = tasksForDay.reduce((acc, t) => acc + (Number.isFinite(t.plannedHours) ? t.plannedHours : 0), 0);
    const a = tasksForDay.reduce((acc, t) => acc + (Number.isFinite(t.actualHours) ? t.actualHours : 0), 0);
    return { planned: p, actual: a };
  }, [tasksForDay]);

  const [newTask, setNewTask] = useState<Pick<Task, "name" | "category" | "plannedHours">>({
    name: "",
    category: CATEGORIES[0],
    plannedHours: 1,
  });

  async function addTask() {
    if (!user) return;
    if (!newTask.name.trim()) return;

    const base = {
      name: newTask.name.trim(),
      category: newTask.category,
      plannedHours: newTask.plannedHours,
      actualHours: 0,
      status: "未着手" as Status,
      date,
      createdAt: Date.now(),
      member: user.mode === "local" ? user.local.username : user.cloud.displayName,
      ownerId: user.mode === "cloud" ? user.cloud.id : undefined,
    };

    if (user.mode === "local") {
      const withId: Task = { id: uid(), ...base };
      setTasksMine((prev: Task[]) => [...prev, withId]);
      setNewTask({ name: "", category: newTask.category, plannedHours: newTask.plannedHours });
      return;
    }

    // cloud（idは送らない）
    await cloudInsertTask(base as Omit<Task, "id">, user.cloud.id);
    const mine = await cloudFetchMine(user.cloud.id);
    const all = await cloudFetchAll();
    setTasksMine(mine);
    setTasksAll(all);
    setNewTask({ name: "", category: newTask.category, plannedHours: newTask.plannedHours });
  }

  async function updateTask(id: string, patch: Partial<Task>, canEdit: boolean) {
    if (!canEdit) return;
    if (!user) return;

    if (user.mode === "local") {
      setTasksMine((prev: Task[]) => prev.map((t) => (t.id === id ? ({ ...t, ...patch } as Task) : t)));
      return;
    }

    await cloudUpdateTask(id, user.cloud.id, patch);
    const mine = await cloudFetchMine(user.cloud.id);
    const all = await cloudFetchAll();
    setTasksMine(mine);
    setTasksAll(all);
  }

  async function deleteTask(id: string, canEdit: boolean) {
    if (!canEdit) return;
    if (!user) return;

    if (user.mode === "local") {
      setTasksMine((prev: Task[]) => prev.filter((t) => t.id !== id));
      return;
    }

    await cloudDeleteTask(id, user.cloud.id);
    const mine = await cloudFetchMine(user.cloud.id);
    const all = await cloudFetchAll();
    setTasksMine(mine);
    setTasksAll(all);
  }

  function logout() {
    setUser(null);
  }

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
              {user.mode === "local" ? user.local.username : user.cloud.displayName}
              {isCloud() ? "（クラウド）" : "（ローカル）"}
            </span>
            <button className="text-sm text-gray-500 hover:text-black" onClick={logout}>
              ログアウト
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
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
                {members.map((m) => (
                  <option key={m} value={m}>
                    {m === "all" ? "すべて" : m}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex-1" />
          <button
            className="rounded-xl border px-3 py-2 hover:bg-white"
            onClick={() => {
              // 前日から複製（自分のタスクのみ）
              if (user.mode === "local") {
                const dt = new Date(date);
                dt.setDate(dt.getDate() - 1);
                const y = dt.toISOString().slice(0, 10);
                const yTasks = tasksMine.filter((t) => t.date === y);
                if (!yTasks.length) return;
                const clones: Task[] = yTasks.map((t) => ({
                  ...t,
                  id: uid(),
                  date,
                  actualHours: 0,
                  status: "未着手",
                  createdAt: Date.now(),
                }));
                setTasksMine((prev: Task[]) => [...prev, ...clones]);
              } else {
                (async () => {
                  const dt = new Date(date);
                  dt.setDate(dt.getDate() - 1);
                  const y = dt.toISOString().slice(0, 10);
                  const yTasks = tasksMine.filter((t) => t.date === y);
                  for (const t of yTasks) {
                    const clone = {
                      name: t.name,
                      category: t.category,
                      plannedHours: t.plannedHours,
                      actualHours: 0,
                      status: "未着手" as Status,
                      date,
                      createdAt: Date.now(),
                      member: user.cloud.displayName,
                      ownerId: user.cloud.id,
                    };
                    await cloudInsertTask(clone as Omit<Task, "id">, user.cloud.id);
                  }
                  const mine = await cloudFetchMine(user.cloud.id);
                  const all = await cloudFetchAll();
                  setTasksMine(mine);
                  setTasksAll(all);
                })();
              }
            }}
            title="前日タスクを複製（実績はリセット）"
          >
            前日から複製
          </button>
        </div>

        {/* 追加フォーム */}
        <div className="bg-white rounded-2xl shadow p-4 md:p-5 mb-6">
          <h2 className="text-base font-semibold mb-4">
            タスクを追加（所有者: {user.mode === "local" ? user.local.username : user.cloud.displayName}）
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
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
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">工数（予定）</label>
              <NumberWheel value={newTask.plannedHours} onChange={(plannedHours) => setNewTask((v) => ({ ...v, plannedHours }))} />
            </div>
            <div className="flex items-end">
              <button className="w-full rounded-xl bg-black text-white py-2.5 font-medium hover:opacity-90" onClick={addTask}>
                追加
              </button>
            </div>
          </div>
        </div>

        {/* 一覧 */}
        <div className="bg-white rounded-2xl shadow overflow-hidden">
          <div className="px-4 py-3 border-b flex items-center justify-between">
            <h2 className="text-base font-semibold">タスク一覧（{date}）</h2>
            <div className="text-sm text-gray-600">合計: 予定 {totals.planned.toFixed(1)}h / 実績 {totals.actual.toFixed(1)}h</div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left border-b">
                  <th className="p-2 whitespace-nowrap">メンバー</th>
                  <th className="p-2">タスク名</th>
                  <th className="p-2">カテゴリ</th>
                  <th className="p-2 w-32">工数(予定)</th>
                  <th className="p-2 w-28">実績</th>
                  <th className="p-2 w-32">ステータス</th>
                  <th className="p-2 w-16 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {tasksForDay.length === 0 ? (
                  <tr>
                    <td className="p-4 text-gray-500" colSpan={7}>
                      該当タスクがありません。
                    </td>
                  </tr>
                ) : (
                  tasksForDay.map((row) => (
                    <TaskRow
                      key={row.id}
                      t={row}
                      canEdit={user.mode === "local" ? row.member === user.local.username : row.ownerId === user.cloud.id}
                      onUpdate={(patch) =>
                        updateTask(
                          row.id,
                          patch,
                          user.mode === "local" ? row.member === user.local.username : row.ownerId === user.cloud.id
                        )
                      }
                      onDelete={() =>
                        deleteTask(row.id, user.mode === "local" ? row.member === user.local.username : row.ownerId === user.cloud.id)
                      }
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* エクスポート/インポート（ローカルのみ） */}
        {user.mode === "local" && (
          <div className="mt-6 flex flex-col sm:flex-row gap-3">
            <button
              className="rounded-xl border px-3 py-2 hover:bg-white"
              onClick={() => {
                const blob = new Blob([JSON.stringify(tasksMine, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${user.local.username}_tasks.json`;
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              エクスポート(JSON)
            </button>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <span className="rounded-xl border px-3 py-2 hover:bg-white">インポート(JSON)</span>
              <input
                type="file"
                accept="application/json"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const text = await file.text();
                  try {
                    const parsed = JSON.parse(text) as Task[];
                    if (!Array.isArray(parsed)) throw new Error("invalid");
                    setTasksMine(parsed.map((t) => ({ ...t, member: user.local!.username })));
                  } catch {
                    alert("JSONが不正です");
                  }
                }}
              />
            </label>
          </div>
        )}

        <p className="text-xs text-gray-500 mt-6">
          v2.4 – Vercel環境向けに環境変数/型/UUID採番を修正。Supabase RLS は用途に合わせて設定してください。
        </p>
      </main>
    </div>
  );
}

// ====== Self test ======
(function selfTest() {
  try {
    console.assert(hoursOptions.length === 25, "hoursOptions length");
    console.assert(Math.abs(hoursOptions[1] - hoursOptions[0] - 0.5) < 1e-9, "hours step");
    console.assert(/\d{4}-\d{2}-\d{2}/.test(todayStr()), "todayStr format");
    const setU = new Set<string>();
    for (let i = 0; i < 50; i++) setU.add(uid());
    console.assert(setU.size === 50, "uid uniqueness small-sample");
  } catch (e) {
    console.warn("Self test failed:", e);
  }
})();
