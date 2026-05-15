import { useState, useEffect } from "react";
import { Sidebar } from "./Sidebar";
import { Logo } from "./Logo";
import { Menu } from "lucide-react";
import { useLocation } from "wouter";

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [location] = useLocation();

  // Close mobile sidebar on route change
  useEffect(() => {
    setOpen(false);
  }, [location]);

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <Sidebar open={open} onClose={() => setOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile header */}
        <header className="md:hidden sticky top-0 z-20 flex items-center justify-between px-4 h-14 border-b border-border bg-background/80 backdrop-blur">
          <button
            className="p-2 rounded-md hover-elevate -ml-2"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            data-testid="button-open-sidebar"
          >
            <Menu className="w-5 h-5" />
          </button>
          <Logo size={22} />
          <div className="w-9" />
        </header>
        <main className="flex-1 min-w-0">{children}</main>
      </div>
    </div>
  );
}
