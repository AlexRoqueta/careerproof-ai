import { useQuery } from "@tanstack/react-query";
import { getQueryFn } from "@/lib/queryClient";
import type { User } from "@shared/schema";

/**
 * Returns the currently signed-in user, or `null` when no session.
 *
 * Uses the 401-aware queryFn so that signing out (server clears the
 * session, returns 401 from /api/me) cleanly resolves to `null` rather
 * than leaving the previous user cached. The shell uses this to gate
 * protected routes behind the sign-in screen.
 */
export function useMe() {
  return useQuery<User | null>({
    queryKey: ["/api/me"],
    queryFn: getQueryFn<User | null>({ on401: "returnNull" }),
  });
}
