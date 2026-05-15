import { Mic, MicOff } from "lucide-react";
import { useSpeech } from "@/hooks/useSpeech";
import { Button } from "@/components/ui/button";

interface Props {
  onTranscript: (t: string) => void;
  testId?: string;
}

export function MicButton({ onTranscript, testId }: Props) {
  const { listening, supported, toggle } = useSpeech(onTranscript);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={toggle}
      className={`h-8 w-8 ${listening ? "text-primary" : "text-muted-foreground"} ${
        !supported ? "opacity-60" : ""
      }`}
      title={supported ? (listening ? "Stop dictation" : "Dictate") : "Dictation not supported"}
      data-testid={testId}
      aria-pressed={listening}
    >
      {listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
    </Button>
  );
}
