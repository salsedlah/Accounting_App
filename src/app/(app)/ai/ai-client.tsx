"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageCircle, Sparkles } from "lucide-react";
import { errorMessage, postJson } from "@/lib/client/api";
import { Alert } from "@/components/ui";

type AiAnswer = {
  answer: string;
  intent: string;
  grounded: true;
  period: { from: string; to: string; label: string } | null;
  data: unknown;
  suggestions: string[];
};

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  period?: string | null;
};

const STARTERS = [
  "كم مبيعات اليوم؟",
  "ما صافي ربح هذا الشهر؟",
  "ما هي المنتجات الناقصة؟",
  "من أكثر عميل مديونية؟",
  "كم قيمة المخزون الحالي؟",
  "كم النقد في الصندوق؟",
];

export function AiClient() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      text: "مرحباً، أنا مساعدك المحاسبي. أسألني عن المبيعات أو الأرباح أو المخزون أو الديون أو الصندوق — وسأجيب حصراً من بيانات مؤسستك.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>(STARTERS);

  const ask = useCallback(
    async (question: string) => {
      const text = question.trim();
      if (!text || loading) return;
      setInput("");
      setError(null);
      setMessages((prev) => [...prev, { role: "user", text }]);
      setLoading(true);
      try {
        const result = await postJson<AiAnswer>("/api/ai/ask", { question: text });
        setMessages((prev) => [
          ...prev,
          { role: "assistant", text: result.answer, period: result.period?.label ?? null },
        ]);
        if (result.suggestions.length) setSuggestions(result.suggestions);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [loading],
  );

  useEffect(() => {
    const el = document.getElementById("ai-scroll");
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  return (
    <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-3xl flex-col">
      <div className="flex items-center gap-2 pb-3">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-600 text-white">
          <Sparkles className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-lg font-bold">المساعد الذكي</h1>
          <p className="text-[11px] text-ink-500">إجابات موثقة من بياناتك — بدون تخمين</p>
        </div>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div
        id="ai-scroll"
        className="flex-1 space-y-3 overflow-y-auto rounded-2xl border border-ink-200 bg-white p-4 shadow-card"
      >
        {messages.map((message, index) => (
          <div
            key={index}
            className={`flex gap-2 ${message.role === "user" ? "justify-start" : "justify-end"}`}
          >
            {message.role === "assistant" ? (
              <span className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-700">
                <Sparkles className="h-3.5 w-3.5" />
              </span>
            ) : null}
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-6 ${
                message.role === "user"
                  ? "bg-brand-600 text-white"
                  : "bg-ink-50 text-ink-800"
              }`}
            >
              {message.text}
              {message.period ? (
                <p className="mt-1 text-[10px] opacity-70">الفترة: {message.period}</p>
              ) : null}
            </div>
            {message.role === "user" ? (
              <span className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-ink-800 text-[10px] text-white">
                أنت
              </span>
            ) : null}
          </div>
        ))}
        {loading ? (
          <div className="flex justify-end gap-1 px-2">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-2 w-2 animate-bounce rounded-full bg-brand-400"
                style={{ animationDelay: `${i * 120}ms` }}
              />
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-1">
        {suggestions.slice(0, 6).map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => ask(suggestion)}
            className="rounded-full border border-ink-200 bg-white px-3 py-1 text-[11px] text-ink-600 hover:border-brand-300 hover:text-brand-700"
          >
            {suggestion}
          </button>
        ))}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void ask(input);
        }}
        className="mt-2 flex items-center gap-2"
      >
        <input
          className="input flex-1"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="اكتب سؤالك المحاسبي…"
          maxLength={500}
        />
        <button
          type="submit"
          disabled={loading || input.trim().length < 2}
          className="grid h-10 w-10 place-items-center rounded-xl bg-brand-600 text-white disabled:opacity-40"
          aria-label="إرسال"
        >
          <MessageCircle className="h-4 w-4" />
        </button>
      </form>
      <p className="mt-1 text-center text-[10px] text-ink-400">
        لا يقدم المساعد بيانات خارج نطاق مؤسستك ولا يقوم بأي تعديلات
      </p>
    </div>
  );
}
