import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";
import type { WorktreeSelection, WorktreeSources } from "../port/workspace";
import { StudioIcon } from "./StudioIcon";
import { Switch } from "./Switch";
import { listenAction } from "./listen";
import { beside, pinToViewport, useFollow, zoom } from "./place";
import "../styles/worktree.css";

interface Props {
  sources: WorktreeSources;
  selection: WorktreeSelection | null;
  branch: string;
  busy: boolean;
  changeCount: number;
  onSelect: (selection: WorktreeSelection | null) => void;
  refresh: () => Promise<WorktreeSources>;
}

export function WorktreeChip({ sources, selection, branch, busy, changeCount, onSelect, refresh }: Props) {
  const [open, setOpen] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const title = useId();
  const chosen = sources.sources.find((source) => source.ref === selection?.ref);
  const label = chosen?.name ?? selection?.ref ?? branch;
  const close = () => { setOpen(false); setChoosing(false); setQuery(""); trigger.current?.focus(); };
  const put = useCallback(() => {
    if (!trigger.current || !panel.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const height = panel.current.offsetHeight * zoom();
    pinToViewport(panel.current, anchor.left, beside(anchor, height, innerHeight, "above", 10), 12);
  }, []);
  useFollow(open, put, `${choosing}:${query}:${error}:${!!selection}`);
  useEffect(() => {
    if (!open) return;
    if (choosing) search.current?.focus();
    else panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (choosing) { setChoosing(false); setQuery(""); } else close();
      }
      if (event.key !== "Tab") return;
      const stops = Array.from(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input") ?? []);
      const edge = event.shiftKey ? stops[0] : stops.at(-1);
      if (document.activeElement === edge) {
        event.preventDefault();
        (event.shiftKey ? stops.at(-1) : stops[0])?.focus();
      }
    };
    const stopOutside = listenAction(window, "mousedown", { action: "workspace.configure", listener: outside as EventListener });
    const stopKey = listenAction(window, "keydown", { action: "workspace.configure", listener: key as EventListener }, true);
    return () => { stopOutside(); stopKey(); };
  }, [open, choosing]);
  useEffect(() => { if (busy) setOpen(false); }, [busy]);

  const show = () => {
    if (open) { close(); return; }
    setOpen(true);
    setError(false);
    void refresh().catch(() => setError(true));
  };
  const toggle = () => onSelect(selection ? null : {
    sourceRoot: sources.sourceRoot,
    ref: sources.sources.find((source) => source.current)?.ref ?? "HEAD",
  });
  const shown = sources.sources.filter((source) => source.name.toLowerCase().includes(query.toLowerCase()));
  return <div className="studio-branch-pop">
    <button ref={trigger} type="button" className="mode plain studio-branch worktree-trigger" data-on={selection ? "" : undefined} data-action="workspace.configure" aria-label={t("配置工作目录")} aria-haspopup="dialog" aria-expanded={open} disabled={busy} onClick={show}>
      <StudioIcon name="branch" /><span className="lb">{selection ? t("独立 worktree · {branch}", { branch: label }) : t("当前目录 · {branch}", { branch })}</span>{changeCount > 0 && <small>{t("{n} 个变更", { n: changeCount })}</small>}<StudioIcon name="down" />
    </button>
    {open && createPortal(<div ref={panel} className="worktree-panel composer-menu" role="dialog" aria-labelledby={title}>
      <div className="worktree-heading" id={title}>{choosing ? t("选择起始分支") : t("配置工作目录")}</div>
      {error ? <p role="alert">{t("分支读取失败，请关闭后重试")}</p> : choosing ? <>
        <input data-action-change="workspace.source-search" data-action-keydown="workspace.source-navigate" ref={search} type="search" aria-label={t("搜索分支")} placeholder={t("搜索分支…")} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); panel.current?.querySelector<HTMLElement>('[role="option"]')?.focus(); }
        }} />
        <div data-action="workspace.source-navigate" className="worktree-sources" role="listbox" aria-label={t("起始分支")} onKeyDown={(event) => {
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
          const at = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "ArrowDown" ? at + 1 : event.key === "ArrowUp" ? at - 1 : at;
          if (next !== at) { event.preventDefault(); items[(next + items.length) % items.length]?.focus(); }
        }}>
          {[false, true].map((remote) => <div key={String(remote)}>
            {shown.some((source) => source.remote === remote) && <small>{remote ? t("远程分支") : t("本地分支")}</small>}
            {shown.filter((source) => source.remote === remote).map((source) => <button data-action="workspace.source-select" key={source.ref} type="button" role="option" aria-selected={selection?.ref === source.ref} onClick={() => {
              onSelect({ ref: source.ref, sourceRoot: sources.sourceRoot }); setChoosing(false); setQuery("");
            }}><span>{source.name}</span>{source.current && <small>{t("当前分支")}</small>}{selection?.ref === source.ref && <StudioIcon name="check" />}</button>)}
          </div>)}
          {shown.length === 0 && <p>{t("没有匹配的分支")}</p>}
        </div>
        <button data-action="workspace.source-open" className="worktree-back" onClick={() => setChoosing(false)}>{t("返回")}</button>
      </> : <>
        <div className="worktree-toggle"><StudioIcon name="expand" /><div><span>{t("新建 worktree")}</span><small>{t("为此会话创建独立的代码目录")}</small></div><Switch data-action="workspace.worktree-toggle" on={!!selection} busy={busy || !sources.available} label={t("新建 worktree")} onClick={toggle} /></div>
        {selection ? <>
          <button data-action="workspace.source-open" className="worktree-row" onClick={() => setChoosing(true)}><StudioIcon name="branch" /><span>{t("起始分支")}</span><span className="worktree-value">{label}</span><StudioIcon name="chevron" /></button>
          <div className="worktree-row"><StudioIcon name="branch" /><span>{t("任务分支")}</span><span className="worktree-value">{t("自动创建")}</span></div>
          <p className="worktree-note">{t("基于所选分支的已提交版本创建，不包含未提交修改")}</p>
        </> : <p className="worktree-note">{t("使用当前目录，与该目录中的其他会话共享文件")}</p>}
      </>}
    </div>, document.body)}
  </div>;
}
