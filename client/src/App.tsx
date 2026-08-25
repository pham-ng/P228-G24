import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SessionProvider, useSession } from "@/lib/session";
import NotFound from "@/pages/not-found";
import GuestPage from "@/pages/guest";
import LoginPage from "@/pages/login";
import InboxPage from "@/pages/inbox";
import TasksPage from "@/pages/tasks";
import RoomsPage from "@/pages/rooms";
import ReservationsPage from "@/pages/reservations";
import InsightsPage from "@/pages/insights";
import KnowledgePage from "@/pages/knowledge";
import PoliciesPage from "@/pages/policies";
import CampaignsPage from "@/pages/campaigns";
import AuditPage from "@/pages/audit";
import BenchmarkPage from "@/pages/benchmark";
import TracesPage from "@/pages/traces";
import SettingsPage from "@/pages/settings";

/**
 * wouter's hash location returns the full hash including any query string
 * (`/?code=AUR-9K52JH`), which never matches a route. Strip it — deep-link
 * params are read from `window.location.hash` by the pages that need them.
 */
function useAppLocation(): [string, (to: string, options?: { replace?: boolean }) => void] {
  const [loc, navigate] = useHashLocation();
  const path = loc.split("?")[0] || "/";
  return [path, navigate];
}

/** Staff pages require a signed-in team member; guests never see them. */
function Protected({ component: Component }: { component: () => JSX.Element }) {
  const { staff } = useSession();
  if (!staff) return <LoginPage />;
  return <Component />;
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={GuestPage} />
      <Route path="/staff" component={() => <Protected component={InboxPage} />} />
      <Route path="/staff/tasks" component={() => <Protected component={TasksPage} />} />
      <Route path="/staff/rooms" component={() => <Protected component={RoomsPage} />} />
      <Route
        path="/staff/reservations"
        component={() => <Protected component={ReservationsPage} />}
      />
      <Route path="/staff/insights" component={() => <Protected component={InsightsPage} />} />
      <Route path="/staff/knowledge" component={() => <Protected component={KnowledgePage} />} />
      <Route path="/staff/policies" component={() => <Protected component={PoliciesPage} />} />
      <Route path="/staff/campaigns" component={() => <Protected component={CampaignsPage} />} />
      <Route path="/staff/benchmark" component={() => <Protected component={BenchmarkPage} />} />
      <Route path="/staff/traces" component={() => <Protected component={TracesPage} />} />
      <Route path="/staff/audit" component={() => <Protected component={AuditPage} />} />
      <Route path="/staff/settings" component={() => <Protected component={SettingsPage} />} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <TooltipProvider>
          <Toaster />
          <Router hook={useAppLocation}>
            <AppRouter />
          </Router>
        </TooltipProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}

export default App;
