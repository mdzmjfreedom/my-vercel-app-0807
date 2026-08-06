"use client";

import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock3, Loader2, RefreshCw, Search, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type Task = { task_id: string; file_name: string; trace_id: string; status: string; total_rows: number; processed_rows: number; success_rows: number; failed_rows: number; total_batches: number; completed_batches: number; degraded: boolean; throughput_per_minute: number; estimated_remaining_ms: number | null; recent_errors: Array<{ rowNumber: number; fieldName: string; rawValue: string; errorCode: string; errorReason: string; batchIndex: number }> };
type ErrorRow = { rowNumber: number; fieldName: string; rawValue: string; errorCode: string; errorReason: string; batchIndex: number };

export default function ImportTaskPage({ params }: { params: Promise<{ taskId: string }> }) {
  const [taskId, setTaskId] = useState("");
  const [task, setTask] = useState<Task | null>(null);
  const [errors, setErrors] = useState<ErrorRow[]>([]);
  const [errorCode, setErrorCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => { void params.then(({ taskId: id }) => setTaskId(id)); }, [params]);
  const load = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    try {
      const [taskRes, errorRes] = await Promise.all([
        fetch(`/api/import-tasks/${taskId}`, { cache: "no-store" }),
        fetch(`/api/import-tasks/${taskId}/errors?page=1&page_size=20${errorCode ? `&error_code=${encodeURIComponent(errorCode)}` : ""}`, { cache: "no-store" }),
      ]);
      const next = await taskRes.json();
      if (!taskRes.ok) throw new Error(next.error || "任务不存在或无权访问");
      const errorData = await errorRes.json();
      setTask(next);
      setErrors(errorData.errors ?? []);
      setLoadError("");
    } catch (error) { setTask(null); setLoadError(error instanceof Error ? error.message : "任务读取失败"); } finally { setLoading(false); }
  }, [taskId, errorCode]);
  useEffect(() => { const initial = window.setTimeout(() => void load(), 0); const timer = window.setInterval(() => void load(), 2000); return () => { window.clearTimeout(initial); window.clearInterval(timer); }; }, [load]);

  const percent = task && task.total_rows ? Math.min(100, Math.round((task.processed_rows / task.total_rows) * 100)) : 0;
  const isDone = task ? ["COMPLETED", "PARTIAL_SUCCESS", "FAILED"].includes(task.status) : false;
  return <div className="v4-page">
    <div className="v4-heading"><div><span className="v4-eyebrow">ASYNC IMPORT / TASK</span><h2>导入任务进度</h2><p>{task?.file_name ?? "正在读取任务..."}</p></div><div className="v4-actions"><button className="secondary-button" onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? "spin" : ""} />刷新</button><Link className="secondary-button" href="/import-monitor">监控看板</Link></div></div>
    {!task ? <div className="card v4-empty">{loading ? <Loader2 className="spin" /> : <AlertTriangle />}{loading ? "正在加载任务..." : loadError || "任务不存在或无权访问"}</div> : <>
      <div className="v4-task-meta"><span>task_id <b>{task.task_id}</b></span><span>trace_id <b>{task.trace_id}</b></span><span className={`v4-status ${task.status.toLowerCase()}`}>{statusLabel(task.status)}</span>{task.degraded && <span className="v4-warning"><AlertTriangle size={14} />SKU 校验已降级</span>}</div>
      <div className="v4-progress card"><div className="v4-progress-top"><strong>{percent}%</strong><span>{task.processed_rows.toLocaleString()} / {task.total_rows.toLocaleString()} 行</span></div><div className="v4-track"><span style={{ width: `${percent}%` }} /></div><div className="v4-stat-grid"><Stat label="成功行" value={task.success_rows} icon={<CheckCircle2 />} tone="good" /><Stat label="失败行" value={task.failed_rows} icon={<XCircle />} tone="bad" /><Stat label="批次进度" value={`${task.completed_batches} / ${task.total_batches}`} icon={<Clock3 />} /><Stat label="当前吞吐" value={`${task.throughput_per_minute.toLocaleString()} 行/分钟`} icon={<RefreshCw />} /></div>{!isDone && task.estimated_remaining_ms !== null && <p className="v4-muted">预计剩余 {formatDuration(task.estimated_remaining_ms)}，页面每 2 秒自动刷新。</p>}</div>
      <div className="v4-columns"><section className="card"><div className="v4-section-head"><div><h3>错误明细</h3><p>按批次和错误码定位到具体行，敏感字段已脱敏。</p></div><div className="v4-filter"><Search size={14} /><select value={errorCode} onChange={(event) => setErrorCode(event.target.value)}><option value="">全部错误</option><option value="E001">E001 SKU 不存在</option><option value="E002">E002 必填缺失</option><option value="E003">E003 电话格式</option><option value="E004">E004 数量错误</option><option value="E005">E005 外部编码重复</option></select></div></div>{errors.length ? <div className="v4-table-wrap"><table className="v4-table"><thead><tr><th>批次</th><th>行号</th><th>字段</th><th>原始值</th><th>错误码</th><th>原因</th></tr></thead><tbody>{errors.map((error) => <tr key={`${error.batchIndex}-${error.rowNumber}-${error.errorCode}`}><td>{error.batchIndex + 1}</td><td>{error.rowNumber}</td><td>{error.fieldName}</td><td>{error.rawValue || "-"}</td><td><span className="v4-code">{error.errorCode}</span></td><td>{error.errorReason}</td></tr>)}</tbody></table></div> : <div className="v4-empty small">当前没有错误明细</div>}</section><section className="card"><div className="v4-section-head"><div><h3>链路定位</h3><p>通过 Trace 事件还原 API、Outbox、Worker 和批次状态。</p></div><Link className="secondary-button" href={`/traces/${task.trace_id}`}><Search size={14} />查看 Trace</Link></div><div className="v4-timeline"><div><b>ImportTaskCreated</b><span>任务创建与 Outbox 同事务完成</span></div><div><b>ImportBatchCreated</b><span>{task.total_batches} 个批次等待投递</span></div><div><b>Worker</b><span>{task.completed_batches} 个批次已完成，失败行可单独修复</span></div><div><b>{task.status}</b><span>{statusLabel(task.status)}</span></div></div></section></div>
    </>}
  </div>;
}

function Stat({ label, value, icon, tone }: { label: string; value: string | number; icon: React.ReactNode; tone?: string }) { return <div className={`v4-stat ${tone ?? ""}`}>{icon}<span>{label}</span><strong>{typeof value === "number" ? value.toLocaleString() : value}</strong></div>; }
function statusLabel(status: string) { return ({ PENDING: "等待处理", PROCESSING: "处理中", COMPLETED: "已完成", PARTIAL_SUCCESS: "部分成功", FAILED: "处理失败" } as Record<string, string>)[status] ?? status; }
function formatDuration(ms: number) { const seconds = Math.ceil(ms / 1000); return seconds > 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`; }
