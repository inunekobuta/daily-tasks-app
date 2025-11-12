import { useCallback, useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

type PerformanceKind = "revenue" | "cost";

type PerformanceEntryForm = {
  subject: string;
  amount: string;
  occurredOn: string;
};

type PerformanceRecord = {
  id: string;
  ownerId: string;
  kind: PerformanceKind;
  subject: string;
  amount: number;
  occurredOn: string;
  createdAt: string;
};

type Props = {
  supabase: SupabaseClient | null;
  userId: string | null;
};

const emptyForm = (): PerformanceEntryForm => ({ subject: "", amount: "", occurredOn: todayStr() });

const yenFormatter = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" });

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function toRecord(row: any): PerformanceRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    kind: row.kind as PerformanceKind,
    subject: row.subject ?? "",
    amount: Number(row.amount ?? 0),
    occurredOn: row.occurred_on ?? "",
    createdAt: row.created_at ?? "",
  };
}

function PerformanceEntryCard({
  title,
  description,
  placeholder,
  form,
  onChange,
  onSubmit,
  submitting,
}: {
  title: string;
  description: string;
  placeholder: string;
  form: PerformanceEntryForm;
  onChange: (next: PerformanceEntryForm) => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  return (
    <div className="rounded-3xl border border-slate-200/70 bg-white/80 backdrop-blur-xl shadow-xl p-6">
      <div className="mb-6">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-slate-500">{description}</p>
      </div>
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 md:col-span-6 lg:col-span-4">
          <label className="block text-xs font-semibold text-slate-600 mb-1.5">科目</label>
          <input
            className="w-full rounded-xl border border-slate-200 bg-white/80 px-3.5 py-2 text-sm outline-none ring-0 focus:border-slate-300 focus:ring-4 focus:ring-slate-100 transition"
            placeholder={placeholder}
            value={form.subject}
            onChange={(e) => onChange({ ...form, subject: e.target.value })}
          />
        </div>
        <div className="col-span-12 md:col-span-6 lg:col-span-4">
          <label className="block text-xs font-semibold text-slate-600 mb-1.5">金額 (税込)</label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">¥</span>
            <input
              type="number"
              min={0}
              step={1}
              className="w-full rounded-xl border border-slate-200 bg-white/80 px-3.5 py-2 text-sm outline-none ring-0 focus:border-slate-300 focus:ring-4 focus:ring-slate-100 transition pl-8"
              placeholder="金額を入力"
              value={form.amount}
              onChange={(e) => onChange({ ...form, amount: e.target.value })}
            />
          </div>
        </div>
        <div className="col-span-12 md:col-span-6 lg:col-span-4">
          <label className="block text-xs font-semibold text-slate-600 mb-1.5">発生日</label>
          <input
            type="date"
            className="w-full rounded-xl border border-slate-200 bg-white/80 px-3.5 py-2 text-sm outline-none ring-0 focus:border-slate-300 focus:ring-4 focus:ring-slate-100 transition"
            value={form.occurredOn}
            onChange={(e) => onChange({ ...form, occurredOn: e.target.value })}
          />
        </div>
      </div>
      <div className="mt-6 flex justify-end">
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting}
          className={`inline-flex items-center justify-center rounded-xl bg-indigo-600 text-white px-4 py-2.5 text-sm font-semibold shadow-sm focus:outline-none focus:ring-4 focus:ring-indigo-200 transition ${
            submitting ? "opacity-60 cursor-not-allowed" : "hover:opacity-95 active:opacity-90"
          }`}
        >
          {submitting ? "保存中..." : "追加"}
        </button>
      </div>
    </div>
  );
}

