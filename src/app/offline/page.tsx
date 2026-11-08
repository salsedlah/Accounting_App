export const metadata = { title: "غير متصل" };

export default function OfflinePage() {
  return (
    <main className="grid min-h-screen place-items-center bg-ink-50 p-6">
      <div className="max-w-sm rounded-2xl border border-ink-200 bg-white p-6 text-center shadow-card">
        <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-amber-50 text-2xl">
          📴
        </div>
        <h1 className="text-lg font-bold">أنت غير متصل</h1>
        <p className="mt-2 text-sm text-ink-500">
          الصفحة المطلوبة غير متاحة دون اتصال. يمكنك فتح نقطة البيع إذا كانت البيانات
          مخزّنة مسبقاً، وستُزامن الفواتير تلقائياً عند عودة الاتصال.
        </p>
        <a
          href="/pos"
          className="mt-4 inline-block rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white"
        >
          فتح نقطة البيع
        </a>
      </div>
    </main>
  );
}
