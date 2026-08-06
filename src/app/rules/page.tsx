"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Edit2, Loader2, Plus, Save, Settings, Trash2 } from "lucide-react";
import type { ParseRule } from "@/lib/types";

type SavedRule = {
  id: string;
  ruleName: string;
  fileType: string;
  createdAt: string;
  updatedAt: string;
  config: ParseRule;
};

export default function RulesPage() {
  const [rules, setRules] = useState<SavedRule[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [editorText, setEditorText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);
  const initializedRef = useRef(false);

  const selectedRule = useMemo(() => rules.find((rule) => rule.id === selectedId), [rules, selectedId]);

  useEffect(() => {
    let cancelled = false;

    async function loadInitialRules() {
      await Promise.resolve();
      try {
        const res = await fetch("/api/rules", { cache: "no-store" });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "规则加载失败");
        if (!cancelled) {
          setRules(data.rules ?? []);
          if (!initializedRef.current && data.rules?.[0]) {
            initializedRef.current = true;
            setSelectedId(data.rules[0].id);
            setEditorText(JSON.stringify(data.rules[0].config, null, 2));
          }
        }
      } catch (error) {
        if (!cancelled) {
          setNotice({ type: "error", text: error instanceof Error ? error.message : "规则加载失败" });
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadInitialRules();

    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshRules() {
    try {
      const res = await fetch("/api/rules", { cache: "no-store" });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "规则加载失败");
      setRules(data.rules ?? []);
      if (!initializedRef.current && data.rules?.[0]) {
        initializedRef.current = true;
        setSelectedId(data.rules[0].id);
        setEditorText(JSON.stringify(data.rules[0].config, null, 2));
      }
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "规则加载失败" });
    } finally {
      setLoading(false);
    }
  }

  function selectRule(rule: SavedRule) {
    setSelectedId(rule.id);
    setEditorText(JSON.stringify(rule.config, null, 2));
    setNotice(null);
  }

  async function saveRule() {
    if (!selectedRule) {
      setNotice({ type: "error", text: "请选择要编辑的规则。" });
      return;
    }
    let parsed: ParseRule;
    try {
      parsed = JSON.parse(editorText) as ParseRule;
      if (!parsed.ruleName || !parsed.fileType || !parsed.mode) {
        throw new Error("规则必须包含 ruleName、fileType、mode");
      }
    } catch (error) {
      setNotice({ type: "error", text: `JSON 格式错误：${error instanceof Error ? error.message : "无法解析"}` });
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/rules/${selectedRule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule: { ...parsed, id: selectedRule.id } }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "保存失败");
      setNotice({ type: "success", text: "规则已更新。" });
      await refreshRules();
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  }

  async function copyRule(rule: SavedRule) {
    const nextRule: ParseRule = {
      ...rule.config,
      id: undefined,
      ruleName: `${rule.ruleName} 副本`,
    };
    try {
      const res = await fetch("/api/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule: nextRule }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "复制失败");
      setNotice({ type: "success", text: "规则副本已创建。" });
      await refreshRules();
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "复制失败" });
    }
  }

  async function deleteRule(rule: SavedRule) {
    const confirmed = window.confirm(`确认删除规则“${rule.ruleName}”？`);
    if (!confirmed) return;
    try {
      const res = await fetch(`/api/rules/${rule.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "删除失败");
      setNotice({ type: "success", text: "规则已删除。" });
      setSelectedId("");
      setEditorText("");
      await refreshRules();
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "删除失败" });
    }
  }

  async function createBlankRule() {
    const nextRule: ParseRule = {
      ruleName: `手动规则-${new Date().toLocaleString()}`,
      fileType: "excel",
      mode: "table",
      sheetMode: "first",
      table: {
        headerRow: 0,
        dataStartRow: 1,
        skipBlankRows: true,
        stopWhenFirstCellMatches: "^(合计|总计|小计)",
        skipWhenFirstCellMatches: "^(合计|总计|小计)",
        fieldMappings: {},
        contextMappings: {},
      },
      notes: [
        {
          message: "手动创建的空白规则，请补充字段映射后保存；也可回到导入页上传样例后由 AI 生成推荐规则。",
          confidence: "low",
        },
      ],
    };

    setSaving(true);
    try {
      const res = await fetch("/api/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule: nextRule }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "新建失败");
      setNotice({ type: "success", text: "空白规则已创建，请在右侧补充字段映射。" });
      await refreshRules();
      setSelectedId(data.rule.id);
      setEditorText(JSON.stringify(data.rule.config, null, 2));
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "新建规则失败" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="container rules-page">
      <div className="page-heading">
        <div>
          <h2>解析规则配置</h2>
          <p>规则保存在服务器端，可新建、复制、编辑、删除；上传页仍可基于样例文件由 AI 生成推荐规则。</p>
        </div>
        <div className="heading-actions">
          <button className="primary-button" onClick={createBlankRule} disabled={saving}>
            {saving ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}
            新建规则
          </button>
        </div>
      </div>

      {notice && <div className={`notice ${notice.type}`}>{notice.text}</div>}

      <div className="rules-layout">
        <section className="card rules-list-card">
          <div className="section-title">
            <Settings size={18} />
            <h3>规则列表</h3>
          </div>
          {loading ? (
            <div className="centered-state compact">
              <Loader2 className="spin" size={20} />
              <p>加载中...</p>
            </div>
          ) : rules.length ? (
            <div className="rule-list management">
              {rules.map((rule) => (
                <button
                  key={rule.id}
                  className={`rule-row ${selectedId === rule.id ? "active" : ""}`}
                  onClick={() => selectRule(rule)}
                >
                  <span>
                    <strong>{rule.ruleName}</strong>
                    <small>{rule.fileType.toUpperCase()} · {new Date(rule.updatedAt).toLocaleString()}</small>
                  </span>
                  <Edit2 size={16} />
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-panel">暂无规则。可直接新建空白规则，或回到导入页上传样例并由 AI 生成。</div>
          )}
        </section>

        <section className="card rule-editor-card rules-editor">
          <div className="editor-toolbar">
            <span>{selectedRule ? selectedRule.ruleName : "未选择规则"}</span>
            <div className="inline-actions">
              <button className="secondary-button" disabled={!selectedRule} onClick={() => selectedRule && copyRule(selectedRule)}>
                <Copy size={16} />
                复制
              </button>
              <button className="secondary-button danger" disabled={!selectedRule} onClick={() => selectedRule && deleteRule(selectedRule)}>
                <Trash2 size={16} />
                删除
              </button>
              <button className="primary-button" disabled={!selectedRule || saving} onClick={saveRule}>
                {saving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
                保存修改
              </button>
            </div>
          </div>
          <textarea
            className="json-editor large"
            value={editorText}
            onChange={(event) => setEditorText(event.target.value)}
            placeholder="选择左侧规则后编辑 JSON。"
            spellCheck={false}
          />
        </section>
      </div>
    </div>
  );
}
