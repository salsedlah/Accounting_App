"use client";

import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { Camera, X } from "lucide-react";
import { Button } from "@/components/ui";

type NativeBarcodeDetector = {
  detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>>;
};
type NativeBarcodeWindow = Window & {
  BarcodeDetector?: new (options: { formats: string[] }) => NativeBarcodeDetector;
};

export function BarcodeScanner({
  onDetected,
  onClose,
}: {
  onDetected: (value: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let detected = false;
    let frame = 0;
    let stream: MediaStream | null = null;
    const reader = new BrowserMultiFormatReader();
    const video = videoRef.current;
    if (!video) return;

    const start = async () => {
      const NativeDetector = (window as NativeBarcodeWindow).BarcodeDetector;
      if (NativeDetector && navigator.mediaDevices?.getUserMedia) {
        try {
          const detector = new NativeDetector({
            formats: ["qr_code", "ean_13", "ean_8", "upc_a", "upc_e", "code_128"],
          });
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: { ideal: "environment" } },
          });
          if (cancelled) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          video.srcObject = stream;
          await video.play();
          const scanFrame = async () => {
            if (cancelled || detected) return;
            try {
              const results = await detector.detect(video);
              const value = results[0]?.rawValue;
              if (value) {
                detected = true;
                onDetected(value);
                return;
              }
            } catch {
              // Some browsers expose BarcodeDetector but cannot decode a given frame.
            }
            frame = window.requestAnimationFrame(() => void scanFrame());
          };
          frame = window.requestAnimationFrame(() => void scanFrame());
          return;
        } catch {
          stream?.getTracks().forEach((track) => track.stop());
          stream = null;
          if (cancelled) return;
        }
      }

      reader
        .decodeFromConstraints(
          { audio: false, video: { facingMode: { ideal: "environment" } } },
          video,
          (result) => {
            if (cancelled || detected || !result) return;
            const value = result.getText();
            if (value) {
              detected = true;
              controlsRef.current?.stop();
              onDetected(value);
            }
          },
        )
        .then((controls) => {
          if (cancelled) controls.stop();
          else controlsRef.current = controls;
        })
        .catch(() => {
          if (!cancelled) {
            setError("تعذر فتح الكاميرا. تحقق من إذن الكاميرا واتصال آمن HTTPS، أو استخدم قارئ الباركود.");
          }
        });
    };

    void start();
    return () => {
      cancelled = true;
      detected = true;
      window.cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      controlsRef.current?.stop();
      controlsRef.current = null;
      video.srcObject = null;
    };
    // onDetected changes with POS state; scanner lifecycle should start once per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-xl bg-ink-900">
        <video ref={videoRef} className="h-56 w-full object-cover" muted playsInline />
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="h-24 w-56 rounded-lg border-2 border-white/70" />
        </div>
      </div>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      <p className="flex items-center gap-1 text-xs text-ink-500">
        <Camera className="h-3.5 w-3.5" /> وجّه الكاميرا الخلفية نحو باركود المنتج
      </p>
      <Button variant="secondary" className="w-full" onClick={onClose}>
        <X className="h-4 w-4" /> إغلاق الماسح
      </Button>
    </div>
  );
}
