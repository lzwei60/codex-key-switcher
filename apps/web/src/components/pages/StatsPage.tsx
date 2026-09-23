'use client';

import { DeleteOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button, Card, Empty, Popconfirm, Space, Statistic, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { UsageAggregateRow, UsageRecord, UsageStatsSnapshot, UsageTrendRow } from '@codex-key-switcher/shared';
import { useState } from 'react';
import { PageHeader } from '../layout/AppShell';
import { useAppPreferences } from '../../lib/app-preferences';

const { Text } = Typography;

interface ChartSeries {
  key: 'inputTokens' | 'outputTokens' | 'cachedTokens';
  color: string;
  name: string;
}

export function StatsPage({
  stats,
  loading,
  onClearLogs,
  onRefresh,
  onLogPageChange,
}: Readonly<{
  stats: UsageStatsSnapshot | null;
  loading: boolean;
  onClearLogs(): Promise<void>;
  onRefresh(): Promise<void>;
  onLogPageChange(page: number, pageSize: number): Promise<void>;
}>) {
  const { text } = useAppPreferences();
  const data = stats ?? emptyUsageStats();
  const { summary, trendRows, providerRows, modelRows, logs } = data;

  const aggregateColumns: ColumnsType<UsageAggregateRow> = [
    { title: text('名称', 'Name'), dataIndex: 'name', fixed: 'left', width: 180 },
    { title: text('请求数', 'Requests'), dataIndex: 'requests', width: 120 },
    { title: text('成功率', 'Success Rate'), dataIndex: 'successRate', width: 130, render: (value: number) => `${value}%` },
    { title: text('输入 Token', 'Input Tokens'), dataIndex: 'inputTokens', width: 150, render: formatNumber },
    { title: text('输出 Token', 'Output Tokens'), dataIndex: 'outputTokens', width: 150, render: formatNumber },
    { title: text('缓存 Token', 'Cached Tokens'), dataIndex: 'cachedTokens', width: 150, render: formatNumber },
    { title: text('总 Token', 'Total Tokens'), dataIndex: 'totalTokens', width: 150, render: formatNumber },
    { title: text('平均耗时', 'Avg Duration'), dataIndex: 'averageDuration', width: 140, render: (value: number) => `${value}ms` },
  ];

  const logColumns: ColumnsType<UsageRecord> = [
    { title: text('时间', 'Time'), dataIndex: 'createdAt', width: 180, render: (value: number) => new Date(value).toLocaleString() },
    { title: text('供应商', 'Provider'), dataIndex: 'provider', width: 160 },
    { title: text('模型', 'Model'), dataIndex: 'model', width: 180 },
    {
      title: text('状态', 'Status'),
      dataIndex: 'status',
      width: 100,
      render: (value: number) => <Tag color={isSuccessStatus(value) ? 'success' : 'error'}>{value}</Tag>,
    },
    { title: text('输入 Token', 'Input'), dataIndex: 'inputTokens', width: 120, render: (value?: number) => formatNumber(value ?? 0) },
    { title: text('输出 Token', 'Output'), dataIndex: 'outputTokens', width: 120, render: (value?: number) => formatNumber(value ?? 0) },
    { title: text('缓存 Token', 'Cached'), dataIndex: 'cachedTokens', width: 120, render: (value?: number) => formatNumber(value ?? 0) },
    { title: text('耗时', 'Duration'), dataIndex: 'durationMs', width: 120, render: (value: number) => `${Math.round(value)}ms` },
    {
      title: text('转移尝试', 'Failover attempt'),
      key: 'failoverAttempt',
      width: 150,
      render: (_, record) => record.attempt
        ? <Tag color={record.failover ? 'warning' : 'default'}>{record.failover ? text(`备用 #${record.attempt}`, `Backup #${record.attempt}`) : text(`主路由 #${record.attempt}`, `Primary #${record.attempt}`)}</Tag>
        : '-',
    },
    { title: text('错误分类', 'Error category'), dataIndex: 'errorCategory', width: 160, render: (value?: string) => value || '-' },
    { title: text('来源', 'Source'), dataIndex: 'source', width: 180 },
  ];

  return (
    <>
      <PageHeader
        description={text('查看真实请求数、Token 消耗、成功率、趋势、供应商统计、模型统计和请求日志。', 'View real requests, token usage, success rate, trends, provider stats, model stats, and request logs.')}
        extra={(
          <Space wrap>
            <Popconfirm
              cancelText={text('取消', 'Cancel')}
              okButtonProps={{ danger: true, loading }}
              okText={text('确认清除', 'Clear')}
              onConfirm={() => void onClearLogs()}
              title={text(
                '清除后将删除全部统计数据、使用趋势、供应商统计、模型统计和请求日志，且无法恢复。确认清除吗？',
                'This will delete all stats, trends, provider stats, model stats, and request logs. It cannot be recovered. Continue?',
              )}
            >
              <Button danger disabled={summary.totalRequests === 0} icon={<DeleteOutlined />} loading={loading}>
                {text('清除全部统计数据', 'Clear All Stats')}
              </Button>
            </Popconfirm>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void onRefresh()}>
              {text('刷新真实数据', 'Refresh Real Data')}
            </Button>
          </Space>
        )}
        title={text('用量统计', 'Usage Stats')}
      />
      <div className="stats-grid">
        <Card loading={loading}><Statistic title={text('真实请求数', 'Real Requests')} value={summary.totalRequests} /></Card>
        <Card loading={loading}><Statistic title={text('真实消耗 Token', 'Real Tokens Used')} value={summary.totalTokens} /></Card>
        <Card loading={loading}><Statistic suffix="%" title={text('成功率', 'Success Rate')} value={summary.successRate} /></Card>
        <Card loading={loading}><Statistic suffix="ms" title={text('平均耗时', 'Avg Duration')} value={summary.averageDuration} /></Card>
      </div>

      <Card className="stats-section" title={text('使用趋势', 'Usage Trend')}>
        {summary.totalRequests ? (
          <UsageTrendChart
            rows={trendRows}
            text={text}
          />
        ) : (
          <Empty description={text('暂无趋势数据', 'No trend data')} />
        )}
      </Card>

      <Card className="stats-section" title={text('供应商统计', 'Provider Stats')}>
        <Table
          columns={aggregateColumns}
          dataSource={providerRows}
          loading={loading}
          locale={{ emptyText: <Empty description={text('暂无供应商统计', 'No provider stats')} /> }}
          pagination={createStatsPagination(providerRows.length, 8, text)}
          rowKey="key"
          scroll={{ x: 1220 }}
          size="small"
        />
      </Card>

      <Card className="stats-section" title={text('模型统计', 'Model Stats')}>
        <Table
          columns={aggregateColumns}
          dataSource={modelRows}
          loading={loading}
          locale={{ emptyText: <Empty description={text('暂无模型统计', 'No model stats')} /> }}
          pagination={createStatsPagination(modelRows.length, 8, text)}
          rowKey="key"
          scroll={{ x: 1220 }}
          size="small"
        />
      </Card>

      <Card className="stats-section" title={text('请求日志', 'Request Logs')}>
        <Space className="stats-log-hint" orientation="vertical">
          <Text type="secondary">
            {text('日志来自本地网关真实 UsageRecord，包含状态码、耗时、Token 和来源格式。', 'Logs are real local gateway UsageRecord entries with status, duration, tokens, and source format.')}
          </Text>
        </Space>
        <Table
          columns={logColumns}
          dataSource={logs.records}
          locale={{ emptyText: <Empty description={text('暂无请求日志', 'No request logs')} /> }}
          loading={loading}
          pagination={{
            ...createStatsPagination(logs.total, logs.pageSize, text),
            current: logs.page,
            pageSize: logs.pageSize,
            onChange: (page, pageSize) => void onLogPageChange(page, pageSize),
          }}
          rowKey="id"
          scroll={{ x: 1220 }}
        />
      </Card>
    </>
  );
}

