import { useEffect, useRef, useState } from "react";

/* Web Speech API wrapper. Returns `supported` so the UI can gracefully
 * fall back when the browser doesn't expose webkitSpeechRecognition. */
export function useSpeech(onResult: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  const recRef = useRef<any>(null);

  useEffect(() => {
    const w = window as any;
    const Rec = w.SpeechRecognition || w.webkitSpeechRecognition;
    setSupported(!!Rec);
  }, []);

  const start = () => {
    const w = window as any;
    const Rec = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Rec) {
      alert("Speech recognition isn't supported in this browser. Try Chrome or Edge.");
      return;
    }
    if (listening) return;
    const r = new Rec();
    r.lang = "en-US";
    r.interimResults = false;
    r.continuous = false;
    r.onresult = (e: any) => {
      const text = Array.from(e.results)
        .map((res: any) => res[0]?.transcript ?? "")
        .join(" ")
        .trim();
      if (text) onResult(text);
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    recRef.current = r;
    r.start();
    setListening(true);
  };

  const stop = () => {
    try {
      recRef.current?.stop();
    } catch {}
    setListening(false);
  };

  const toggle = () => (listening ? stop() : start());

  return { listening, supported, start, stop, toggle };
}
