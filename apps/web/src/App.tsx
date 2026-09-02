import * as React from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { ApiError } from '@/lib/api';
import { SessionProvider, useSession } from '@/hooks/use-session';
import { RealtimeProvider } from '@/hooks/use-realtime';
import { TooltipProvider } from '@/components/ui/controls';
import { Spinner } from '@/components/ui/primitives';
import { AppShell } from '@/components/layout/AppShell';

import { ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage } from '@/pages/Auth';
import { DashboardPage } from '@/pages/Dashboard';
import { CampaignsPage } from '@/pages/campaigns/CampaignsPage';
import { CampaignWizardPage } from '@/pages/campaigns/CampaignWizardPage';
import { CampaignDetailPage } from '@/pages/campaigns/CampaignDetailPage';
import { ContactsPage } from '@/pages/contacts/ContactsPage';
import { ContactDetailPage } from '@/pages/contacts/ContactDetailPage';
import { ContactListsPage } from '@/pages/contacts/ContactListsPage';
import { SuppressionPage } from '@/pages/contacts/SuppressionPage';
import { TemplatesPage } from '@/pages/Templates';
import { EmailAccountsPage } from '@/pages/EmailAccounts';
import { InboxPage } from '@/pages/Inbox';
import { AIInboxPage } from '@/pages/AIInbox';
import { AutomationPage, JobsPage, LogsPage } from '@/pages/Automation';
import { AnalyticsPage } from '@/pages/Analytics';
import { BouncesPage } from '@/pages/Bounces';
import { NotificationsPage } from '@/pages/Notifications';
import { MembersPage, ProfilePage, SettingsPage } from '@/pages/Settings';
import { MigrationPage } from '@/pages/Migration';
import { NotFoundPage } from '@/pages/NotFound';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // Never retry a rejection the user has to act on.
        if (error instanceof ApiError && [400, 401, 403, 404, 422].includes(error.status)) return false;
        return failureCount < 2;
      },
    },
    mutations: { retry: false },
  },
});

function FullPageLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3">
        <Spinner className="size-6" />
        <p className="text-xs text-muted-foreground">Loading workspace…</p>
      </div>
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useSession();
  const location = useLocation();

  if (loading) return <FullPageLoader />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

function RedirectIfAuthenticated({ children }: { children: React.ReactNode }) {
  const { user, loading } = useSession();
  if (loading) return <FullPageLoader />;
  if (user) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionProvider>
          <RealtimeProvider>
            <TooltipProvider>
              <Routes>
                <Route
                  path="/login"
                  element={
                    <RedirectIfAuthenticated>
                      <LoginPage />
                    </RedirectIfAuthenticated>
                  }
                />
                <Route
                  path="/register"
                  element={
                    <RedirectIfAuthenticated>
                      <RegisterPage />
                    </RedirectIfAuthenticated>
                  }
                />
                <Route path="/forgot-password" element={<ForgotPasswordPage />} />
                <Route path="/reset-password" element={<ResetPasswordPage />} />

                <Route
                  element={
                    <RequireAuth>
                      <AppShell />
                    </RequireAuth>
                  }
                >
                  <Route index element={<DashboardPage />} />

                  <Route path="campaigns" element={<CampaignsPage />} />
                  <Route path="campaigns/new" element={<CampaignWizardPage />} />
                  <Route path="campaigns/:id" element={<CampaignDetailPage />} />
                  <Route path="campaigns/:id/edit" element={<CampaignWizardPage />} />

                  <Route path="contacts" element={<ContactsPage />} />
                  <Route path="contacts/lists" element={<ContactListsPage />} />
                  <Route path="contacts/suppression" element={<SuppressionPage />} />
                  <Route path="contacts/:id" element={<ContactDetailPage />} />

                  <Route path="templates" element={<TemplatesPage />} />
                  <Route path="email-accounts" element={<EmailAccountsPage />} />
                  <Route path="email-accounts/:id" element={<EmailAccountsPage />} />

                  <Route path="inbox" element={<InboxPage />} />
                  <Route path="ai-inbox" element={<AIInboxPage />} />

                  <Route path="automation" element={<AutomationPage />} />
                  <Route path="automation/jobs" element={<JobsPage />} />
                  <Route path="automation/logs" element={<LogsPage />} />

                  <Route path="analytics" element={<AnalyticsPage />} />
                  <Route path="bounces" element={<BouncesPage />} />
                  <Route path="notifications" element={<NotificationsPage />} />
                  <Route path="migration" element={<MigrationPage />} />

                  <Route path="settings" element={<SettingsPage />} />
                  <Route path="settings/members" element={<MembersPage />} />
                  <Route path="settings/profile" element={<ProfilePage />} />

                  <Route path="*" element={<NotFoundPage />} />
                </Route>
              </Routes>

              <Toaster
                position="bottom-right"
                closeButton
                toastOptions={{
                  classNames: {
                    toast: 'border border-border bg-surface text-foreground shadow-pop',
                    description: 'text-muted-foreground',
                  },
                }}
              />
            </TooltipProvider>
          </RealtimeProvider>
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
