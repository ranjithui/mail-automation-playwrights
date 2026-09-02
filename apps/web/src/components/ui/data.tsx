import * as React from 'react';
import { ChevronLeft, ChevronRight, Inbox as InboxIcon, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button, Skeleton } from './primitives';

/* --------------------------------------------------------------------- table */

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  /** Fixed width utility class, e.g. "w-40". Keeps dense tables from jumping. */
  width?: string;
  align?: 'left' | 'right' | 'center';
  cell: (row: T, index: number) => React.ReactNode;
  sortable?: boolean;
}

export function DataTable<T>({
  columns,
  rows,
  loading,
  rowKey,
  onRowClick,
  emptyState,
  skeletonRows = 8,
  sort,
  onSortChange,
  className,
}: {
  columns: Column<T>[];
  rows: T[];
  loading?: boolean;
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  emptyState?: React.ReactNode;
  skeletonRows?: number;
  sort?: { key: string; order: 'asc' | 'desc' };
  onSortChange?: (key: string) => void;
  className?: string;
}) {
  if (!loading && rows.length === 0 && emptyState) {
    return <div className={cn('rounded-lg border border-border bg-surface', className)}>{emptyState}</div>;
  }

  const alignClass = (align?: string) =>
    align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';

  return (
    <div className={cn('overflow-x-auto rounded-lg border border-border bg-surface', className)}>
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={cn(column.width, alignClass(column.align))} scope="col">
                {column.sortable && onSortChange ? (
                  <button
                    type="button"
                    onClick={() => onSortChange(column.key)}
                    className="inline-flex cursor-pointer items-center gap-1 uppercase tracking-wider transition-colors hover:text-foreground"
                  >
                    {column.header}
                    {sort?.key === column.key ? <span aria-hidden>{sort.order === 'asc' ? '↑' : '↓'}</span> : null}
                  </button>
                ) : (
                  column.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading
            ? // Skeleton rows reserve the same height as real rows so the layout
              // never jumps when data arrives.
              Array.from({ length: skeletonRows }).map((_, index) => (
                <tr key={`skeleton-${index}`}>
                  {columns.map((column) => (
                    <td key={column.key} className={column.width}>
                      <Skeleton className="h-4" />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((row, index) => (
                <tr
                  key={rowKey(row, index)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={onRowClick ? 'cursor-pointer' : undefined}
                >
                  {columns.map((column) => (
                    <td key={column.key} className={cn(column.width, alignClass(column.align))}>
                      {column.cell(row, index)}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------------------------------------- pagination */

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  className,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  className?: string;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground', className)}>
      <span className="num">
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
        >
          <ChevronLeft />
        </Button>
        <span className="num px-2">
          {page} / {totalPages}
        </span>
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          aria-label="Next page"
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- empty state */

export function EmptyState({
  icon: Icon = InboxIcon,
  title,
  description,
  action,
  className,
  compact,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center px-6 text-center',
        compact ? 'py-10' : 'py-16',
        className,
      )}
    >
      <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-muted">
        <Icon className="size-5 text-muted-foreground" aria-hidden />
      </div>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {description ? (
        <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ kpi card */

export function KpiCard({
  label,
  value,
  delta,
  hint,
  icon: Icon,
  tone = 'neutral',
  loading,
}: {
  label: string;
  value: React.ReactNode;
  delta?: { value: string; direction: 'up' | 'down' | 'flat' } | null;
  hint?: string;
  icon?: LucideIcon;
  tone?: 'neutral' | 'primary' | 'success' | 'warning' | 'danger';
  loading?: boolean;
}) {
  const iconTone = {
    neutral: 'bg-muted text-muted-foreground',
    primary: 'bg-primary-muted text-primary',
    success: 'bg-success-muted text-success',
    warning: 'bg-warning-muted text-warning',
    danger: 'bg-danger-muted text-danger',
  }[tone];

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
          {loading ? (
            <Skeleton className="mt-2 h-7 w-20" />
          ) : (
            <p className="num mt-1 text-2xl font-semibold leading-tight tracking-tight text-foreground">{value}</p>
          )}
          {hint ? <p className="mt-1 truncate text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        {Icon ? (
          <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-md', iconTone)}>
            <Icon className="size-4" aria-hidden />
          </span>
        ) : null}
      </div>
      {delta ? (
        <p
          className={cn(
            'mt-2 text-xs font-medium',
            delta.direction === 'up' ? 'text-success' : delta.direction === 'down' ? 'text-danger' : 'text-muted-foreground',
          )}
        >
          {delta.direction === 'up' ? '▲' : delta.direction === 'down' ? '▼' : '■'} {delta.value}
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- page header */

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  breadcrumb?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        {breadcrumb ? <div className="mb-1 text-xs text-muted-foreground">{breadcrumb}</div> : null}
        <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description ? <p className="mt-1 text-[13px] text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------- error display */

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <div className="rounded-lg border border-danger/30 bg-danger-muted px-5 py-4">
      <p className="text-[13px] font-medium text-danger">{message}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
