import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { PixelButton } from './PixelButton';
import { KEYS_INTRO, KEYS_PATH, KEYS_SAFETY, KEYS_STEPS, KEYS_TITLE, KEY_DELETED_NOTE, KEY_SAVED_NOTE, keyRows, keysNotice } from '@/nexus/data/hostedKeysModel';

/**
 * Settings, "Access keys": the keys for the free online AI services the setup offers. The list of services (ids and labels) is what Nexus
 * read from its own check of this computer; a key is typed into a WRITE-ONLY field and is never shown again (a row says "Saved", "Not set"
 * or "Refused"). The key travels once to main, which stores it encrypted; nothing here can read it back. All wording is in hostedKeysModel.ts.
 *
 * "Add my key" in the setup sheet calls `requestKeysFocus()` and then opens Settings on "Agents & Models": this block comes first there, scrolls
 * itself into view and puts the cursor in the first empty key box, so the person lands exactly where the key goes.
 */
type KeyList = Awaited<ReturnType<typeof window.cth.hostedKeyPresent>>;

const FOCUS_EVENT = 'nexus:focus-access-keys';
let focusWanted = false;
/** Ask the access keys block to scroll into view and take the cursor (works whether or not Settings is open yet). */
export function requestKeysFocus(): void {
  focusWanted = true;
  try { window.dispatchEvent(new Event(FOCUS_EVENT)); } catch { /* no window: the flag is read when the block mounts */ }
}

const inputStyle: CSSProperties = {
  width: '100%', padding: '6px 8px 4px', background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)', outline: 'none'
};
const labelStyle: CSSProperties = { fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px', color: 'var(--cth-ink-700)', textTransform: 'uppercase' };
const headStyle: CSSProperties = { fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px', color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 2 };
const textStyle: CSSProperties = { fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '18px' };

export function HostedKeysSettings() {
  const [list, setList] = useState<KeyList | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, { text: string; alert: boolean }>>({});
  // The sentence of the last refused save per service (the row then says "Refused" until a key is saved).
  const [refused, setRefused] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const wantCursor = useRef(false);

  const read = useCallback(async () => {
    try { setList(await window.cth.hostedKeyPresent()); } catch { setList(null); }
  }, []);
  // The services come from Nexus's own check of this computer: when it has not landed yet the first read starts it, and one more read follows.
  useEffect(() => {
    let alive = true;
    void read();
    const t = setTimeout(() => { if (alive) void read(); }, 2500);
    return () => { alive = false; clearTimeout(t); };
  }, [read]);

  // Landing from "Add my key": scroll this block into view, then put the cursor in the first empty box once the rows are there.
  useEffect(() => {
    const take = () => {
      if (!focusWanted) return;
      focusWanted = false; wantCursor.current = true;
      box.current?.scrollIntoView?.({ block: 'start' });
    };
    take();
    window.addEventListener(FOCUS_EVENT, take);
    return () => window.removeEventListener(FOCUS_EVENT, take);
  }, []);

  const rows = keyRows(list && 'providers' in list ? list : null, drafts, refused);
  const notice = rows.length === 0 ? keysNotice(list) : null;
  useEffect(() => {
    if (!wantCursor.current || rows.length === 0) return;
    wantCursor.current = false;
    const first = rows.find((r) => !r.present) ?? rows[0];
    document.getElementById(`hosted-key-${first.id}`)?.focus();
  }, [rows.length]);

  const save = async (id: string) => {
    const row = rows.find((r) => r.id === id);
    if (!row || !row.canSave || row.draft === null || busy) return;
    setBusy(id);
    let note: { text: string; alert: boolean };
    try {
      const r = await window.cth.hostedKeySet({ provider: id, key: row.draft });
      note = r.ok ? { text: KEY_SAVED_NOTE, alert: false } : { text: r.message, alert: true };
      setRefused((m) => { const n = { ...m }; if (r.ok) delete n[id]; else n[id] = r.message; return n; });
      // The typed text leaves the field either way once it has been sent; a refusal never keeps a copy of the key on screen.
      setDrafts((d) => ({ ...d, [id]: '' }));
    } catch {
      note = { text: 'The access key could not be saved. Nothing was changed.', alert: true };
      setRefused((m) => ({ ...m, [id]: note.text }));
      setDrafts((d) => ({ ...d, [id]: '' }));
    }
    setNotes((n) => ({ ...n, [id]: note }));
    setBusy(null);
    void read();
  };
  const remove = async (id: string) => {
    if (busy) return;
    setBusy(id);
    let note: { text: string; alert: boolean };
    try {
      const r = await window.cth.hostedKeyDelete({ provider: id });
      note = r.ok ? { text: KEY_DELETED_NOTE, alert: false } : { text: r.message, alert: true };
      if (r.ok) setRefused((m) => { const n = { ...m }; delete n[id]; return n; });
    } catch { note = { text: 'The access key could not be deleted. Nothing was changed.', alert: true }; }
    setNotes((n) => ({ ...n, [id]: note }));
    setBusy(null);
    void read();
  };

  return (
    <div ref={box} id="nx-access-keys" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="hosted-keys">
      <div>
        <div style={headStyle}>{KEYS_TITLE}</div>
        <div style={{ ...textStyle, color: 'var(--cth-ink-500)' }}>{KEYS_PATH}</div>
        <div style={{ ...textStyle, marginTop: 4 }}>{KEYS_INTRO}</div>
        <ol style={{ ...textStyle, margin: '2px 0 0', paddingLeft: 18 }}>{KEYS_STEPS.map((t) => <li key={t}>{t}</li>)}</ol>
        <div style={{ ...textStyle, marginTop: 4 }}>{KEYS_SAFETY}</div>
      </div>
      {notice && <div style={{ ...textStyle, color: 'var(--cth-ink-500)' }} role="status">{notice}</div>}
      {rows.map((r) => (
        <div key={r.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={labelStyle} htmlFor={`hosted-key-${r.id}`}>{r.label} · {r.word}</label>
          <div style={{ ...textStyle, fontSize: 11 }}>{r.line}</div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input id={`hosted-key-${r.id}`} type="password" autoComplete="off" spellCheck={false} placeholder={r.placeholder}
              value={drafts[r.id] ?? ''} onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))} style={inputStyle} />
            <PixelButton variant="secondary" size="sm" disabled={!r.canSave || busy !== null} onClick={() => { void save(r.id); }}>Save</PixelButton>
            {r.canDelete && <PixelButton variant="secondary" size="sm" disabled={busy !== null} onClick={() => { void remove(r.id); }}>Delete</PixelButton>}
          </div>
          {r.problem && <div style={{ fontSize: 11, color: 'var(--cth-rose)' }} role="alert">{r.problem}</div>}
          {notes[r.id] && !r.problem && (
            <div style={{ fontSize: 11, color: notes[r.id].alert ? 'var(--cth-rose)' : 'var(--cth-ink-500)' }} role={notes[r.id].alert ? 'alert' : 'status'}>{notes[r.id].text}</div>
          )}
        </div>
      ))}
    </div>
  );
}
