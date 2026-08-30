import { Link } from "wouter";
import { VinAureaLogo } from "@/components/logo";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-sm space-y-4 text-center">
        <div className="flex justify-center">
          <VinAureaLogo />
        </div>
        <div>
          <h1 className="text-xl font-semibold">This page doesn't exist</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The link may be out of date. Head back to the concierge, or sign in as a team member.
          </p>
        </div>
        <div className="flex justify-center gap-2">
          <Button asChild data-testid="link-home">
            <Link href="/">Guest concierge</Link>
          </Button>
          <Button asChild variant="outline" data-testid="link-staff">
            <Link href="/staff">Team sign-in</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
