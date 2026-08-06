"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  Boxes,
  ChevronDown,
  ClipboardList,
  Database,
  FileCog,
  Home,
  LayoutDashboard,
  Menu,
  Search,
  UploadCloud,
  UserRound,
} from "lucide-react";
import type { ReactNode } from "react";

const navItems = [
  { href: "/", label: "批量转运下单", icon: UploadCloud },
  { href: "/rules", label: "解析规则配置", icon: FileCog },
  { href: "/orders", label: "已导入运单", icon: ClipboardList },
  { href: "/import-monitor", label: "导入监控看板", icon: LayoutDashboard },
];

const tabLabels: Record<string, string> = {
  "/": "批量转运下单",
  "/rules": "解析规则配置",
  "/preview": "导入数据预览",
  "/orders": "已导入运单",
  "/import-monitor": "导入监控看板",
};

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const currentTab = tabLabels[pathname] ?? "万能导入";

  return (
    <div className="jt-shell">
      <header className="jt-topbar">
        <div className="jt-brand">
          <span className="jt-brand-mark">JT</span>
          <span>中通冷链-鲸天系统</span>
        </div>
        <div className="jt-top-search">
          <Search size={15} />
          <span>搜索菜单 / 运单 / 规则</span>
        </div>
        <div className="jt-top-actions">
          <button className="jt-icon-button" aria-label="系统消息" title="系统消息">
            <Bell size={16} />
          </button>
          <button className="jt-user-button" type="button">
            <UserRound size={16} />
            <span>考试账号</span>
            <ChevronDown size={14} />
          </button>
        </div>
      </header>

      <aside className="jt-sidebar">
        <div className="jt-sidebar-title">
          <Menu size={16} />
          <span>业务工作台</span>
        </div>
        <div className="jt-menu-group">
          <div className="jt-menu-heading">
            <Boxes size={15} />
            <span>运单管理</span>
          </div>
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = item.href === "/" ? pathname === "/" || pathname === "/preview" : pathname === item.href;
            return (
              <Link key={item.href} href={item.href} className={`jt-menu-item ${active ? "active" : ""}`}>
                <Icon size={16} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
        <div className="jt-menu-group muted">
          <div className="jt-menu-heading">
            <Database size={15} />
            <span>系统能力</span>
          </div>
          <span className="jt-menu-note">LLM 规则生成</span>
          <span className="jt-menu-note">多格式解析引擎</span>
          <span className="jt-menu-note">Neon 数据持久化</span>
        </div>
      </aside>

      <div className="jt-workspace">
        <div className="jt-tabs">
          <Link href="/" className="jt-home-link" aria-label="首页" title="首页">
            <Home size={15} />
          </Link>
          <span className="jt-tab active">{currentTab}</span>
        </div>
        <div className="jt-subbar">
          <div className="jt-breadcrumb">
            <LayoutDashboard size={15} />
            <span>鲸天系统</span>
            <span>/</span>
            <strong>{currentTab}</strong>
          </div>
          <span className="jt-subbar-status">主色 #0fc6c2 · 规则引擎 · AI 辅助生成</span>
        </div>
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}
