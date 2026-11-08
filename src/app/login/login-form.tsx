"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LockKeyhole, Mail, ShieldCheck, WifiOff } from "lucide-react";
import { postJson, errorMessage } from "@/lib/client/api";
import { Button, Field } from "@/components/ui";

const DEMO = [
  { label: "المالك", email: "owner@demo.local", password: "Admin123!" },
  { label: "محاسب", email: "accountant@demo.local", password: "Accountant123!" },
  { label: "كاشير", email: "cashier@demo.local", password: "Cashier123!" },
];

export function LoginForm({ next }: { next?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("owner@demo.local");
  const [password, setPassword] = useState("Admin123!");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await postJson<{ session: unknown }>("/api/auth/login", { email, password });
      router.replace(next && next.startsWith("/") ? next : "/");
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="البريد الإلكتروني">
        <div className="relative">
          <Mail className="pointer-events-none absolute right-3 top-2.5 h-4 w-4 text-ink-400" />
          <input
            className="input pr-9 text-left"
            dir="ltr"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            autoComplete="username"
            required
          />
        </div>
      </Field>
      <Field label="كلمة المرور">
        <div className="relative">
          <LockKeyhole className="pointer-events-none absolute right-3 top-2.5 h-4 w-4 text-ink-400" />
          <input
            className="input pr-9 text-left"
            dir="ltr"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
            required
          />
        </div>
      </Field>

      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <Button type="submit" className="w-full" size="lg" loading={loading}>
        تسجيل الدخول
      </Button>

      <div className="rounded-xl border border-ink-200 bg-ink-50 p-3">
        <p className="mb-2 text-xs font-medium text-ink-600">دخول سريع للتجربة</p>
        <div className="flex flex-wrap gap-2">
          {DEMO.map((item) => (
            <button
              key={item.email}
              type="button"
              onClick={() => {
                setEmail(item.email);
                setPassword(item.password);
                setError(null);
              }}
              className="rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-xs text-ink-700 transition hover:border-brand-300 hover:text-brand-700"
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </form>
  );
}

export function LoginBadges() {
  return (
    <div className="mt-4 flex flex-wrap justify-center gap-2 text-[11px] text-ink-500">
      <span className="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 shadow-card">
        <ShieldCheck className="h-3.5 w-3.5 text-brand-600" /> صلاحيات حسب الدور
      </span>
      <span className="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 shadow-card">
        <WifiOff className="h-3.5 w-3.5 text-brand-600" /> يعمل دون اتصال
      </span>
    </div>
  );
}
