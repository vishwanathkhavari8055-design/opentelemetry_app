import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { createAlertFolder, fetchAlertFolders, importAlerts } from '../../services/api';
import { DEFAULT_FOLDER_ID } from './alertModel';

/**
 * Import Alert: paste or drop alert JSON, or fetch it from a URL.
 *
 * Accepts either a single alert object or an array of them, because both are
 * what OpenObserve's own export produces depending on whether one alert or a
 * folder was exported.
 *
 * Import is per-document, not all-or-nothing: a file with ten alerts and one
 * typo imports the nine good ones and reports the tenth. The Output Messages
 * panel is that report, and it is the reason this screen exists as a screen
 * rather than a file picker — you need to see what happened to each entry.
 *
 * The URL tab fetches in the BROWSER, deliberately. Routing it through the
 * backend would turn this service into an open fetch proxy: anyone who can reach
 * the API could use it to probe hosts inside the network that they cannot reach
 * themselves. Fetching client-side keeps the request bound by the user's own
 * network position and CORS, which is the correct blast radius. The cost is that
 * a URL without CORS headers will not load, and the error says so.
 */

const IconBack = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m15 18-6-6 6-6" />
  </svg>
);

const IconCloud = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 17h11a4 4 0 0 0 .5-8A6 6 0 0 0 6 10a3.5 3.5 0 0 0 0 7Z" />
    <path d="M12 20v-8" /><path d="m9 15 3-3 3 3" />
  </svg>
);

/** Pull an array of alert documents out of whatever shape was supplied. */
const extractAlerts = (parsed) => {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  // OpenObserve's list export wraps in {"list":[…]}; tolerate that too so a
  // response pasted straight from the API works.
  if (Array.isArray(parsed.list)) return parsed.list;
  if (Array.isArray(parsed.alerts)) return parsed.alerts;
  return [parsed];
};

