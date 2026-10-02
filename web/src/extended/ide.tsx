/**
 * "Open in IDE": every engineer picks their IDE in the report settings (⚙); the choice is stored
 * in the browser. Two ways to open a file:
 *  - URL scheme (vscode://, idea://, webstorm://...): needs the path of the local clone;
 *  - through the local agent (`pw-extended-report agent`): runs the IDE's command-line launcher,
 *    works for any IDE incl. GigaIDE, the agent resolves the file in the repository itself.
 */

import * as React from 'react';
import { extendedTabs } from './extendedTabs';
import { texts } from './i18n';

type IdeSettings = { ide: string, repoPath: string, template: string };

type Preset = { id: string, label: string, url?: string, agentIde?: string };

const kPresets: Preset[] = [
  { id: 'vscode', label: 'VS Code', url: 'vscode://file/{path}:{line}:{column}' },
  { id: 'cursor', label: 'Cursor', url: 'cursor://file/{path}:{line}:{column}' },
  { id: 'idea', label: 'IntelliJ IDEA', url: 'idea://open?file={path}&line={line}' },
  { id: 'webstorm', label: 'WebStorm', url: 'webstorm://open?file={path}&line={line}' },
  { id: 'pycharm', label: 'PyCharm', url: 'pycharm://open?file={path}&line={line}' },
  { id: 'agent:idea', label: 'IntelliJ IDEA', agentIde: 'idea' },
  { id: 'agent:webstorm', label: 'WebStorm', agentIde: 'webstorm' },
  { id: 'agent:gigaide', label: 'GigaIDE', agentIde: 'gigaide' },
  { id: 'agent:pycharm', label: 'PyCharm', agentIde: 'pycharm' },
  { id: 'agent:vscode', label: 'VS Code', agentIde: 'vscode' },
  { id: 'agent:cursor', label: 'Cursor', agentIde: 'cursor' },
  { id: 'custom', label: 'custom' },
];

const kStorageKey = 'pw-extended-report.ide';

function loadSettings(): IdeSettings {
  try {
    return { ide: '', repoPath: '', template: '', ...JSON.parse(localStorage.getItem(kStorageKey) || '{}') };
  } catch {
    return { ide: '', repoPath: '', template: '' };
  }
}

const listeners = new Set<() => void>();
let current: IdeSettings | undefined;

function settings(): IdeSettings {
  if (!current)
    current = loadSettings();
  return current;
}

function saveSettings(next: IdeSettings) {
  current = next;
  try {
    localStorage.setItem(kStorageKey, JSON.stringify(next));
  } catch {
  }
  listeners.forEach(l => l());
}

function useIdeSettings(): IdeSettings {
  return React.useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, settings);
}

/** Playwright rootDir inside the repository: report file paths are relative to it. */
function rootDirInRepo(): string {
  const tab = extendedTabs().find(t => t.format === 'insights');
  try {
    return tab ? (JSON.parse(tab.content).paths?.rootDirInRepo ?? '') : '';
  } catch {
    return '';
  }
}

function repoRelative(file: string): string {
  const root = rootDirInRepo();
  return root ? `${root.replace(/\/$/, '')}/${file}` : file;
}

export const IdeSettingsView: React.FC = () => {
  const s = useIdeSettings();
  const t = texts();
  const preset = kPresets.find(p => p.id === s.ide);
  const needsPath = !!preset?.url || s.ide === 'custom';
  return <div className='ide-settings' data-testid='ide-settings'>
    <label className='header-setting-theme'>
      {t.ideSettings}:
      <select value={s.ide} onChange={e => saveSettings({ ...s, ide: e.target.value })} data-testid='ide-select'>
        <option value=''>{t.ideNone}</option>
        <optgroup label='URL'>
          {kPresets.filter(p => p.url).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </optgroup>
        <optgroup label={t.ideViaAgent}>
          {kPresets.filter(p => p.agentIde).map(p => <option key={p.id} value={p.id}>{p.label} ({t.ideViaAgent})</option>)}
        </optgroup>
        <option value='custom'>{t.ideCustom}</option>
      </select>
    </label>
    {needsPath && <label className='header-setting-theme'>
      {t.ideRepoPath}:
      <input value={s.repoPath} placeholder='/Users/me/projects/autotests' onChange={e => saveSettings({ ...s, repoPath: e.target.value })} data-testid='ide-repo-path' />
    </label>}
    {s.ide === 'custom' && <label className='header-setting-theme' title={t.ideCustomHint}>
      {t.ideCustom}:
      <input value={s.template} placeholder='jetbrains://idea/navigate/reference?project=autotests&path={relative}:{line}' onChange={e => saveSettings({ ...s, template: e.target.value })} />
    </label>}
  </div>;
};

export const OpenInIdeButton: React.FC<{ file: string, line: number, column?: number, compact?: boolean }> = ({ file, line, column, compact }) => {
  const s = useIdeSettings();
  const t = texts();
  const [message, setMessage] = React.useState<string>();
  const flash = (text: string) => {
    setMessage(text);
    setTimeout(() => setMessage(undefined), 5000);
  };
  const open = async () => {
    const preset = kPresets.find(p => p.id === s.ide);
    const relative = repoRelative(file);
    if (preset?.agentIde) {
      try {
        const response = await fetch('api/ide/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: relative, line, column, ide: preset.agentIde }) });
        const result = response.ok ? await response.json() : { ok: false, error: `${response.status}` };
        flash(result.ok ? t.ideOpened : `${t.failed}: ${result.error}`);
      } catch (e) {
        flash(`${t.failed}: ${String(e.message || e)}`);
      }
      return;
    }
    const template = preset?.url ?? (s.ide === 'custom' ? s.template : '');
    if (!template || (template.includes('{path}') && !s.repoPath)) {
      flash(t.ideNotConfigured);
      return;
    }
    const absolute = `${s.repoPath.replace(/[\\/]$/, '')}/${relative}`;
    const url = template.replace('{path}', encodeURI(absolute)).replace('{relative}', encodeURI(relative)).replace('{line}', String(line)).replace('{column}', String(column ?? 1));
    window.location.href = url;
  };
  return <span className='open-in-ide'>
    <button className={compact ? 'link-button' : 'button'} onClick={open} title={`${file}:${line}`} data-testid='open-in-ide'>{compact ? `${file}:${line}` : t.openInIde}</button>
    {message && <span className='open-in-ide-message'>{message}</span>}
  </span>;
};
