import { Link, useLocation } from "wouter";
import { Logo } from "./Logo";
import {
  Brain,
  History,
  FileText,
  CreditCard,
  User as UserIcon,
  ShieldCheck,
  LogOut,
  X,
} from "lucide-react";
import { useMe } from "@/hooks/useMe";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { hasUnlimitedCredits } from "@shared/entitlements";

const navItems = [
  { href: "/", label: "Analyze", icon: Brain, testId: "nav-analyze" },
  { href: "/history", label: "History", icon: History, testId: "nav-history" },
  { href: "/resumes", label: "Resumes", icon: FileText, testId: "nav-resumes" },
  { href: "/credits", label: "Credits", icon: CreditCard, testId: "nav-credits" },
  { href: "/profile", label: "Profile", icon: UserIcon, testId: "nav-profile" },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

export function Sidebar({ open, onClose }: Props) {
  const [location] = useLocation();
  const { data: me } = useMe();
  const { toast } = useToast();
  const unlimitedCredits = hasUnlimitedCredits(me?.email, me?.role);

  const isActive = (href: string) => {
    if (href === "/") return location === "/" || location === "";
    return location.startsWith(href);
  };

  const handleLogout = async () => {
    // Close the mobile drawer immediately so the click doesn't visually
    // linger while the request is in flight.
    onClose();
    try {
      await apiRequest("POST", "/api/me/logout");
    } catch {
      // Swallow — we still want to fully reset client state on logout
      // even if the network call failed.
    }
    // Cancel any in-flight queries first so they don't race the reset.
    await queryClient.cancelQueries();
    // Reset every cached query to its initial state. This wipes
    // analyses, resumes, credits, user lists, etc. so no signed-in
    // data lingers behind the sign-in screen.
    queryClient.resetQueries();
    // Synchronously prime the /api/me cache to `null` so the shell
    // re-renders with the sign-in screen on the next tick instead of
    // briefly showing the previous user while the refetch resolves.
    queryClient.setQueryData(["/api/me"], null);
    // Make sure the URL reflects the unauthenticated state.
    if (typeof window !== "undefined") {
      window.location.hash = "/";
    }
    toast({ title: "Signed out", description: "You’ve been signed out." });
  };

  return (
    <>
      {/* Mobile backdrop */}
      <div
        className={`fixed inset-0 z-30 bg-black/40 md:hidden transition-opacity ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={onClose}
        aria-hidden
      />
      <aside
        className={`fixed md:sticky top-0 left-0 z-40 h-screen w-64 shrink-0 bg-sidebar text-sidebar-foreground border-r border-sidebar-border flex flex-col transition-transform md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        data-testid="sidebar"
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <Link
            href="/"
            onClick={onClose}
            className="flex items-center gap-2 text-sidebar-foreground"
            data-testid="link-logo-home"
          >
            <Logo size={26} />
          </Link>
          <button
            className="md:hidden p-1.5 rounded-md hover-elevate"
            onClick={onClose}
            aria-label="Close menu"
            data-testid="button-close-sidebar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                data-testid={item.testId}
                className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors hover-elevate ${
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-sidebar-foreground/80"
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{item.label}</span>
              </Link>
            );
          })}
          {me?.role === "admin" && (
            <Link
              href="/admin"
              onClick={onClose}
              data-testid="nav-admin"
              className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors hover-elevate ${
                isActive("/admin")
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                  : "text-sidebar-foreground/80"
              }`}
            >
              <ShieldCheck className="w-4 h-4" />
              <span>Admin</span>
            </Link>
          )}
        </nav>

        <div className="px-4 py-4 border-t border-sidebar-border space-y-3">
          {me && (
            <div className="rounded-md bg-sidebar-accent/60 border border-sidebar-border px-3 py-2.5">
              <div className="text-[11px] uppercase tracking-wider text-sidebar-foreground/60">Credits</div>
              <div className="flex items-baseline justify-between mt-0.5">
                <span className="text-lg font-semibold tabular-nums" data-testid="text-credits">
                  {unlimitedCredits ? "∞" : me.credits}
                </span>
                <span className="text-[11px] text-sidebar-foreground/60">
                  {unlimitedCredits ? "unlimited" : me.role}
                </span>
              </div>
            </div>
          )}
          <div className="text-xs text-sidebar-foreground/70 truncate" data-testid="text-user-name">
            {me?.full_name ?? "—"}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-sidebar-foreground/80 hover:text-sidebar-foreground"
            onClick={handleLogout}
            data-testid="button-logout"
          >
            <LogOut className="w-4 h-4 mr-2" />
            Sign out
          </Button>
        </div>
      </aside>
    </>
  );
}
