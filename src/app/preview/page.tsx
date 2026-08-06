"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import * as XLSX from "xlsx";
import { ArrowLeft, Download, Loader2, SendHorizontal } from "lucide-react";
import PreviewTable from "@/components/PreviewTable";
import type { ParsedOrder, ValidationIssue } from "@/lib/types";
import { aggregateOrders, validateOrders } from "@/lib/types";

type PreviewPayload = {
  fileName: string;
  ruleName: string;
  orders: ParsedOrder[];
  issues: ValidationIssue[];
  metrics?: { rowCount: number; elapsedMs: number };
};

export default function PreviewPage() {
  const [payload, setPayload] = useState<PreviewPayload | null>(null);
  const [rows, setRows] = useState<ParsedOrder[]>([]);
  const [existingCodes, setExistingCodes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitProgress, setSubmitProgress] = useState(0);
  const [notice, setNotice] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function hydratePreviewPayload() {
      await Promise.resolve();
      try {
        const raw = sessionStorage.getItem("previewPayload");
        if (raw && !cancelled) {
          const parsed = JSON.parse(raw) as PreviewPayload;
          setPayload(parsed);
          setRows(parsed.orders ?? []);
        }
      } catch {
        if (!cancelled) {
          setNotice({ type: "error", text: "预览数据读取失败，请重新上传并解析。" });
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void hydratePreviewPayload();
    void fetch("/api/existing-codes", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (data.success && !cancelled) setExistingCodes(data.codes ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          setNotice({ type: "info", text: "历史外部编码读取失败，本批次仍可继续校验和导出。" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!payload) return;
    sessionStorage.setItem("previewPayload", JSON.stringify({ ...payload, orders: rows }));
  }, [rows, payload]);

  const issues = useMemo(() => validateOrders(rows, existingCodes), [rows, existingCodes]);
  const orderGroups = useMemo(() => aggregateOrders(rows), [rows]);
  const blockingIssues = issues.filter((issue) => issue.severity === "error");

  function exportExcel() {
    const outputRows = rows.map((row) => ({
      外部编码: row.externalCode ?? "",
      收货门店: row.receiverShop ?? "",
      收件人姓名: row.receiverName ?? "",
      收件人电话: row.receiverPhone ?? "",
      收件人地址: row.receiverAddress ?? "",
      SKU物品编码: row.skuCode ?? "",
      SKU物品名称: row.skuName ?? "",
      SKU发货数量: row.qty ?? "",
      SKU规格型号: row.skuSpec ?? "",
      备注: row.remark ?? "",
    }));
    const worksheet = XLSX.utils.json_to_sheet(outputRows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "导入预览");
    XLSX.writeFile(workbook, `万能导入预览-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  async function submitOrders() {
    if (blockingIssues.length) {
      setNotice({ type: "error", text: `还有 ${blockingIssues.length} 个错误未修正，不能提交。` });
      return;
    }
    if (!rows.length) {
      setNotice({ type: "error", text: "没有可提交的数据。" });
      return;
    }

    setSubmitting(true);
    setSubmitProgress(15);
    try {
      const timer = window.setInterval(() => {
        setSubmitProgress((value) => Math.min(88, value + 12));
      }, 180);
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orders: rows }),
      });
      window.clearInterval(timer);
      setSubmitProgress(100);
      const data = await res.json();
      if (!data.success) {
        if (Array.isArray(data.issues)) {
          setNotice({ type: "error", text: `提交被拦截：${data.issues.length} 个错误，请检查错误列表。` });
        } else {
          throw new Error(data.error || "提交失败");
        }
        return;
      }
      setNotice({
        type: "success",
        text: `提交成功：成功 ${data.summary?.successCount ?? rows.length} 条 SKU，聚合 ${data.summary?.outboundOrderCount ?? orderGroups.length} 个出库单，失败 ${data.summary?.failedCount ?? 0} 条。`,
      });
      void fetch("/api/existing-codes", { cache: "no-store" })
        .then((res) => res.json())
        .then((fresh) => {
          if (fresh.success) setExistingCodes(fresh.codes ?? []);
        });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "提交下单失败" });
    } finally {
      window.setTimeout(() => {
        setSubmitting(false);
        setSubmitProgress(0);
      }, 700);
    }
  }

  if (loading) {
    return (
      <div className="container">
        <div className="card centered-state">
          <Loader2 className="spin" size={24} />
          <p>预览数据加载中...</p>
        </div>
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="container">
        <div className="card centered-state">
          <h2>暂无预览数据</h2>
          <p>请先上传文件并选择规则执行解析。</p>
          <Link className="primary-button" href="/">
            <ArrowLeft size={16} />
            返回导入任务
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container preview-page">
      <div className="page-heading">
        <div>
          <Link className="back-link" href="/">
            <ArrowLeft size={16} />
            返回导入
          </Link>
          <h2>数据预览与编辑</h2>
          <p>
            {payload.fileName} · {payload.ruleName} · 解析 {payload.metrics?.rowCount ?? rows.length} 行
            {payload.metrics ? ` · ${payload.metrics.elapsedMs}ms` : ""}
          </p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" onClick={exportExcel} disabled={!rows.length}>
            <Download size={16} />
            导出 Excel
          </button>
          <button className="primary-button" onClick={submitOrders} disabled={submitting || !rows.length}>
            {submitting ? <Loader2 className="spin" size={16} /> : <SendHorizontal size={16} />}
            提交下单
          </button>
        </div>
      </div>

      {notice && <div className={`notice ${notice.type}`}>{notice.text}</div>}

      {submitting && (
        <div className="progress-card">
          <div className="progress-label">
            <span>提交下单中</span>
            <strong>{submitProgress}%</strong>
          </div>
          <div className="progress-track">
            <span style={{ width: `${submitProgress}%` }} />
          </div>
        </div>
      )}

      <div className="preview-summary">
        <div>
          <strong>{orderGroups.length}</strong>
          <span>出库单数</span>
        </div>
        <div>
          <strong>{rows.length}</strong>
          <span>预览行数</span>
        </div>
        <div>
          <strong>{blockingIssues.length}</strong>
          <span>阻断错误</span>
        </div>
        <div>
          <strong>{issues.filter((issue) => issue.severity === "warning").length}</strong>
          <span>提示项</span>
        </div>
      </div>

      {orderGroups.length > 0 && (
        <section className="order-groups-card">
          <div className="order-groups-head">
            <div>
              <h3>出库单汇总</h3>
              <p>按外部编码聚合，同一出库单下可包含多条 SKU 明细。</p>
            </div>
            <span>{orderGroups.reduce((sum, group) => sum + group.totalQty, 0)} 件</span>
          </div>
          <div className="order-groups-table-wrap">
            <table className="order-groups-table">
              <thead>
                <tr>
                  <th>外部编码</th>
                  <th>收货信息</th>
                  <th>SKU 行</th>
                  <th>总数量</th>
                  <th>来源行</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {orderGroups.map((group) => (
                  <tr key={group.groupKey}>
                    <td>{group.externalCode || "未填写"}</td>
                    <td>{formatReceiver(group)}</td>
                    <td>{group.skuLineCount}</td>
                    <td>{group.totalQty}</td>
                    <td>{formatRowIndexes(group.rowIndexes)}</td>
                    <td>
                      <span className={group.hasReceiverConflict ? "group-badge danger" : "group-badge"}>
                        {group.hasReceiverConflict ? "收货冲突" : "可聚合"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <PreviewTable data={rows} existingExternalCodes={existingCodes} onChange={setRows} />
    </div>
  );
}

function formatReceiver(group: ReturnType<typeof aggregateOrders>[number]): string {
  if (group.receiverShop) return group.receiverShop;
  return [group.receiverName, group.receiverPhone, group.receiverAddress].filter(Boolean).join(" / ") || "未填写";
}

function formatRowIndexes(indexes: number[]): string {
  const rows = indexes.map((index) => index + 1).sort((a, b) => a - b);
  if (rows.length <= 5) return rows.join("、");
  return `${rows[0]}-${rows[rows.length - 1]} 等 ${rows.length} 行`;
}
