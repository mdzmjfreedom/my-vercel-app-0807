"use client";
import Link from "next/link";
import { ArrowLeft, Clock3, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
export default function TracePage({ params }: { params: Promise<{ traceId: string }> }) {
  const [traceId, setTraceId] = useState(""); const [events, setEvents] = useState<Array<{ id: string; eventName: string; eventStatus: string; message: string; occurredAt: string; batch?: { batchIndex: number; startRow: number; endRow: number; status: string; retryCount: number } | null }>>([]);
  useEffect(() => { void params.then(async ({ traceId: id }) => { setTraceId(id); const res = await fetch(`/api/traces/${id}`, { cache: "no-store" }); if (res.ok) setEvents((await res.json()).events ?? []); }); }, [params]);
  return <div className="v4-page"><div className="v4-heading"><div><span className="v4-eyebrow">TRACE SEARCH</span><h2>链路时间线</h2><p>{traceId}</p></div><Link className="secondary-button" href="/import-monitor"><ArrowLeft size={14} />返回监控</Link></div><section className="card">{events.length ? <div className="v4-timeline large">{events.map((event) => <div key={event.id}><time><Clock3 size={13} />{new Date(event.occurredAt).toLocaleTimeString()}</time><b>{event.eventName}</b><span>{event.message}</span>{event.batch && <small>批次 {event.batch.batchIndex + 1} · 行 {event.batch.startRow}-{event.batch.endRow} · 重试 {event.batch.retryCount} 次</small>}</div>)}</div> : <div className="v4-empty"><Loader2 className="spin" />正在加载 Trace 事件</div>}</section></div>;
}
