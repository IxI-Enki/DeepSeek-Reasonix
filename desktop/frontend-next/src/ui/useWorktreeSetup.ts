import { useEffect, useRef, useState } from "react";
import type { AgentPort, WorkspaceGit } from "../port/port";
import type { WorktreeSelection, WorktreeSources } from "../port/workspace";

export function useWorktreeSetup(port: AgentPort, fresh: boolean, root: string, onChanged: () => void, onTreeChanged?: (git: WorkspaceGit) => void) {
  const [sources, setSources] = useState<WorktreeSources | null>(null);
  const [selection, setSelection] = useState<WorktreeSelection | null>(null);
  const prepared = useRef(false);
  useEffect(() => {
    let live = true;
    setSources(null);
    setSelection(null);
    prepared.current = false;
    if (fresh) void port.worktreeSources().then((value) => {
      if (live) setSources(value);
    }).catch(() => { if (live) setSources(null); });
    return () => { live = false; };
  }, [port, fresh, root]);

  const refresh = async () => {
    const value = await port.worktreeSources();
    setSources(value);
    return value;
  };
  const prepare = async (attachments: string[]) => {
    if (!selection || prepared.current) return;
    try {
      await port.isolateWorkspace(attachments.length ? { ...selection, attachments } : selection);
    } catch (error) {
      const current = await port.status().catch(() => null);
      if (current?.workspaceRoot && current.workspaceRoot !== selection.sourceRoot) {
        prepared.current = true;
        setSelection(null);
        setSources(null);
        onChanged();
        void port.workspaceGit().then(onTreeChanged).catch(() => {});
      }
      throw error;
    }
    prepared.current = true;
    setSelection(null);
    setSources(null);
    onChanged();
    void port.workspaceGit().then(onTreeChanged).catch(() => {});
  };
  return { sources, selection, setSelection, refresh, prepare };
}
