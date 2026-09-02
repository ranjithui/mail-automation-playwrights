import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------- button */

const buttonVariants = cva(
  'inline-flex cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-muted text-foreground hover:bg-muted/70 border border-border',
        outline: 'border border-border bg-surface text-foreground hover:bg-muted',
        ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
        danger: 'bg-danger text-danger-foreground hover:bg-danger/90',
        success: 'bg-success text-success-foreground hover:bg-success/90',
        /** Reserved for the single highest-intent action on a screen. */
        accent: 'bg-accent text-accent-foreground hover:bg-accent/90',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        // 44px min touch target on the default size.
        sm: 'h-8 px-2.5 text-[13px] [&_svg]:size-3.5',
        md: 'h-9 px-3.5 text-[13px] [&_svg]:size-4',
        lg: 'h-11 px-5 text-sm [&_svg]:size-4',
        icon: 'h-9 w-9 [&_svg]:size-4',
        'icon-sm': 'h-7 w-7 [&_svg]:size-3.5',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, loading, children, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        // A button that is running must not be clickable twice.
        disabled={disabled || loading}
        {...props}
      >
        {loading ? (
          <>
            <Loader2 className="animate-spin" aria-hidden />
            {children}
          </>
        ) : (
          children
        )}
      </Comp>
    );
  },
);
Button.displayName = 'Button';

/* --------------------------------------------------------------------- input */

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'flex h-9 w-full rounded-md border border-input bg-surface px-3 py-1.5 text-[13px] text-foreground shadow-sm transition-colors',
        'placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-60',
        'file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs file:font-medium',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'flex min-h-20 w-full rounded-md border border-input bg-surface px-3 py-2 text-[13px] text-foreground shadow-sm transition-colors',
        'placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';

export function Label({
  className,
  required,
  children,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement> & { required?: boolean }) {
  return (
    <label className={cn('block text-xs font-medium text-foreground', className)} {...props}>
      {children}
      {required ? <span className="ml-0.5 text-danger">*</span> : null}
    </label>
  );
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  className,
  children,
}: {
  label?: string;
  htmlFor?: string;
  error?: string | null;
  hint?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {label ? (
        <Label htmlFor={htmlFor} required={required}>
          {label}
        </Label>
      ) : null}
      {children}
      {/* Error sits directly under the control it belongs to. */}
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------- card */

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('card', className)} {...props} />;
}

export function CardHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('card-header', className)}>
      <div className="min-w-0">
        <h3 className="card-title">{title}</h3>
        {subtitle ? <p className="card-subtitle mt-0.5">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5', className)} {...props} />;
}

/* --------------------------------------------------------------------- badge */

const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-2xs font-medium leading-4',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-muted text-muted-foreground',
        primary: 'border-primary/20 bg-primary-muted text-primary',
        success: 'border-success/20 bg-success-muted text-success',
        warning: 'border-warning/25 bg-warning-muted text-warning',
        danger: 'border-danger/20 bg-danger-muted text-danger',
        info: 'border-info/20 bg-info-muted text-info',
        outline: 'border-border bg-transparent text-muted-foreground',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

type Tone = NonNullable<BadgeProps['tone']>;

/** Single source of truth for how a domain status is coloured. */
export const STATUS_TONES: Record<string, Tone> = {
  // campaigns
  DRAFT: 'neutral',
  SCHEDULED: 'info',
  RUNNING: 'success',
  PAUSED: 'warning',
  COMPLETED: 'primary',
  FAILED: 'danger',
  CANCELLED: 'neutral',
  // contacts / steps
  NEW: 'neutral',
  QUEUED: 'info',
  PROCESSING: 'info',
  SENT: 'primary',
  DRAFTED: 'info',
  REPLIED: 'success',
  FOLLOWUP_PENDING: 'warning',
  BOUNCED: 'danger',
  UNSUBSCRIBED: 'danger',
  SKIPPED: 'neutral',
  PENDING: 'neutral',
  // connections
  CONNECTED: 'success',
  CONNECTING: 'info',
  DISCONNECTED: 'neutral',
  ERROR: 'danger',
  ACTIVE: 'success',
  DISABLED: 'neutral',
  STOPPED: 'neutral',
  STARTING: 'info',
  VALID: 'success',
  EXPIRED: 'warning',
  NONE: 'neutral',
  // jobs / logs
  DELAYED: 'info',
  SUCCESS: 'success',
  FAILURE: 'danger',
  INFO: 'info',
  WARNING: 'warning',
  // ai
  INTERESTED: 'success',
  NOT_INTERESTED: 'danger',
  ASKING_PRICING: 'primary',
  ASKING_INFORMATION: 'info',
  MEETING_REQUEST: 'primary',
  REQUEST_CALLBACK: 'primary',
  NEEDS_FOLLOWUP: 'warning',
  POSITIVE: 'success',
  NEGATIVE: 'danger',
  OUT_OF_OFFICE: 'neutral',
  UNSUBSCRIBE: 'danger',
  BOUNCE: 'danger',
  OTHER: 'neutral',
  HIGH: 'danger',
  MEDIUM: 'warning',
  LOW: 'neutral',
  NEUTRAL: 'neutral',
  OPEN: 'info',
  WAITING: 'warning',
  ARCHIVED: 'neutral',
  CLOSED: 'neutral',
};

export function StatusBadge({
  status,
  className,
  dot,
}: {
  status: string | null | undefined;
  className?: string;
  dot?: boolean;
}) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  const tone = STATUS_TONES[status] ?? 'neutral';
  return (
    <Badge tone={tone} className={className}>
      {/* Colour is never the only signal: the label is always present. */}
      {dot ? <span className="size-1.5 rounded-full bg-current" aria-hidden /> : null}
      {status.replace(/_/g, ' ').toLowerCase()}
    </Badge>
  );
}

/* ------------------------------------------------------------------- misc */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton h-4 w-full', className)} aria-hidden />;
}

export function Separator({ className, vertical }: { className?: string; vertical?: boolean }) {
  return (
    <div
      role="separator"
      className={cn(vertical ? 'h-full w-px' : 'h-px w-full', 'shrink-0 bg-border', className)}
    />
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin text-muted-foreground', className)} aria-hidden />;
}

export function Avatar({
  initials,
  className,
  tone = 'primary',
}: {
  initials: string;
  className?: string;
  tone?: 'primary' | 'muted';
}) {
  return (
    <span
      className={cn(
        'inline-flex size-8 shrink-0 select-none items-center justify-center rounded-full text-xs font-semibold',
        tone === 'primary' ? 'bg-primary-muted text-primary' : 'bg-muted text-muted-foreground',
        className,
      )}
      aria-hidden
    >
      {initials}
    </span>
  );
}

export function ProgressBar({
  value,
  className,
  tone = 'primary',
  label,
}: {
  value: number;
  className?: string;
  tone?: 'primary' | 'success' | 'warning' | 'danger';
  label?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  const bg = { primary: 'bg-primary', success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger' }[tone];
  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? 'Progress'}
    >
      <div className={cn('h-full rounded-full transition-[width] duration-300', bg)} style={{ width: `${clamped}%` }} />
    </div>
  );
}
