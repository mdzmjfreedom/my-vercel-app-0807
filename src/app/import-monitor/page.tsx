"use client";

import Link from "next/link";
import { Activity, AlertTriangle, BarChart3, Clock3, Database, RefreshCw, Server } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import "./monitor.css";

type Summary = {
  queue_mode: "QSTASH" | "DATABASE_FALLBACK";
  throughput_per_minute: number;
  throughput_series: Array<{ minute: string; rows: number }>;
  queue_backlog_batches: number;
  queue_alert: boolean;
  failed_tasks_5m: number;
  stage_latency_ms: Record<string, { p50: number; p95: number; p99: number }>;
  error_distribution: Array<{ error_code: string; count: number }>;
};

export default function ImportMonitorPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [updatedAt, setUpdatedAt] = useState("");
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/import-monitor/summary", { cache: "no-store" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "监控服务不可用");
        setSummary(data);
        setUpdatedAt(new Date().toLocaleTimeString());
        setLoadError("");
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "监控服务不可用");
      }
    };
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 5000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, []);

  const maxRows = summary ? Math.max(1, ...summary.throughput_series.map((item) => item.rows)) : 1;
  return <div className="v4-page">
    <div className="v4-heading">
      <div><span className="v4-eyebrow">OBSERVABILITY / LIVE</span><h2>导入监控看板</h2><p>聚合过去 5 分钟的吞吐、队列积压、阶段耗时和错误分布。</p></div>
      <span className="v4-muted">{updatedAt ? `最后更新 ${updatedAt}` : "等待指标"}</span>
    </div>
    {!summary ? <div className="card v4-empty">{loadError ? <AlertTriangle /> : <RefreshCw className="spin" />}{loadError || "正在加载监控指标"}</div> : <>
      <div className="v4-monitor-grid">
        <Metric icon={<Activity />} label="实时吞吐" value={`${summary.throughput_per_minute.toLocaleString()} 行/分钟`} />
        <Metric icon={<Server />} label="队列积压" value={`${summary.queue_backlog_batches} 批`} danger={summary.queue_alert} />
        <Metric icon={<AlertTriangle />} label="近 5 分钟失败任务" value={summary.failed_tasks_5m} danger={summary.failed_tasks_5m > 0} />
        <Metric icon={<Database />} label="Worker 模式" value={summary.queue_mode === "QSTASH" ? "QStash / Vercel Worker" : "数据库队列 / 本地 Worker"} />
      </div>
      <section className="card">
        <div className="v4-section-head"><div><h3>过去 5 分钟成功入库行数</h3><p>按任务完成时间聚合，每分钟一个数据点。</p></div><Activity size={18} /></div>
        <div className="v4-throughput-chart">{summary.throughput_series.map((item) => <div key={item.minute}><b>{item.rows.toLocaleString()}</b><i style={{ height: `${Math.max(3, (item.rows / maxRows) * 100)}%` }} /><span>{new Date(item.minute).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>)}</div>
      </section>
      <div className="v4-columns">
        <section className="card"><div className="v4-section-head"><div><h3>阶段耗时 P50 / P95 / P99</h3><p>用于判断瓶颈位于解析、规则、校验还是批量写入。</p></div><Clock3 size={18} /></div><div className="v4-latency-list">{Object.entries(summary.stage_latency_ms).map(([stage, value]) => <div key={stage}><span>{stageLabel(stage)}</span><div className="v4-latency-bar"><i style={{ width: `${Math.min(100, value.p99 / 10)}%` }} /></div><b>{value.p50} / {value.p95} / {value.p99} ms</b></div>)}</div></section>
        <section className="card"><div className="v4-section-head"><div><h3>错误类型分布</h3><p>点击错误码进入任务明细页继续定位。</p></div><BarChart3 size={18} /></div>{summary.error_distribution.length ? <div className="v4-error-list">{summary.error_distribution.map((item) => <div key={item.error_code}><Link href={`/imports?error_code=${item.error_code}`}>{item.error_code}</Link><span>{item.count} 条</span></div>)}</div> : <div className="v4-empty small">暂无错误记录</div>}</section>
      </div>
    </>}
  </div>;
}

function Metric({ icon, label, value, danger }: { icon: ReactNode; label: string; value: string | number; danger?: boolean }) {
  return <div className={`card v4-metric ${danger ? "danger" : ""}`}>{icon}<span>{label}</span><strong>{value}</strong></div>;
}

function stageLabel(stage: string) {
  return ({ parse: "文件解析", rule: "规则引擎", validate: "SKU 校验", insert: "批量写入", total: "全链路" } as Record<string, string>)[stage] ?? stage;
}
