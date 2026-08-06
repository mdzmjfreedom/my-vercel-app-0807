"use client";

import React, { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Plus, Trash2 } from "lucide-react";
import type { OrderField, ParsedOrder, ValidationIssue } from "@/lib/types";
import { ORDER_FIELDS, validateOrders } from "@/lib/types";
import "./PreviewTable.css";

interface PreviewTableProps {
  data: ParsedOrder[];
  existingExternalCodes?: string[];
  onChange: (data: ParsedOrder[]) => void;
}

const editableFields = ORDER_FIELDS.map((field) => field.key);

export default function PreviewTable({ data, existingExternalCodes = [], onChange }: PreviewTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const issues = useMemo(
    () => validateOrders(data, existingExternalCodes),
    [data, existingExternalCodes],
  );

  const issuesByRow = useMemo(() => {
    const grouped = new Map<number, ValidationIssue[]>();
    issues.forEach((issue) => {
      grouped.set(issue.rowIndex, [...(grouped.get(issue.rowIndex) ?? []), issue]);
    });
    return grouped;
  }, [issues]);

  const issuesByCell = useMemo(() => {
    const grouped = new Map<string, ValidationIssue[]>();
    issues.forEach((issue) => {
      grouped.set(`${issue.rowIndex}:${issue.field}`, [...(grouped.get(`${issue.rowIndex}:${issue.field}`) ?? []), issue]);
    });
    return grouped;
  }, [issues]);

  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: data.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 46,
    overscan: 12,
  });

  function updateCell(index: number, field: OrderField, value: string) {
    const next = [...data];
    next[index] = {
      ...next[index],
      [field]: field === "qty" ? Number(value) : value,
    };
    onChange(next);
  }

  function removeRow(index: number) {
    const next = [...data];
    next.splice(index, 1);
    onChange(next);
  }

  function addRow() {
    onChange([
      ...data,
      {
        id: `manual-${Date.now()}`,
        externalCode: "",
        receiverShop: "",
        receiverName: "",
        receiverPhone: "",
        receiverAddress: "",
        skuCode: "",
        skuName: "",
        qty: 1,
        skuSpec: "",
        remark: "",
      },
    ]);
  }

  return (
    <div className="preview-container">
      <div className="toolbar">
        <div className="stats">
          共 <strong>{data.length}</strong> 行
          <span>{issues.filter((issue) => issue.severity === "error").length} 个错误</span>
          <span>{issues.filter((issue) => issue.severity === "warning").length} 个提示</span>
        </div>
        <button className="btn-secondary" onClick={addRow}>
          <Plus size={16} /> 新增空行
        </button>
      </div>

      <div className="table-wrapper" ref={parentRef}>
        <div className="table-inner" style={{ height: `${rowVirtualizer.getTotalSize() + 44}px` }}>
          <div className="table-header">
            <div className="th col-action">操作</div>
            <div className="th col-code">外部编码</div>
            <div className="th col-shop">收货门店</div>
            <div className="th col-name">收件人</div>
            <div className="th col-phone">电话</div>
            <div className="th col-addr">地址</div>
            <div className="th col-sku-code required">SKU编码</div>
            <div className="th col-sku-name required">SKU名称</div>
            <div className="th col-qty required">数量</div>
            <div className="th col-spec">规格</div>
            <div className="th col-remark">备注</div>
            <div className="th col-errors">状态</div>
          </div>

          <div className="virtual-rows" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = data[virtualRow.index];
              const rowIssues = issuesByRow.get(virtualRow.index) ?? [];
              const hasErrors = rowIssues.some((issue) => issue.severity === "error");
              const hasWarnings = rowIssues.some((issue) => issue.severity === "warning");

              return (
                <div
                  key={row.id || virtualRow.key}
                  className={`table-row ${hasErrors ? "has-error" : ""} ${hasWarnings ? "has-warning" : ""}`}
                  style={{
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <div className="td col-action">
                    <button
                      onClick={() => removeRow(virtualRow.index)}
                      className="btn-icon danger"
                      aria-label="删除行"
                      title="删除行"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                  {editableFields.map((field) => {
                    const cellIssues = [
                      ...(issuesByCell.get(`${virtualRow.index}:${field}`) ?? []),
                      ...(field === "externalCode" ? issuesByCell.get(`${virtualRow.index}:row`) ?? [] : []),
                    ];
                    const className = cellIssues.some((issue) => issue.severity === "error")
                      ? "input-error"
                      : cellIssues.length
                        ? "input-warning"
                        : "";
                    const colClass = columnClass(field);
                    return (
                      <div className={`td ${colClass}`} key={field}>
                        <input
                          className={className}
                          type={field === "qty" ? "number" : "text"}
                          value={String(row[field] ?? "")}
                          title={cellIssues.map((issue) => issue.message).join("\n")}
                          onChange={(event) => updateCell(virtualRow.index, field, event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              (event.currentTarget.parentElement?.nextElementSibling?.querySelector("input") as HTMLInputElement | null)?.focus();
                            }
                          }}
                        />
                      </div>
                    );
                  })}
                  <div className="td col-errors">
                    {rowIssues.length ? (
                      <span className={hasErrors ? "error-text" : "warning-text"} title={rowIssues.map((issue) => issue.message).join("\n")}>
                        {hasErrors ? "需修正" : "可提交"} · {rowIssues.length}
                      </span>
                    ) : (
                      <span className="success-text">正常</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="error-panel">
        {issues.length ? (
          issues.map((issue, index) => (
            <span key={`${issue.rowIndex}-${issue.field}-${index}`} className={issue.severity}>
              {issue.message}
            </span>
          ))
        ) : (
          <span className="ok">当前没有校验问题，可以提交下单。</span>
        )}
      </div>
    </div>
  );
}

function columnClass(field: OrderField): string {
  const map: Record<OrderField, string> = {
    externalCode: "col-code",
    receiverShop: "col-shop",
    receiverName: "col-name",
    receiverPhone: "col-phone",
    receiverAddress: "col-addr",
    skuCode: "col-sku-code",
    skuName: "col-sku-name",
    qty: "col-qty",
    skuSpec: "col-spec",
    remark: "col-remark",
  };
  return map[field];
}
