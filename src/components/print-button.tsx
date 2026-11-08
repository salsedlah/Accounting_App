"use client";

import { Printer } from "lucide-react";

export function PrintButton({ label = "طباعة" }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-white px-3 py-2 text-xs text-ink-700 hover:bg-ink-50 print:hidden"
    >
      <Printer className="h-3.5 w-3.5" /> {label}
    </button>
  );
}
