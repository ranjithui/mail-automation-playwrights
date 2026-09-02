import * as React from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { format, parseISO } from 'date-fns';
import { cn } from '@/lib/utils';

/**
 * Chart theming.
 *
 * Recharts needs concrete colours, not CSS variables, so the palette is read
 * from the document once per theme change. Series colours are a fixed,
 * colour-blind-safe ordering, and every chart also renders an accessible
 * summary table for screen readers.
 */
function useChartTheme() {
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    const observer = new MutationObserver(() => setTick((n) => n + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return React.useMemo(() => {
    const read = (name: string, fallback: string) => {
      if (typeof window === 'undefined') return fallback;
      const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return value ? `hsl(${value})` : fallback;
    };
    return {
      series: [
        read('--chart-1', '#1E40AF'),
        read('--chart-2', '#0E7490'),
        read('--chart-3', '#F59E0B'),
        read('--chart-4', '#7C3AED'),
        read('--chart-5', '#059669'),
      ],
      grid: read('--border', '#E2E8F0'),
      axis: read('--muted-foreground', '#475569'),
      surface: read('--elevated', '#FFFFFF'),
      foreground: read('--foreground', '#0F172A'),
      danger: read('--danger', '#DC2626'),
      success: read('--success', '#059669'),
      // eslint-disable-next-line react-hooks/exhaustive-deps
    };
  }, [tick]);
}

const axisProps = (color: string) => ({
  stroke: color,
  fontSize: 11,
  tickLine: false,
  axisLine: false,
  tick: { fill: color },
});

function ChartTooltip({ active, payload, label, formatter }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border bg-elevated px-2.5 py-2 shadow-pop">
      <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        {formatter ? formatter(label) : label}
      </p>
      {payload.map((entry: any) => (
        <p key={entry.dataKey ?? entry.name} className="flex items-center gap-2 text-xs">
          <span className="size-2 rounded-sm" style={{ background: entry.color }} aria-hidden />
          <span className="text-muted-foreground">{entry.name}</span>
          <span className="num ml-auto font-medium text-foreground">{entry.value?.toLocaleString?.() ?? entry.value}</span>
        </p>
      ))}
    </div>
  );
}

const dayLabel = (value: string) => {
  try {
    return format(parseISO(value), 'd MMM');
  } catch {
    return value;
  }
};

/** Screen-reader alternative required by the accessibility guidance. */
function DataTableFallback({
  data,
  keys,
  labelKey,
  caption,
}: {
  data: Array<Record<string, unknown>>;
  keys: Array<{ key: string; label: string }>;
  labelKey: string;
  caption: string;
}) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{labelKey}</th>
          {keys.map((k) => (
            <th key={k.key} scope="col">
              {k.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.map((row, index) => (
          <tr key={index}>
            <th scope="row">{String(row[labelKey])}</th>
            {keys.map((k) => (
              <td key={k.key}>{String(row[k.key] ?? 0)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface SeriesConfig {
  key: string;
  label: string;
  colorIndex?: number;
}

export function TrendChart({
  data,
  series,
  height = 260,
  className,
  caption = 'Activity over time',
}: {
  data: Array<Record<string, unknown>>;
  series: SeriesConfig[];
  height?: number;
  className?: string;
  caption?: string;
}) {
  const theme = useChartTheme();

  return (
    <div className={cn('w-full', className)}>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <defs>
            {series.map((s, index) => (
              <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={theme.series[s.colorIndex ?? index]} stopOpacity={0.22} />
                <stop offset="100%" stopColor={theme.series[s.colorIndex ?? index]} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} vertical={false} />
          <XAxis dataKey="date" tickFormatter={dayLabel} minTickGap={28} {...axisProps(theme.axis)} />
          <YAxis allowDecimals={false} width={40} {...axisProps(theme.axis)} />
          <Tooltip content={<ChartTooltip formatter={dayLabel} />} />
          {series.map((s, index) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={theme.series[s.colorIndex ?? index]}
              strokeWidth={2}
              fill={`url(#grad-${s.key})`}
              dot={false}
              activeDot={{ r: 3 }}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      <DataTableFallback data={data} keys={series.map((s) => ({ key: s.key, label: s.label }))} labelKey="date" caption={caption} />
    </div>
  );
}

export function ComparisonBarChart({
  data,
  series,
  categoryKey = 'name',
  height = 260,
  layout = 'horizontal',
  caption = 'Comparison',
}: {
  data: Array<Record<string, unknown>>;
  series: SeriesConfig[];
  categoryKey?: string;
  height?: number;
  layout?: 'horizontal' | 'vertical';
  caption?: string;
}) {
  const theme = useChartTheme();
  const vertical = layout === 'vertical';

  return (
    <div className="w-full">
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          data={data}
          layout={layout}
          margin={{ top: 8, right: 12, left: vertical ? 12 : -18, bottom: 0 }}
          barCategoryGap={vertical ? '22%' : '30%'}
        >
          <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} horizontal={!vertical} vertical={vertical} />
          {vertical ? (
            <>
              <XAxis type="number" allowDecimals={false} {...axisProps(theme.axis)} />
              <YAxis type="category" dataKey={categoryKey} width={130} {...axisProps(theme.axis)} />
            </>
          ) : (
            <>
              <XAxis dataKey={categoryKey} {...axisProps(theme.axis)} />
              <YAxis allowDecimals={false} width={40} {...axisProps(theme.axis)} />
            </>
          )}
          <Tooltip content={<ChartTooltip />} cursor={{ fill: theme.grid, opacity: 0.35 }} />
          {series.length > 1 ? <Legend wrapperStyle={{ fontSize: 11, color: theme.axis }} iconType="square" iconSize={8} /> : null}
          {series.map((s, index) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              fill={theme.series[s.colorIndex ?? index]}
              radius={vertical ? [0, 3, 3, 0] : [3, 3, 0, 0]}
              maxBarSize={vertical ? 18 : 42}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <DataTableFallback data={data} keys={series.map((s) => ({ key: s.key, label: s.label }))} labelKey={categoryKey} caption={caption} />
    </div>
  );
}

export function DistributionChart({
  data,
  height = 240,
  caption = 'Distribution',
}: {
  data: Array<{ name: string; value: number }>;
  height?: number;
  caption?: string;
}) {
  const theme = useChartTheme();
  const total = data.reduce((sum, d) => sum + d.value, 0);

  if (!total) {
    return <p className="py-10 text-center text-xs text-muted-foreground">No data in this period.</p>;
  }

  return (
    <div className="w-full">
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="82%" paddingAngle={2} strokeWidth={0}>
            {data.map((entry, index) => (
              <Cell key={entry.name} fill={theme.series[index % theme.series.length]} />
            ))}
          </Pie>
          <Tooltip content={<ChartTooltip />} />
          <Legend
            wrapperStyle={{ fontSize: 11, color: theme.axis }}
            iconType="circle"
            iconSize={8}
            formatter={(value: string) => <span style={{ color: theme.axis }}>{value}</span>}
          />
        </PieChart>
      </ResponsiveContainer>
      <DataTableFallback data={data} keys={[{ key: 'value', label: 'Count' }]} labelKey="name" caption={caption} />
    </div>
  );
}

export function Sparkline({
  data,
  dataKey,
  height = 40,
  tone = 'primary',
}: {
  data: Array<Record<string, unknown>>;
  dataKey: string;
  height?: number;
  tone?: 'primary' | 'success' | 'danger';
}) {
  const theme = useChartTheme();
  const color = tone === 'success' ? theme.success : tone === 'danger' ? theme.danger : theme.series[0];

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
        <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.75} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
