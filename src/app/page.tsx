"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Database,
  FileSpreadsheet,
  FileText,
  Loader2,
  Plus,
  Save,
  Sparkles,
  UploadCloud,
} from "lucide-react";
import type { FileStructure, ParseRule } from "@/lib/types";
import { getFileKind } from "@/lib/types";
import "./page.css";

type SavedRule = {
  id: string;
  ruleName: string;
  fileType: string;
  createdAt: string;
  updatedAt: string;
  config: ParseRule;
};

type GenerateRuleResponse = {
  success: boolean;
  rule?: ParseRule;
  structure?: FileStructure;
  aiFallback?: boolean;
  llm?: { baseURL: string; model: string };
  error?: string;
};

export default function Home() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [rules, setRules] = useState<SavedRule[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState("");
  const [draftRule, setDraftRule] = useState<ParseRule | null>(null);
  const [ruleText, setRuleText] = useState("");
  const [structure, setStructure] = useState<FileStructure | null>(null);
  const [loadingRules, setLoadingRules] = useState(true);
  const [working, setWorking] = useState<"generate" | "parse" | "save" | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState("");
  const [status, setStatus] = useState<{ type: "info" | "success" | "error"; text: string } | null>(null);
  const progressTimerRef = useRef<number | null>(null);

  const fileKind = file ? getFileKind(file.name) : null;
  const visibleRules = useMemo(
    () =>
      [...rules].sort((first, second) => new Date(second.updatedAt).getTime() - new Date(first.updatedAt).getTime()),
    [rules],
  );
  const selectedRule = rules.find((rule) => rule.id === selectedRuleId);
  const activeRule = draftRule ?? selectedRule?.config ?? null;

  useEffect(() => {
    void loadRules();
  }, []);

  useEffect(() => {
    return () => clearProgressTimer();
  }, []);

  async function loadRules() {
    setLoadingRules(true);
    try {
      const res = await fetch("/api/rules", { cache: "no-store" });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "规则加载失败");
      setRules(data.rules ?? []);
    } catch (error) {
      setStatus({
        type: "error",
        text: `规则列表读取失败：${error instanceof Error ? error.message : "未知错误"}`,
      });
    } finally {
      setLoadingRules(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    const nextFile = e.dataTransfer.files?.[0];
    if (nextFile) chooseFile(nextFile);
  }

  function chooseFile(nextFile: File) {
    const kind = getFileKind(nextFile.name);
    if (!kind) {
      setStatus({ type: "error", text: "文件格式不支持，请选择 Excel、Word 或 PDF 文件。" });
      return;
    }
    setFile(nextFile);
    setSelectedRuleId("");
    setDraftRule(null);
    setRuleText("");
    setStructure(null);
    setStatus({ type: "info", text: `已选择 ${nextFile.name}，请手动选择已有规则或生成新规则。` });
  }

  function clearFile() {
    setFile(null);
    setSelectedRuleId("");
    setDraftRule(null);
    setRuleText("");
    setStructure(null);
  }

  function syncRuleFromText(): ParseRule | null {
    try {
      const parsed = JSON.parse(ruleText) as ParseRule;
      if (!parsed.ruleName || !parsed.fileType || !parsed.mode) {
        throw new Error("规则必须包含 ruleName、fileType、mode");
      }
      setDraftRule(parsed);
      setStatus({ type: "success", text: "规则 JSON 校验通过，可保存或直接试解析。" });
      return parsed;
    } catch (error) {
      setStatus({ type: "error", text: `规则 JSON 无法解析：${error instanceof Error ? error.message : "格式错误"}` });
      return null;
    }
  }

  async function generateRule() {
    if (!file) {
      setStatus({ type: "error", text: "请先上传一个样例文件。" });
      return;
    }
    setWorking("generate");
    setProgress(8);
    setProgressMessage("正在准备上传样例文件...");
    try {
      const form = new FormData();
      form.append("file", file);
      startGenerateProgressLoop();
      const res = await fetch("/api/generate-rule", { method: "POST", body: form });
      clearProgressTimer();
      setProgress(88);
      setProgressMessage("已收到服务端响应，正在整理规则 JSON...");
      const data = (await res.json()) as GenerateRuleResponse;
      if (!data.success) throw new Error(data.error || "生成规则失败");
      if (!data.rule) throw new Error("大模型未返回可用规则");
      setDraftRule(data.rule);
      setRuleText(JSON.stringify(data.rule, null, 2));
      setStructure(data.structure ?? null);
      setProgress(100);
      setProgressMessage("规则已生成，可以在右侧确认、微调或试解析。");
      const modelText = data.llm?.model && data.llm?.baseURL ? `${data.llm.model} · ${data.llm.baseURL}` : "环境变量配置的模型";
      setStatus({
        type: data.aiFallback ? "info" : "success",
        text: data.aiFallback
          ? `LLM 接口 ${modelText} 暂不可用，已生成本地推荐规则，请人工确认。`
          : `LLM ${modelText} 已生成推荐规则，请确认后保存或试解析。`,
      });
    } catch (error) {
      setStatus({ type: "error", text: error instanceof Error ? error.message : "生成规则失败" });
    } finally {
      clearProgressTimer();
      window.setTimeout(() => {
        setWorking(null);
        setProgress(0);
        setProgressMessage("");
      }, 500);
    }
  }

  async function saveRule() {
    const rule = syncRuleFromText();
    if (!rule) return;
    setWorking("save");
    setProgress(45);
    setProgressMessage("正在保存规则到数据库...");
    try {
      const isUpdate = Boolean(rule.id);
      const res = await fetch(isUpdate ? `/api/rules/${rule.id}` : "/api/rules", {
        method: isUpdate ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "保存失败");
      await loadRules();
      setSelectedRuleId(data.rule.id);
      setDraftRule(data.rule.config);
      setRuleText(JSON.stringify(data.rule.config, null, 2));
      setStatus({ type: "success", text: "解析规则已保存到服务器。" });
      setProgress(100);
      setProgressMessage("规则保存完成。");
    } catch (error) {
      setStatus({ type: "error", text: error instanceof Error ? error.message : "保存规则失败" });
    } finally {
      window.setTimeout(() => {
        setWorking(null);
        setProgress(0);
        setProgressMessage("");
      }, 400);
    }
  }

  async function parseFile() {
    if (!file) {
      setStatus({ type: "error", text: "请先上传文件。" });
      return;
    }
    const rule = draftRule ? syncRuleFromText() : activeRule;
    if (!rule) {
      setStatus({ type: "error", text: "请先选择规则，或生成并确认一条新规则。" });
      return;
    }
    setWorking("parse");
    setProgress(8);
    setProgressMessage("正在准备解析文件...");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("rule", JSON.stringify(rule));
      startParseProgressLoop();
      const res = await fetch("/api/import-tasks", { method: "POST", body: form });
      clearProgressTimer();
      setProgress(88);
      setProgressMessage("任务已创建，正在打开进度页...");
      const data = await res.json() as { task_id?: string; error?: string };
      if (!res.ok || !data.task_id) throw new Error(data.error || "创建异步任务失败");
      setProgress(100);
      setProgressMessage("预览数据已准备完成。");
      setStatus({
        type: "success",
        text: "异步导入任务已创建，后台将按批次处理文件。",
      });
      window.setTimeout(() => router.push(`/imports/${data.task_id}`), 300);
    } catch (error) {
      setStatus({ type: "error", text: error instanceof Error ? error.message : "文件解析失败" });
    } finally {
      clearProgressTimer();
      window.setTimeout(() => {
        setWorking(null);
        setProgress(0);
        setProgressMessage("");
      }, 600);
    }
  }

  function clearProgressTimer() {
    if (progressTimerRef.current !== null) {
      window.clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }

  function startGenerateProgressLoop() {
    clearProgressTimer();
    const startedAt = Date.now();
    progressTimerRef.current = window.setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      const stage =
        elapsedMs < 1800
          ? { ceiling: 28, step: 4, message: "正在上传文件，并读取 Sheet / 文本结构..." }
          : elapsedMs < 4200
            ? { ceiling: 42, step: 3, message: "正在生成文件结构摘要和 AI 提示词..." }
            : elapsedMs < 22000
              ? { ceiling: 76, step: 2, message: "正在等待 AI 网关返回推荐规则，通常需要 10-30 秒..." }
              : { ceiling: 88, step: 1, message: "AI 网关响应偏慢，超过上限会自动降级为本地推荐规则..." };

      setProgressMessage(stage.message);
      setProgress((current) => (current >= stage.ceiling ? current : Math.min(stage.ceiling, current + stage.step)));
    }, 650);
  }

  function startParseProgressLoop() {
    clearProgressTimer();
    const startedAt = Date.now();
    progressTimerRef.current = window.setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      const stage =
        elapsedMs < 1600
          ? { ceiling: 35, step: 5, message: "正在上传文件并加载解析规则..." }
          : elapsedMs < 3600
            ? { ceiling: 68, step: 4, message: "正在执行规则引擎，抽取订单字段..." }
            : { ceiling: 86, step: 2, message: "正在校验数据并整理预览结果..." };

      setProgressMessage(stage.message);
      setProgress((current) => (current >= stage.ceiling ? current : Math.min(stage.ceiling, current + stage.step)));
    }, 500);
  }

  return (
    <div className="container import-page">
      <section className="summary-band">
        <div>
          <p className="eyebrow">Waybill / bulkTransshipmentOrders</p>
          <h2>批量转运下单 · 万能导入 V4</h2>
          <p>上传 Excel、Word 或 PDF，确认 V2 解析规则后创建异步任务；后台按批次完成校验、写入和全链路追踪。</p>
        </div>
        <div className="summary-metrics" aria-label="系统能力">
          <div>
            <strong>Excel / Word / PDF</strong>
            <span>文件格式</span>
          </div>
          <div>
            <strong>Env Model</strong>
            <span>LLM 生成规则</span>
          </div>
          <div>
            <strong>虚拟表格</strong>
            <span>1000+ 行预览</span>
          </div>
        </div>
      </section>

      {status && <div className={`notice ${status.type}`}>{status.text}</div>}

      {working && (
        <div className="progress-card">
          <div className="progress-label">
            <span>{working === "generate" ? "规则生成中" : working === "parse" ? "文件解析中" : "规则保存中"}</span>
            <strong>{progress}%</strong>
          </div>
          <div className="progress-track">
            <span style={{ width: `${progress}%` }} />
          </div>
          {progressMessage && <p className="progress-message">{progressMessage}</p>}
        </div>
      )}

      <div className="workflow-grid">
        <section className="card step-card">
          <div className="card-title">
            <span className="step-index">1</span>
            <div>
              <h3>上传出库单文件</h3>
              <p>支持拖拽上传和点击选择，不做自动规则匹配。</p>
            </div>
          </div>

          <div
            className={`upload-dropzone ${isDragging ? "dragging" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
          >
            <input
              type="file"
              id="file-upload"
              className="file-input"
              accept=".xlsx,.xls,.docx,.pdf"
              onChange={(e) => {
                const nextFile = e.target.files?.[0];
                if (nextFile) chooseFile(nextFile);
              }}
            />
            <label htmlFor="file-upload" className="upload-label">
              <UploadCloud size={42} className="upload-icon" />
              <strong>点击或拖拽文件到此处</strong>
              <span>Excel .xlsx/.xls、Word .docx、PDF</span>
            </label>
          </div>

          {file ? (
            <div className="file-info">
              <FileText className="file-info-icon" />
              <div className="file-details">
                <span className="file-name">{file.name}</span>
                <span className="file-size">{(file.size / 1024).toFixed(1)} KB · {fileKind?.toUpperCase()}</span>
              </div>
              <button className="text-button danger" onClick={clearFile}>移除</button>
            </div>
          ) : (
            <div className="empty-inline">
              <FileSpreadsheet size={18} />
              <span>请先上传一个考试附件或你自己的出库单样例。</span>
            </div>
          )}
        </section>

        <section className="card step-card">
          <div className="card-title">
            <span className="step-index">2</span>
            <div>
              <h3>手动选择或新建规则</h3>
              <p>题目要求不自动匹配，上传后由用户明确选择或确认新规则。</p>
            </div>
          </div>

          <div className="rule-list">
            {loadingRules ? (
              <div className="empty-inline"><Loader2 className="spin" size={18} /> 规则加载中</div>
            ) : visibleRules.length ? (
              visibleRules.map((rule) => {
                return (
                  <button
                    key={rule.id}
                    className={`rule-row ${selectedRuleId === rule.id && !draftRule ? "active" : ""}`}
                    onClick={() => {
                      setSelectedRuleId(rule.id);
                      setDraftRule(null);
                      setRuleText(JSON.stringify(rule.config, null, 2));
                      setStatus({
                        type: "info",
                        text: `已选择规则：${rule.ruleName}。规则来源类型为 ${rule.fileType.toUpperCase()}，可用当前文件试解析。`,
                      });
                    }}
                  >
                    <span>
                      <strong>{rule.ruleName}</strong>
                      <small>
                        来源 {rule.fileType.toUpperCase()} · {new Date(rule.updatedAt).toLocaleString()}
                      </small>
                    </span>
                    <CheckCircle2 size={18} />
                  </button>
                );
              })
            ) : (
              <div className="empty-inline">
                <ClipboardList size={18} />
                <span>暂无已保存规则，请上传样例并生成新规则。</span>
              </div>
            )}
          </div>

          <button className="outline-button" onClick={generateRule} disabled={!file || working !== null}>
            {working === "generate" ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
            新建规则并由 AI 生成
          </button>
        </section>
      </div>

      <section className="card rule-editor-card">
        <div className="card-title">
          <span className="step-index">3</span>
          <div>
            <h3>确认规则并试解析</h3>
            <p>AI 推测字段会写在 notes 中，保存前可直接调整 JSON 并用当前文件预览。</p>
          </div>
        </div>

        <div className="editor-grid">
          <div className="json-editor-wrap">
            <div className="editor-toolbar">
              <span>规则 JSON</span>
              <button className="text-button" onClick={() => activeRule && setRuleText(JSON.stringify(activeRule, null, 2))}>
                恢复当前规则
              </button>
            </div>
            <textarea
              className="json-editor"
              value={ruleText}
              onChange={(e) => {
                setRuleText(e.target.value);
                setDraftRule(null);
              }}
              placeholder="选择已有规则，或点击“新建规则并由 AI 生成”。"
              spellCheck={false}
            />
          </div>

          <aside className="rule-side-panel">
            <div className="panel-block">
              <h4>当前文件结构</h4>
              {structure?.sheets?.length ? (
                <ul className="structure-list">
                  {structure.sheets.map((sheet) => (
                    <li key={sheet.name}>
                      <strong>{sheet.name}</strong>
                      <span>{sheet.rowCount} 行 · {sheet.colCount} 列</span>
                    </li>
                  ))}
                </ul>
              ) : structure?.text ? (
                <p className="muted">已抽取文本 {structure.text.length} 字符。</p>
              ) : (
                <p className="muted">生成规则后会展示样例结构。</p>
              )}
            </div>

            <div className="panel-block">
              <h4>确认动作</h4>
              <div className="action-stack">
                <button className="secondary-button" onClick={() => syncRuleFromText()} disabled={!ruleText.trim()}>
                  <CheckCircle2 size={16} />
                  校验 JSON
                </button>
                <button className="secondary-button" onClick={saveRule} disabled={!ruleText.trim() || working !== null}>
                  {working === "save" ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
                  保存规则
                </button>
                <button className="primary-button" onClick={parseFile} disabled={!file || !ruleText.trim() || working !== null}>
                  {working === "parse" ? <Loader2 className="spin" size={16} /> : <ArrowRight size={16} />}
                  创建异步导入任务
                </button>
              </div>
            </div>
          </aside>
        </div>
      </section>

      <section className="capability-row">
        <div>
          <Database size={18} />
          <span>规则和提交后的运单会写入 Neon/Prisma 数据库。</span>
        </div>
        <div>
          <Plus size={18} />
          <span>新增格式只保存新规则，解析代码保持不变。</span>
        </div>
      </section>
    </div>
  );
}