function UsageTrendChart({
  rows,
  text,
}: Readonly<{
  rows: UsageTrendRow[];
  text(zh: string, en: string): string;
}>) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const width = 920;
  const height = 270;
  const padding = { top: 20, right: 36, bottom: 40, left: 76 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxValue = niceMax(Math.max(1, ...rows.flatMap((row) => [row.inputTokens, row.outputTokens, row.cachedTokens])));
  const yTicks = [maxValue, maxValue * 0.75, maxValue * 0.5, maxValue * 0.25, 0];
  const series: ChartSeries[] = [
    { key: 'inputTokens', color: '#2f7df6', name: text('蓝色线 输入 Tokens', 'Blue Input Tokens') },
    { key: 'outputTokens', color: '#ff3945', name: text('红色线 输出 Tokens', 'Red Output Tokens') },
    { key: 'cachedTokens', color: '#22c55e', name: text('绿色线 缓存 Tokens', 'Green Cached Tokens') },
  ];
  const inputTotal = rows.reduce((sum, row) => sum + row.inputTokens, 0);
  const outputTotal = rows.reduce((sum, row) => sum + row.outputTokens, 0);
  const cachedTotal = rows.reduce((sum, row) => sum + row.cachedTokens, 0);
  const hoveredRow = hoveredIndex === null ? null : rows[hoveredIndex] ?? null;

  function xAt(index: number): number {
    if (rows.length === 1) return padding.left + plotWidth / 2;
    return padding.left + (plotWidth * index) / (rows.length - 1);
  }

  function yAt(value: number): number {
    return padding.top + plotHeight - (plotHeight * value) / maxValue;
  }

  function pathFor(key: ChartSeries['key']): string {
    return rows
      .map((row, index) => `${index === 0 ? 'M' : 'L'} ${xAt(index)} ${yAt(row[key])}`)
      .join(' ');
  }

  function hoverBandWidth(): number {
    return rows.length === 1 ? plotWidth : plotWidth / (rows.length - 1);
  }

  function hoverBandX(index: number): number {
    if (rows.length === 1) return padding.left;
    const bandWidth = hoverBandWidth();
    return clampNumber(xAt(index) - bandWidth / 2, padding.left, width - padding.right - bandWidth);
  }

  function tooltipX(index: number): number {
    return clampNumber(xAt(index) - 112, padding.left, width - padding.right - 224);
  }

  function tooltipY(row: UsageTrendRow): number {
    const rowMax = Math.max(row.inputTokens, row.outputTokens, row.cachedTokens);
    return clampNumber(yAt(rowMax) - 112, padding.top, height - padding.bottom - 104);
  }

  return (
    <div className="usage-trend-chart">
      <svg
        aria-label={text('使用趋势折线图', 'Usage trend line chart')}
        className="usage-trend-svg"
        onMouseLeave={() => setHoveredIndex(null)}
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        {yTicks.map((tick) => {
          const y = yAt(tick);
          return (
            <g key={tick}>
              <line className="chart-grid-line" x1={padding.left} x2={width - padding.right} y1={y} y2={y} />
              <text className="chart-axis-label" textAnchor="end" x={padding.left - 10} y={y + 4}>{formatCompact(tick)}</text>
            </g>
          );
        })}
        {rows.map((row, index) => (
          <text className="chart-axis-label" key={row.key} textAnchor="middle" x={xAt(index)} y={height - 12}>{row.label}</text>
        ))}
        {series.map((item) => (
          <g key={item.key}>
            <path className="chart-line" d={pathFor(item.key)} stroke={item.color} />
            {rows.map((row, index) => (
              <circle className="chart-point" cx={xAt(index)} cy={yAt(row[item.key])} fill={item.color} key={`${item.key}:${row.key}`} r={3} />
            ))}
          </g>
        ))}
        {hoveredRow ? (
          <g pointerEvents="none">
            <line className="chart-hover-line" x1={xAt(hoveredIndex ?? 0)} x2={xAt(hoveredIndex ?? 0)} y1={padding.top} y2={height - padding.bottom} />
            <g transform={`translate(${tooltipX(hoveredIndex ?? 0)} ${tooltipY(hoveredRow)})`}>
              <rect className="chart-tooltip-card" height={104} rx={8} width={224} />
              <text className="chart-tooltip-title" x={14} y={24}>{hoveredRow.label}</text>
              <text className="chart-tooltip-text" x={14} y={48}>{`${text('输入', 'Input')}：${formatNumber(hoveredRow.inputTokens)}`}</text>
              <text className="chart-tooltip-text" x={14} y={70}>{`${text('输出', 'Output')}：${formatNumber(hoveredRow.outputTokens)}`}</text>
              <text className="chart-tooltip-text" x={14} y={92}>{`${text('缓存', 'Cached')}：${formatNumber(hoveredRow.cachedTokens)}`}</text>
            </g>
          </g>
        ) : null}
        {rows.map((row, index) => (
          <rect
            aria-label={`${row.label}: ${text('输入', 'Input')} ${formatNumber(row.inputTokens)}, ${text('输出', 'Output')} ${formatNumber(row.outputTokens)}, ${text('缓存', 'Cached')} ${formatNumber(row.cachedTokens)}`}
            className="chart-hover-zone"
            height={plotHeight}
            key={`hover:${row.key}`}
            onFocus={() => setHoveredIndex(index)}
            onMouseEnter={() => setHoveredIndex(index)}
            role="img"
            tabIndex={0}
            width={hoverBandWidth()}
            x={hoverBandX(index)}
            y={padding.top}
          />
        ))}
      </svg>
      <div className="usage-trend-legend">
        <LegendItem color="#2f7df6" label={`${text('蓝色线 输入 Tokens（最近 8 天合计）', 'Blue Input Tokens (last 8 days)')}：${formatNumber(inputTotal)}`} />
        <LegendItem color="#ff3945" label={`${text('红色线 输出 Tokens（最近 8 天合计）', 'Red Output Tokens (last 8 days)')}：${formatNumber(outputTotal)}`} />
        <LegendItem color="#22c55e" label={`${text('绿色线 缓存 Tokens（最近 8 天合计）', 'Green Cached Tokens (last 8 days)')}：${formatNumber(cachedTotal)}`} />
      </div>
      <Text className="chart-help" type="secondary">
        {text('横坐标：日期；纵坐标：Token 数量。', 'X axis: date; Y axis: token count.')}
      </Text>
    </div>
  );
}

