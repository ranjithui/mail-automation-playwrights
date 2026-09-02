import * as React from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, Mail, ShieldCheck, Sparkles, Workflow } from 'lucide-react';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  type LoginInput,
  type RegisterInput,
} from '@mail/shared';
import { api, ApiError, setActiveWorkspace } from '@/lib/api';
import { useSession } from '@/hooks/use-session';
import { Button, Field, Input } from '@/components/ui/primitives';

/** Marketing rail shown beside every auth form on large screens. */
function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-2">
      <div className="flex items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          <Link to="/" className="mb-8 inline-flex items-center gap-2 text-base font-semibold tracking-tight">
            <span className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Mail className="size-4" aria-hidden />
            </span>
            MailFlow
          </Link>

          <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">{subtitle}</p>

          <div className="mt-6">{children}</div>
          {footer ? <div className="mt-6 text-[13px] text-muted-foreground">{footer}</div> : null}
        </div>
      </div>

      <aside className="hidden flex-col justify-center border-l border-border bg-muted/40 px-12 lg:flex">
        <h2 className="max-w-md text-2xl font-semibold leading-tight tracking-tight text-foreground">
          Outbound that stops when someone replies.
        </h2>
        <p className="mt-3 max-w-md text-[13px] leading-relaxed text-muted-foreground">
          Sequences run inside real Gmail threads, replies land in a shared inbox, and every pending follow-up is
          cancelled the moment a prospect answers.
        </p>

        <ul className="mt-8 space-y-4">
          {[
            { icon: Workflow, title: 'Unlimited sequence steps', body: 'Initial send plus as many follow-ups as you need, each with its own delay, template and attachments.' },
            { icon: Mail, title: 'True thread replies', body: 'Follow-ups continue the existing conversation with a trimmed quote chain, not a fresh email.' },
            { icon: Sparkles, title: 'AI-assisted inbox', body: 'Intent, priority and drafted replies — reviewed by a human before anything is sent.' },
            { icon: ShieldCheck, title: 'Safety built in', body: 'Suppression, bounce handling and opt-out detection checked before every single send.' },
          ].map((feature) => (
            <li key={feature.title} className="flex gap-3">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-primary-muted text-primary">
                <feature.icon className="size-4" aria-hidden />
              </span>
              <span className="max-w-md">
                <span className="block text-[13px] font-medium text-foreground">{feature.title}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{feature.body}</span>
              </span>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const { refresh } = useSession();

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '', remember: true },
  });

  const login = useMutation({
    mutationFn: (values: LoginInput) => api.post<{ user: { activeWorkspaceId: string | null } }>('/auth/login', values),
    onSuccess: async (data) => {
      if (data.user.activeWorkspaceId) setActiveWorkspace(data.user.activeWorkspaceId);
      await refresh();
      navigate('/', { replace: true });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : 'Sign in failed';
      form.setError('password', { message });
      toast.error(message);
    },
  });

  const fillDemo = () => {
    form.setValue('email', 'admin@mailflow.local');
    form.setValue('password', 'Admin@12345');
  };

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Use your workspace credentials to continue."
      footer={
        <>
          No account yet?{' '}
          <Link to="/register" className="font-medium text-primary hover:underline">
            Create a workspace
          </Link>
        </>
      }
    >
      <form className="space-y-4" onSubmit={form.handleSubmit((values) => login.mutate(values))} noValidate>
        <Field label="Email address" htmlFor="email" error={form.formState.errors.email?.message} required>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            {...form.register('email')}
          />
        </Field>

        <Field label="Password" htmlFor="password" error={form.formState.errors.password?.message} required>
          <Input id="password" type="password" autoComplete="current-password" {...form.register('password')} />
        </Field>

        <div className="flex items-center justify-between">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" className="size-3.5 cursor-pointer rounded border-input" {...form.register('remember')} />
            Keep me signed in
          </label>
          <Link to="/forgot-password" className="text-xs text-primary hover:underline">
            Forgot password?
          </Link>
        </div>

        <Button type="submit" variant="primary" size="lg" className="w-full" loading={login.isPending}>
          Sign in
        </Button>
      </form>

      <div className="mt-5 rounded-md border border-border bg-muted/50 p-3">
        <p className="text-xs font-medium text-foreground">Demo workspace</p>
        <p className="mt-1 font-mono text-2xs text-muted-foreground">admin@mailflow.local · Admin@12345</p>
        <Button variant="outline" size="sm" className="mt-2 w-full" onClick={fillDemo} type="button">
          Fill demo credentials
        </Button>
      </div>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const navigate = useNavigate();
  const { refresh } = useSession();

  const form = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: { firstName: '', lastName: '', email: '', password: '', organizationName: '' },
  });

  const register = useMutation({
    mutationFn: (values: RegisterInput) => api.post<{ user: { activeWorkspaceId: string | null } }>('/auth/register', values),
    onSuccess: async (data) => {
      if (data.user.activeWorkspaceId) setActiveWorkspace(data.user.activeWorkspaceId);
      await refresh();
      toast.success('Workspace created');
      navigate('/', { replace: true });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : 'Registration failed';
      if (error instanceof ApiError && error.code === 'EMAIL_TAKEN') form.setError('email', { message });
      toast.error(message);
    },
  });

  return (
    <AuthLayout
      title="Create your workspace"
      subtitle="You will be the owner, with full control over members and mailboxes."
      footer={
        <>
          Already registered?{' '}
          <Link to="/login" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form className="space-y-4" onSubmit={form.handleSubmit((values) => register.mutate(values))} noValidate>
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name" htmlFor="firstName" error={form.formState.errors.firstName?.message} required>
            <Input id="firstName" autoComplete="given-name" {...form.register('firstName')} />
          </Field>
          <Field label="Last name" htmlFor="lastName" error={form.formState.errors.lastName?.message} required>
            <Input id="lastName" autoComplete="family-name" {...form.register('lastName')} />
          </Field>
        </div>

        <Field label="Organization" htmlFor="organizationName" error={form.formState.errors.organizationName?.message} required>
          <Input id="organizationName" placeholder="Acme Ltd" {...form.register('organizationName')} />
        </Field>

        <Field label="Work email" htmlFor="email" error={form.formState.errors.email?.message} required>
          <Input id="email" type="email" autoComplete="email" {...form.register('email')} />
        </Field>

        <Field
          label="Password"
          htmlFor="password"
          error={form.formState.errors.password?.message}
          hint="At least 10 characters with upper case, lower case and a number."
          required
        >
          <Input id="password" type="password" autoComplete="new-password" {...form.register('password')} />
        </Field>

        <Button type="submit" variant="primary" size="lg" className="w-full" loading={register.isPending}>
          Create workspace
        </Button>
      </form>
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const [sent, setSent] = React.useState<string | null>(null);
  const form = useForm({ resolver: zodResolver(forgotPasswordSchema), defaultValues: { email: '' } });

  const request = useMutation({
    mutationFn: (values: { email: string }) => api.post<{ sent: boolean; resetUrl?: string }>('/auth/forgot-password', values),
    onSuccess: (data) => setSent(data.resetUrl ?? ''),
  });

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="We will send a reset link to your registered address."
      footer={
        <Link to="/login" className="font-medium text-primary hover:underline">
          Back to sign in
        </Link>
      }
    >
      {sent !== null ? (
        <div className="rounded-md border border-success/30 bg-success-muted p-4">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-foreground">Check your inbox</p>
              <p className="mt-1 text-xs text-muted-foreground">
                If that address is registered, a reset link is on its way.
              </p>
              {sent ? (
                <>
                  <p className="mt-3 text-xs text-muted-foreground">
                    No mail provider is configured on this install, so here is the link directly:
                  </p>
                  <a href={sent} className="mt-1 block break-all font-mono text-2xs text-primary hover:underline">
                    {sent}
                  </a>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={form.handleSubmit((values) => request.mutate(values))} noValidate>
          <Field label="Email address" htmlFor="email" error={form.formState.errors.email?.message} required>
            <Input id="email" type="email" autoComplete="email" {...form.register('email')} />
          </Field>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={request.isPending}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const form = useForm({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { token: params.get('token') ?? '', password: '' },
  });

  const reset = useMutation({
    mutationFn: (values: { token: string; password: string }) => api.post('/auth/reset-password', values),
    onSuccess: () => {
      toast.success('Password updated — sign in with your new password');
      navigate('/login', { replace: true });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Reset failed'),
  });

  return (
    <AuthLayout title="Choose a new password" subtitle="Signing in elsewhere will require the new password.">
      <form className="space-y-4" onSubmit={form.handleSubmit((values) => reset.mutate(values))} noValidate>
        <Field label="Reset token" htmlFor="token" error={form.formState.errors.token?.message} required>
          <Input id="token" className="font-mono text-xs" {...form.register('token')} />
        </Field>
        <Field
          label="New password"
          htmlFor="password"
          error={form.formState.errors.password?.message}
          hint="At least 10 characters with upper case, lower case and a number."
          required
        >
          <Input id="password" type="password" autoComplete="new-password" {...form.register('password')} />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={reset.isPending}>
          Update password
        </Button>
      </form>
    </AuthLayout>
  );
}
