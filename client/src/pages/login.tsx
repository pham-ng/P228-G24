import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Loader2 } from "lucide-react";
import { AureaLogo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/queryClient";
import { useSession } from "@/lib/session";
import { DEPT_LABELS, type Staff } from "@/lib/types";

export default function LoginPage() {
  const { signIn } = useSession();
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const { data: team } = useQuery<Staff[]>({ queryKey: ["/api/staff"] });

  const login = useMutation({
    mutationFn: async (creds: { name: string; pin: string }) => {
      const res = await apiRequest("POST", "/api/staff/login", creds);
      return res.json() as Promise<Staff>;
    },
    onSuccess: signIn,
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-5 py-12">
      <div className="w-full max-w-sm">
        <AureaLogo subtitle="Operations" />
        <h1 className="mt-6 text-lg font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Use your name and the 4-digit team PIN.
        </p>

        <form
          className="mt-6 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            login.mutate({ name: name.trim(), pin: pin.trim() });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Linh Tran"
              data-testid="input-name"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pin">PIN</Label>
            <Input
              id="pin"
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="••••"
              className="font-mono"
              data-testid="input-pin"
            />
          </div>
          {login.isError && (
            <p className="text-xs text-destructive" data-testid="text-login-error">
              Wrong name or PIN.
            </p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={login.isPending || !name || !pin}
            data-testid="button-login"
          >
            {login.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Sign in
          </Button>
        </form>

        <div className="mt-8">
          <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Team on duty — tap to fill
          </div>
          <div className="mt-2 grid gap-1.5">
            {(team ?? []).map((s) => (
              <button
                key={s.id}
                onClick={() => {
                  setName(s.name);
                  setPin("1234");
                }}
                data-testid={`staff-${s.id}`}
                className="hover-elevate flex items-center gap-2.5 rounded-md border border-card-border bg-card px-3 py-2 text-left"
              >
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 font-mono text-[10px] font-semibold text-primary">
                  {s.avatarInitials}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{s.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {s.role} · {DEPT_LABELS[s.dept] ?? s.dept}
                  </div>
                </div>
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">Demo PIN for every account: 1234</p>
        </div>

        <Link
          href="/"
          className="mt-8 inline-block text-xs text-muted-foreground hover:text-foreground"
          data-testid="link-guest"
        >
          ← Guest concierge
        </Link>
      </div>
    </div>
  );
}
