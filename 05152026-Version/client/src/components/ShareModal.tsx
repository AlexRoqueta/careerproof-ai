import { useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Copy, Linkedin, Twitter, Mail } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Analysis } from "@shared/schema";
import { toTitleCase } from "@/lib/format";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  analysis: Analysis;
}

export function ShareModal({ open, onOpenChange, analysis }: Props) {
  const { toast } = useToast();
  const url = `${window.location.origin}${window.location.pathname}#/report/${analysis.id}`;
  const title = toTitleCase(analysis.job_title);
  const text = `My AI impact assessment — ${title}: ${analysis.automation_risk} risk (${analysis.risk_score}/100).`;
  const subject = `AI Impact Assessment — ${title}`;
  const body = `${text}\n\n${url}`;
  const mailtoHref = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  const emailFallbackAnchorRef = useRef<HTMLAnchorElement | null>(null);

  const copyToClipboard = async (value: string): Promise<boolean> => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {
      // fall through to legacy path
    }
    // Legacy fallback (iOS Safari without secure context, etc.)
    try {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "0";
      ta.style.left = "0";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, value.length);
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  };

  const copyLink = async () => {
    const ok = await copyToClipboard(url);
    if (ok) toast({ title: "Link copied" });
    else toast({ title: "Couldn't copy", variant: "destructive" });
  };

  const handleEmailShare = async () => {
    // Try Web Share API first on mobile when available — but only with a URL
    // so the mail app is one of the choices. Some Android browsers also
    // surface email; iOS shows the native share sheet.
    const canWebShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

    // Always set up the mailto URL on the hidden anchor so we have an
    // anchor-driven fallback (most reliable trigger in iOS Safari).
    if (emailFallbackAnchorRef.current) {
      emailFallbackAnchorRef.current.href = mailtoHref;
    }

    // Strategy: trigger mailto directly from this user-gesture handler.
    // 1. Try anchor click (most reliable on iOS Safari).
    // 2. Fall back to window.location.href.
    // 3. If neither appears to work, copy to clipboard and toast.
    let opened = false;
    try {
      if (emailFallbackAnchorRef.current) {
        emailFallbackAnchorRef.current.click();
        opened = true;
      } else {
        window.location.href = mailtoHref;
        opened = true;
      }
    } catch {
      opened = false;
    }

    if (!opened) {
      try {
        window.location.href = mailtoHref;
        opened = true;
      } catch {
        opened = false;
      }
    }

    // Detect "no handler" failure: on iOS, if no mail client is configured,
    // tapping the link silently does nothing. We can't reliably detect this
    // synchronously, but we can offer a Web Share fallback path and always
    // copy the body to the clipboard as a safety net + show a helpful toast
    // after a short delay if the page didn't blur (i.e. mail app didn't open).
    let didBlur = false;
    const onBlur = () => { didBlur = true; };
    window.addEventListener("blur", onBlur, { once: true });

    window.setTimeout(async () => {
      window.removeEventListener("blur", onBlur);
      if (didBlur) return; // mail client opened successfully
      // Try Web Share API as a secondary path (must still be considered a
      // user-gesture continuation; many browsers allow it within a few hundred ms).
      if (canWebShare) {
        try {
          await navigator.share({ title: subject, text, url });
          return;
        } catch {
          // user cancelled or share not allowed — continue to clipboard fallback
        }
      }
      const copied = await copyToClipboard(`${subject}\n\n${body}`);
      if (copied) {
        toast({
          title: "No email app detected",
          description: "We copied the message to your clipboard. Paste it into your email app.",
        });
      } else {
        toast({
          title: "Couldn't open your email app",
          description: "Copy the link manually and paste it into an email.",
          variant: "destructive",
        });
      }
    }, 700);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="dialog-share"
        className="bg-background text-foreground border-border"
      >
        <DialogHeader>
          <DialogTitle className="text-foreground">Share this assessment</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Copy the link or share it directly.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            value={url}
            readOnly
            data-testid="input-share-url"
            className="bg-background text-foreground border-border"
          />
          <Button onClick={copyLink} variant="outline" data-testid="button-copy-link">
            <Copy className="w-4 h-4 mr-2" />
            Copy
          </Button>
        </div>
        <div className="flex gap-2 pt-2">
          <a
            href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1"
          >
            <Button variant="outline" className="w-full" data-testid="button-share-linkedin">
              <Linkedin className="w-4 h-4 mr-2" />
              LinkedIn
            </Button>
          </a>
          <a
            href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1"
          >
            <Button variant="outline" className="w-full" data-testid="button-share-twitter">
              <Twitter className="w-4 h-4 mr-2" />
              Twitter
            </Button>
          </a>
          {/* Email share must be a real button so the user gesture fires the
              mailto handler synchronously. The hidden anchor below is the
              actual click target used inside handleEmailShare. */}
          <Button
            type="button"
            onClick={handleEmailShare}
            variant="outline"
            className="flex-1"
            data-testid="button-share-email"
          >
            <Mail className="w-4 h-4 mr-2" />
            Email
          </Button>
          <a
            ref={emailFallbackAnchorRef}
            href={mailtoHref}
            aria-hidden="true"
            tabIndex={-1}
            data-testid="link-share-email-fallback"
            style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
          >
            email fallback
          </a>
        </div>
        <p
          className="text-xs text-muted-foreground pt-1"
          data-testid="text-share-email-hint"
        >
          On mobile, tapping Email opens your mail app. If nothing happens, we copy the message to your clipboard.
        </p>
      </DialogContent>
    </Dialog>
  );
}
