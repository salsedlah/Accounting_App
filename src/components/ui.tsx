"use client";

import { clsx } from "clsx";
import { X } from "lucide-react";
import { formatMoney } from "@/lib/money";
import { formatQty } from "@/lib/quantity";
import type { ReactNode } from "react";

export function Card({
  children,
  className,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article";
}) {
  return (
    <Tag className={clsx("rounded-2xl border border-ink-200 bg-white shadow-card", className)}>
      {children}
    </Tag>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-100 px-4 py-3">
      <div>
        <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-xs text-ink-500">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold text-ink-900 sm:text-2xl">{title}</h1>
        {description ? <p className="mt-1 text-sm text-ink-500">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success";

const buttonStyles: Record<ButtonVariant, string> = {
  primary:
    "bg-brand-600 text-white hover:bg-brand-700 focus-visible:ring-brand-200 disabled:bg-brand-300",
  secondary:
    "border border-ink-200 bg-white text-ink-800 hover:bg-ink-50 focus-visible:ring-ink-200",
  ghost: "text-ink-600 hover:bg-ink-100 focus-visible:ring-ink-200",
  danger: "bg-danger text-white hover:opacity-90 focus-visible:ring-red-200",
  success: "bg-ok text-white hover:opacity-90 focus-visible:ring-green-200",
};

export function Button({
  children,
  variant = "primary",
  size = "md",
  className,
  type = "button",
  loading,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}) {
  const sizes = {
    sm: "px-2.5 py-1.5 text-xs",
    md: "px-3.5 py-2 text-sm",
    lg: "px-5 py-2.5 text-base",
  };
  return (
    <button
      type={type}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition focus:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-70",
        sizes[size],
        buttonStyles[variant],
        className,
      )}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading ? <Spinner className="h-4 w-4" /> : null}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={clsx(
        "inline-block animate-spin rounded-full border-2 border-current border-t-transparent",
        className ?? "h-4 w-4",
      )}
      aria-hidden
    />
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={clsx("block", className)}>
      <span className="label">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-danger">{error}</span> : null}
      {!error && hint ? <span className="mt-1 block text-xs text-ink-400">{hint}</span> : null}
    </label>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "info" | "brand";
}) {
  const tones = {
    neutral: "bg-ink-100 text-ink-700",
    success: "bg-green-50 text-ok",
    warning: "bg-amber-50 text-warn",
    danger: "bg-red-50 text-danger",
    info: "bg-blue-50 text-blue-700",
    brand: "bg-brand-50 text-brand-700",
  };
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Money({
  value,
  className,
  currency,
}: {
  value: string | bigint;
  className?: string;
  currency?: boolean;
}) {
  const minor = typeof value === "bigint" ? value : BigInt(value || 0);
  return (
    <span className={clsx("tabular-nums", className)} dir="ltr">
      {formatMoney(minor, 2)}
      {currency ? <span className="mr-1 text-xs text-ink-500">ر.ي</span> : null}
    </span>
  );
}

export function Qty({
  value,
  className,
  unit,
}: {
  value: string | bigint;
  className?: string;
  unit?: string;
}) {
  const milli = typeof value === "bigint" ? value : BigInt(value || 0);
  return (
    <span className={clsx("tabular-nums", className)} dir="ltr">
      {formatQty(milli)}
      {unit ? <span className="mr-1 text-xs text-ink-500">{unit}</span> : null}
    </span>
  );
}

export function Alert({
  children,
  tone = "info",
  className,
}: {
  children: ReactNode;
  tone?: "info" | "success" | "warning" | "danger";
  className?: string;
}) {
  const tones = {
    info: "border-blue-200 bg-blue-50 text-blue-800",
    success: "border-green-200 bg-green-50 text-ok",
    warning: "border-amber-200 bg-amber-50 text-warn",
    danger: "border-red-200 bg-red-50 text-danger",
  };
  return (
    <div className={clsx("rounded-lg border px-3 py-2 text-sm", tones[tone], className)}>
      {children}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
      <p className="text-sm font-medium text-ink-700">{title}</p>
      {description ? <p className="max-w-md text-xs text-ink-500">{description}</p> : null}
      {action}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-900/40 p-0 sm:items-center sm:p-4">
      <div
        className={clsx(
          "max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white shadow-xl sm:rounded-2xl",
          wide ? "sm:max-w-3xl" : "sm:max-w-lg",
        )}
        role="dialog"
        aria-modal
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-ink-100 bg-white px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-ink-500 hover:bg-ink-100"
            aria-label="إغلاق"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4">{children}</div>
        {footer ? (
          <div className="sticky bottom-0 flex justify-end gap-2 border-t border-ink-100 bg-white px-4 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "brand",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "brand" | "success" | "warning" | "danger" | "neutral";
}) {
  const tones = {
    brand: "bg-brand-50 text-brand-700",
    success: "bg-green-50 text-ok",
    warning: "bg-amber-50 text-warn",
    danger: "bg-red-50 text-danger",
    neutral: "bg-ink-100 text-ink-700",
  };
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-ink-500">{label}</span>
        <span className={clsx("h-2 w-2 rounded-full", tones[tone])} />
      </div>
      <div className="mt-2 text-xl font-bold tabular-nums">{value}</div>
      {hint ? <div className="mt-1 text-xs text-ink-500">{hint}</div> : null}
    </Card>
  );
}