function LegendItem({ color, label }: Readonly<{ color: string; label: string }>) {
  return (
    <span className="legend-item">
      <span className="legend-dot" style={{ background: color }} />
      {label}
    </span>
  );
}

function createStatsPagination(
  total: number,
  defaultPageSize: number,
  text: (zh: string, en: string) => string,
) {
  return {
    defaultCurrent: 1,
    defaultPageSize,
    pageSizeOptions: [8, 10, 20, 50],
    showQuickJumper: true,
    showSizeChanger: true,
    showTotal: (count: number, range: [number, number]) => {
      if (count === 0) return text('共 0 条', '0 items');
      return text(`共 ${count} 条，第 ${range[0]}-${range[1]} 条`, `${range[0]}-${range[1]} of ${count} items`);
    },
    total,
  };
}

function niceMax(value: number): number {
  if (value <= 10) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const rounded = normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return rounded * magnitude;
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString();
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${formatCompactUnit(value / 1_000_000)}M`;
  if (value >= 1_000) return `${formatCompactUnit(value / 1_000)}K`;
  return String(Math.round(value));
}

function formatCompactUnit(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 400;
}

function emptyUsageStats(): UsageStatsSnapshot {
  return {
    summary: {
      totalRequests: 0,
      successfulRequests: 0,
      successRate: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      averageDuration: 0,
    },
    trendRows: [],
    providerRows: [],
    modelRows: [],
    logs: {
      records: [],
      total: 0,
      page: 1,
      pageSize: 10,
    },
  };
}