export default function PerformanceManagement({ supabase, userId }: Props) {
  const [forms, setForms] = useState<{ revenue: PerformanceEntryForm; cost: PerformanceEntryForm }>(() => ({
    revenue: emptyForm(),
    cost: emptyForm(),
  }));
  const [loading, setLoading] = useState(false);
  const [savingKind, setSavingKind] = useState<PerformanceKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [records, setRecords] = useState<PerformanceRecord[]>([]);
  const [refreshIndex, setRefreshIndex] = useState(0);

  const resetForm = useCallback((kind: PerformanceKind) => {
    setForms((prev) => ({ ...prev, [kind]: emptyForm() }));
  }, []);

  useEffect(() => {
    if (!supabase || !userId) {
      setRecords([]);
      return;
    }
    let mounted = true;
    setLoading(true);
    setError(null);
    supabase
      .from("performance_entries")
      .select("*")
      .eq("owner_id", userId)
      .order("occurred_on", { ascending: false })
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (!mounted) return;
        if (error) {
          console.error("[performance_entries] fetch", error);
          setError("業績データの取得に失敗しました。");
          setRecords([]);
        } else {
          setRecords((data || []).map(toRecord));
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [supabase, userId, refreshIndex]);

  const totals = useMemo(() => {
    return records.reduce(
      (acc, cur) => {
        if (cur.kind === "revenue") acc.revenue += cur.amount;
        if (cur.kind === "cost") acc.cost += cur.amount;
        return acc;
      },
      { revenue: 0, cost: 0 }
    );
  }, [records]);

  const handleSubmit = async (kind: PerformanceKind) => {
    const form = forms[kind];
    const subject = form.subject.trim();
    const occurredOn = form.occurredOn || todayStr();
    const amountNumber = Number(form.amount);

    if (!supabase) {
      setError("Supabaseの設定が完了していません。");
      return;
    }
    if (!userId) {
      setError("ユーザー情報が見つかりません。再ログインしてください。");
      return;
    }
    if (!subject) {
      setError("科目を入力してください。");
      return;
    }
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      setError("1以上の金額を入力してください。");
      return;
    }
    if (!occurredOn) {
      setError("発生日を選択してください。");
      return;
    }

    try {
      setSavingKind(kind);
      setError(null);
      const { error } = await supabase.from("performance_entries").insert({
        owner_id: userId,
        kind,
        subject,
        amount: amountNumber,
        occurred_on: occurredOn,
      });
      if (error) throw error;
      resetForm(kind);
      setRefreshIndex((v) => v + 1);
    } catch (e) {
      console.error("[performance_entries] insert", e);
      setError("データの保存に失敗しました。");
    } finally {
      setSavingKind(null);
    }
  };

  if (!supabase) {
    return (
      <div className="rounded-3xl border border-slate-200/70 bg-white/80 backdrop-blur-xl shadow-xl p-8 text-center text-slate-600">
        Supabaseの接続情報が設定されていません。環境変数 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY を確認してください。
      </div>
    );
  }

  if (!userId) {
    return (
      <div className="rounded-3xl border border-slate-200/70 bg-white/80 backdrop-blur-xl shadow-xl p-8 text-center text-slate-600">
        ログイン情報が見つかりません。もう一度ログインしてください。
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {error && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
      )}

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <PerformanceEntryCard
          title="売上を追加"
          description="売上の科目・金額・発生日を記録します"
          placeholder="例: 広告運用フィー"
          form={forms.revenue}
          onChange={(next) => setForms((prev) => ({ ...prev, revenue: next }))}
          onSubmit={() => handleSubmit("revenue")}
          submitting={savingKind === "revenue"}
        />
        <PerformanceEntryCard
          title="コストを追加"
          description="コストの科目・金額・発生日を記録します"
          placeholder="例: 外注費"
          form={forms.cost}
          onChange={(next) => setForms((prev) => ({ ...prev, cost: next }))}
          onSubmit={() => handleSubmit("cost")}
          submitting={savingKind === "cost"}
        />
      </section>

      <section className="rounded-3xl border border-slate-200/70 bg-white/80 backdrop-blur-xl shadow-xl">
        <div className="border-b border-slate-200/70 px-6 py-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">登録済み一覧</h2>
            <p className="text-xs text-slate-500">登録日時の新しい順に表示しています</p>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-emerald-700">
              売上 {yenFormatter.format(totals.revenue)}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-rose-700">
              コスト {yenFormatter.format(totals.cost)}
            </span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50/70 text-slate-500">
              <tr>
                <th className="px-4 py-3 text-left font-semibold">種別</th>
                <th className="px-4 py-3 text-left font-semibold">科目</th>
                <th className="px-4 py-3 text-left font-semibold">金額</th>
                <th className="px-4 py-3 text-left font-semibold">発生日</th>
                <th className="px-4 py-3 text-left font-semibold">登録日時</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white/80">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                    読み込み中...
                  </td>
                </tr>
              ) : records.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                    まだ登録がありません。
                  </td>
                </tr>
              ) : (
                records.map((record) => (
                  <tr key={record.id} className="text-slate-700">
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${
                          record.kind === "revenue"
                            ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                            : "bg-rose-50 text-rose-700 border border-rose-200"
                        }`}
                      >
                        {record.kind === "revenue" ? "売上" : "コスト"}
                      </span>
                    </td>
                    <td className="px-4 py-3">{record.subject}</td>
                    <td className="px-4 py-3 font-semibold">{yenFormatter.format(record.amount)}</td>
                    <td className="px-4 py-3">{record.occurredOn || "—"}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {record.createdAt ? new Date(record.createdAt).toLocaleString("ja-JP") : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