export default function AlertImport({
  folders, initialFolderId, onClose, onImported, onFolderCreated,
}) {
  const [tab, setTab] = useState('file');   // 'file' | 'url'
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [dragOver, setDragOver] = useState(false);

  const [url, setUrl] = useState('');
  const [fetching, setFetching] = useState(false);

  const [folderId, setFolderId] = useState(initialFolderId || DEFAULT_FOLDER_ID);
  const [folderList, setFolderList] = useState(folders || []);
  const [showFolderInput, setShowFolderInput] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  // See the matching note in AlertEditor: the parent's folder list arrives
  // asynchronously, so a screen opened before it resolves must pick it up.
  useEffect(() => {
    if (folders?.length) setFolderList(folders);
  }, [folders]);

  const [importing, setImporting] = useState(false);
  const [outcomes, setOutcomes] = useState([]);
  const [error, setError] = useState('');

  const fileRef = useRef(null);

  /** Parse once, and reuse for both validation and the import. */
  const parsed = useMemo(() => {
    const raw = text.trim();
    if (!raw) return { ok: null, alerts: [], error: '' };
    try {
      const value = JSON.parse(raw);
      const alerts = extractAlerts(value);
      if (!alerts.length) {
        return { ok: false, alerts: [], error: 'No alert objects found in this JSON.' };
      }
      return { ok: true, alerts, error: '' };
    } catch (err) {
      return { ok: false, alerts: [], error: `Invalid JSON — ${err.message}` };
    }
  }, [text]);

  const readFile = useCallback(async (file) => {
    setError('');
    if (!file) return;
    if (!/\.json$/i.test(file.name)) {
      setError('Only .json files are accepted.');
      return;
    }
    if (typeof file.text === 'function') {
      try {
        const content = await file.text();
        setText(content);
        setFileName(file.name);
      } catch {
        setError('Could not read that file.');
      }
      return;
    }
    if (typeof file.text === 'function') {
      file.text().then((content) => {
        setText(content);
        setFileName(file.name);
      }).catch(() => setError('Could not read that file.'));
      return;
    }
    const Reader = typeof window !== 'undefined' ? window.FileReader : null;
    if (Reader) {
      const reader = new Reader();
      reader.onload = () => {
        const res = reader.result;
        const content = typeof res === 'string' ? res : '';
        setText(content);
        setFileName(file.name);
      };
      reader.onerror = () => setError('Could not read that file.');
      const readFn = 'readAsText';
      reader[readFn](file);
    }
  }, []);

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    readFile(e.dataTransfer?.files?.[0]);
  };

  const loadUrl = async () => {
    const target = url.trim();
    if (!target) return;
    setFetching(true);
    setError('');
    try {
      const res = await fetch(target);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setText(await res.text());
      setFileName(target.split('/').pop() || target);
    } catch (err) {
      // The overwhelmingly common cause is a missing CORS header, which the
      // browser reports only as a generic TypeError — so say so explicitly
      // rather than leaving the user to guess.
      setError(
        `Could not fetch that URL — ${err.message}. `
        + 'The browser fetches it directly, so the host must allow cross-origin reads.',
      );
    } finally {
      setFetching(false);
    }
  };

  const onCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    setError('');
    try {
      await createAlertFolder({ name, description: '' });
      const res = await fetchAlertFolders();
      const items = res.items || [];
      setFolderList(items);
      const created = items.find((f) => f.name === name);
      if (created) setFolderId(created.folderId);
      setShowFolderInput(false);
      setNewFolderName('');
      onFolderCreated?.();
    } catch (err) {
      setError(`Could not create folder — ${err.message}`);
    }
  };

  const onImport = async () => {
    if (!parsed.ok) return;
    setImporting(true);
    setError('');
    setOutcomes([]);
    try {
      const result = await importAlerts({ alerts: parsed.alerts, folderId });
      // `seq` is the entry's position in the file, which is what tells two
      // outcomes with the same name apart.
      const list = (Array.isArray(result) ? result : []).map((o, seq) => ({ ...o, seq }));
      setOutcomes(list);
      // Only leave the screen when EVERYTHING landed. If some entries failed,
      // staying put keeps the report and the source JSON side by side so the
      // user can fix and retry — navigating away would throw both away.
      const failed = list.filter((o) => !o.ok);
      if (list.length && failed.length === 0) {
        onImported({ message: `Imported ${list.length} alert(s).` });
      }
    } catch (err) {
      setError(err.message || 'Import failed.');
    } finally {
      setImporting(false);
    }
  };


  return (
    <div className="ai-view">
      <div className="ae-topbar">
        <button type="button" className="ae-back" onClick={onClose} aria-label="Back to alerts">
          <IconBack />
        </button>
        {/* h2, not h1: AlertsShell's title bar owns the screen's h1, and this
            view replaces the Rules card inside the panel rather than the screen.
            The inline 1.2rem stays — it holds this title at the same size as the
            bar above it, which is what makes the topbar read as a continuation
            of the frame rather than as a card title. */}
        <h2 className="alerts-title" style={{ fontSize: '1.2rem' }}>Import Alert</h2>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: '0.6rem' }}>
          <button
            type="button" className="alerts-btn-ghost" onClick={onClose} disabled={importing}
          >Cancel</button>
          <button
            type="button" className="alerts-btn-primary"
            onClick={onImport}
            disabled={importing || !parsed.ok}
            title={parsed.ok ? undefined : 'Supply valid alert JSON first'}
          >{importing ? 'Importing…' : 'Import'}</button>
        </span>
      </div>

      <div className="ai-cols">
        <div className="ai-left">
          <section className="ae-card">
            <div className="ae-card-body">
              <div className="tv-tabs" role="tablist" aria-label="Import source">
                <button
                  type="button" role="tab" aria-selected={tab === 'file'}
                  className={`tv-tab ${tab === 'file' ? 'is-active' : ''}`}
                  onClick={() => setTab('file')}
                >File Upload / JSON</button>
                <button
                  type="button" role="tab" aria-selected={tab === 'url'}
                  className={`tv-tab ${tab === 'url' ? 'is-active' : ''}`}
                  onClick={() => setTab('url')}
                >URL Import</button>
              </div>
            </div>
          </section>

          <section className="ae-card" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            <div
              className="ae-card-body"
              style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: '0.6rem' }}
            >
              <div className="ae-inline" style={{ alignItems: 'flex-start' }}>
                {tab === 'file' ? (
                  <div style={{ flex: 1, minWidth: 240, position: 'relative' }}>
                    <button
                      type="button"
                      className={`ai-drop ${dragOver ? 'is-over' : ''}`}
                      onClick={() => fileRef.current?.click()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          fileRef.current?.click();
                        }
                      }}
                      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={onDrop}
                    >
                      <IconCloud />
                      <span className="ai-drop-text">
                        {fileName || 'Drop your file here'}
                      </span>
                    </button>
                    {(fileName || text) && (
                      <button
                        type="button"
                        className="ai-drop-x"
                        aria-label="Clear"
                        style={{ position: 'absolute', right: '12px', top: '12px' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setText('');
                          setFileName('');
                          setOutcomes([]);
                          setError('');
                          if (fileRef.current) fileRef.current.value = '';
                        }}
                      >×</button>
                    )}
                    <div className="ae-hint">.json files only</div>
                    <input
                      ref={fileRef}
                      type="file"
                      accept=".json,application/json"
                      style={{ display: 'none' }}
                      onChange={(e) => readFile(e.target.files?.[0])}
                    />
                  </div>
                ) : (
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <div className="ae-inline">
                      <input
                        className="ae-input ae-input--grow"
                        value={url}
                        placeholder="https://example.com/alerts.json"
                        aria-label="Alert JSON URL"
                        onChange={(e) => setUrl(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); loadUrl(); } }}
                      />
                      <button
                        type="button" className="alerts-btn-ghost"
                        onClick={loadUrl} disabled={fetching || !url.trim()}
                      >{fetching ? 'Loading…' : 'Load'}</button>
                    </div>
                    <div className="ae-hint">
                      Fetched by your browser, so the host must allow cross-origin reads.
                    </div>
                  </div>
                )}

                <ImportFolderPicker
                  folderId={folderId} setFolderId={setFolderId} folderList={folderList}
                  showFolderInput={showFolderInput} setShowFolderInput={setShowFolderInput}
                  newFolderName={newFolderName} setNewFolderName={setNewFolderName}
                  onCreateFolder={onCreateFolder}
                />
              </div>

              <label className="ae-stack-label" htmlFor="ai-json">Alert JSON</label>
              <textarea
                id="ai-json"
                className={`ai-editor ${parsed.ok === false ? 'ai-editor--invalid' : ''}`}
                value={text}
                spellCheck={false}
                placeholder={'{\n  "name": "high_error_rate",\n  "stream_type": "logs",\n  "stream_name": "default",\n  …\n}'}
                onChange={(e) => { setText(e.target.value); setOutcomes([]); }}
              />

              {parsed.ok === false && <div className="ae-error">{parsed.error}</div>}
              {parsed.ok && (
                <div className="ae-hint">
                  {parsed.alerts.length} alert document(s) ready to import.
                </div>
              )}
              {error && <div className="ae-error">{error}</div>}
            </div>
          </section>
        </div>

        {/* ── Output Messages ──────────────────────────────────────────── */}
        <ImportOutcomes outcomes={outcomes} />
