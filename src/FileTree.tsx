import { useEffect, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { entryName } from './fileOps';

type Entry = { name: string; path: string; directory: boolean };

export default function FileTree({ root, active, tick, onOpen, onOpenSide, onSelectDirectory, onRenamed, onDeleted, report }: {
  root: string;
  active: string;
  tick: number;
  onOpen: (path: string) => void;
  onOpenSide: (path: string) => void;
  onSelectDirectory: (path: string) => void;
  onRenamed: (from: string, to: string) => void;
  onDeleted: (path: string) => void;
  report: (error: unknown) => void;
}) {
  const [children, setChildren] = useState<Record<string, Entry[]>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState(root);
  const openRef = useRef(open);
  openRef.current = open;
  const reportRef = useRef(report);
  reportRef.current = report;

  useEffect(() => {
    let dead = false;
    setOpen(current => current[root] ? current : { ...current, [root]: true });
    setSelected(root);
    const paths = Object.keys(openRef.current).filter(path => openRef.current[path]);
    if (!paths.includes(root)) paths.unshift(root);
    void Promise.all(paths.map(async path => {
      try {
        return [path, await invoke<Entry[]>('list_directory', { path })] as const;
      } catch (error) {
        reportRef.current(error);
        return [path, [] as Entry[]] as const;
      }
    })).then(rows => { if (!dead) setChildren(Object.fromEntries(rows)); });
    return () => { dead = true; };
  }, [root, tick]);

  async function refresh(path: string) {
    const entries = await invoke<Entry[]>('list_directory', { path });
    setChildren(current => ({ ...current, [path]: entries }));
  }
  function parentOf(path: string) {
    const parent = path.replace(/[\\/][^\\/]+$/, '');
    return parent && parent !== path ? parent : root;
  }
  function selectedDirectory() {
    if (selected === root) return root;
    const entry = (children[parentOf(selected)] ?? []).find(item => item.path === selected);
    return entry?.directory ? selected : parentOf(selected);
  }
  async function createFolder() {
    const folder = selectedDirectory();
    const entered = window.prompt('New folder name');
    if (entered === null) return;
    const name = entryName(entered);
    if (!name) {
      report('Use a single folder name.');
      return;
    }
    try {
      await invoke('create_directory', { parent: folder, name });
      setOpen(current => ({ ...current, [folder]: true }));
      await refresh(folder);
      onSelectDirectory(folder);
    } catch (error) { report(error); }
  }
  async function rename(move: boolean) {
    if (selected === root) {
      report('The project root stays.');
      return;
    }
    const currentName = selected.split(/[\\/]/).pop() ?? selected;
    const entered = move ? currentName : window.prompt('New name', currentName);
    if (entered === null) return;
    const name = entryName(entered);
    if (!name) {
      report('Use a single file or folder name.');
      return;
    }
    const destDir = move ? window.prompt('Move into this folder. Paste a folder path inside the project.', parentOf(selected)) : parentOf(selected);
    if (!destDir) return;
    try {
      const next = await invoke<string>('rename_path', { from: selected, destDir, name });
      onRenamed(selected, next);
      setSelected(next);
      await refresh(parentOf(selected));
      await refresh(destDir);
    } catch (error) { report(error); }
  }
  async function remove() {
    if (selected === root) {
      report('The project root stays.');
      return;
    }
    if (!window.confirm(`Delete ${selected}? This is not saved in local history.`)) return;
    try {
      await invoke('delete_path', { path: selected });
      onDeleted(selected);
      const parent = parentOf(selected);
      setSelected(parent);
      await refresh(parent);
    } catch (error) { report(error); }
  }

  function rows(path: string, depth: number): ReactNode {
    return (children[path] ?? []).map(entry => (
      <div key={entry.path}>
        <div className="file-row" style={{ paddingLeft: depth * 12 }}>
          <button className={`file-item ${active === entry.path || selected === entry.path ? 'active' : ''}`} aria-label={`${entry.directory ? 'Folder' : 'File'}: ${entry.name}`} aria-current={active === entry.path ? 'true' : undefined} title={entry.path} onClick={() => {
            setSelected(entry.path);
            if (entry.directory) {
              setOpen(current => ({ ...current, [entry.path]: !current[entry.path] }));
              if (!children[entry.path]) void refresh(entry.path).catch(report);
              onSelectDirectory(entry.path);
            } else onOpen(entry.path);
          }}>{entry.directory ? (open[entry.path] ? '▾' : '▸') : '·'} {entry.name}</button>
        </div>
        {entry.directory && open[entry.path] ? rows(entry.path, depth + 1) : null}
      </div>
    ));
  }

  return <div className="file-tree">
    <div className="file-actions">
      <button onClick={() => void createFolder()}>New folder</button>
      <button onClick={() => void rename(false)}>Rename</button>
      <button onClick={() => void rename(true)}>Move</button>
      <button onClick={() => void remove()}>Delete</button>
      <button onClick={() => { if (selected !== root) onOpenSide(selected); }}>Open to the side</button>
    </div>
    <button className={`file-item ${selected === root ? 'active' : ''}`} onClick={() => { setSelected(root); setOpen(current => ({ ...current, [root]: true })); onSelectDirectory(root); }}>{root.split(/[\\/]/).pop()}</button>
    {rows(root, 1)}
  </div>;
}