</div>
    </div>
  );
}

AlertImport.propTypes = {
  folders: PropTypes.array,
  initialFolderId: PropTypes.string,
  onClose: PropTypes.func.isRequired,
  /** Called with { message } once every document imported cleanly. */
  onImported: PropTypes.func.isRequired,
  /** Lets the parent refresh its folder rail after one is created here. */
  onFolderCreated: PropTypes.func,
};

/** Target folder, with an inline "new folder" input. */
function ImportFolderPicker({
  folderId, setFolderId, folderList,
  showFolderInput, setShowFolderInput, newFolderName, setNewFolderName, onCreateFolder,
}) {
  return (
    <div className="ae-field" style={{ alignItems: 'flex-start' }}>
      <span className="ae-label">
        Select Folder <span className="ae-req">*</span>
      </span>
      <select
        className="ae-select"
        value={folderId}
        aria-label="Target folder"
        onChange={(e) => setFolderId(e.target.value)}
      >
        {(folderList.length
          ? folderList
          : [{ folderId: DEFAULT_FOLDER_ID, name: 'default' }]
        ).map((f) => (
          <option key={f.folderId} value={f.folderId}>{f.name || f.folderId}</option>
        ))}
      </select>
      {showFolderInput ? (
        <>
          <input
            className="ae-input"
            value={newFolderName}
            placeholder="New folder"
            aria-label="New folder name"
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); onCreateFolder(); }
            }}
          />
          <button type="button" className="alerts-btn-ghost" onClick={onCreateFolder}>Add</button>
          <button
            type="button" className="alerts-btn-ghost"
            onClick={() => { setShowFolderInput(false); setNewFolderName(''); }}
          >×</button>
        </>
      ) : (
        <button
          type="button" className="alerts-btn-ghost"
          onClick={() => setShowFolderInput(true)} title="New folder"
        >+</button>
      )}
    </div>
  );
}

ImportFolderPicker.propTypes = {
  folderId: PropTypes.string,
  setFolderId: PropTypes.func.isRequired,
  folderList: PropTypes.array.isRequired,
  showFolderInput: PropTypes.bool,
  setShowFolderInput: PropTypes.func.isRequired,
  newFolderName: PropTypes.string,
  setNewFolderName: PropTypes.func.isRequired,
  onCreateFolder: PropTypes.func.isRequired,
};

/** The Output Messages panel: one line per document the import attempted. */
function ImportOutcomes({ outcomes }) {
  const okCount = outcomes.filter((o) => o.ok).length;
  const failCount = outcomes.length - okCount;

  return (
    <div className="ai-right">
      <section className="ae-card ae-card--fill">
        <div className="ae-card-head ae-card-head--plain">Output Messages</div>
        {outcomes.length === 0 ? (
          <div className="ae-card-body">
            <div className="ae-placeholder">
              <span>
                Results appear here — one line per alert, so a single bad entry
                is visible without hiding the ones that worked.
              </span>
            </div>
          </div>
        ) : (
          <>
            <div className="ae-card-body" style={{ paddingBottom: 0 }}>
              <div className="ae-preview-count">
                {okCount} imported{failCount ? `, ${failCount} failed` : ''}.
                {failCount > 0 && ' Fix the failures above and import again — '
                  + 'the successful ones are already saved and will be duplicated '
                  + 'only if their names change.'}
              </div>
            </div>
            <div className="ai-out">
              {outcomes.map((o) => (
                <div className="ai-out-item" key={`${o.name}-${o.seq}`}>
                  <span className={`ai-out-badge ai-out-badge--${o.ok ? 'ok' : 'fail'}`}>
                    {o.ok ? '✓' : '!'}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span className="ai-out-name">{o.name}</span>
                    {o.message && <> — <span className="ai-out-msg">{o.message}</span></>}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

ImportOutcomes.propTypes = { outcomes: PropTypes.array.isRequired };
