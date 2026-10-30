import { useState, useEffect, type CSSProperties } from 'react';
import type { HarnessConfig, AgentProvider } from '@/store/config';
import { PixelButton } from './PixelButton';
import { ProviderLogo } from './ProviderLogo';
import { OSS_BLOG_LINKS } from '@shared/ossModels';
import { useStore } from '@/store/store';

/**
 * AiEnginesSettings — the v0.3.1 per-provider config surface for the BYOK CLI
 * engines (OpenCode · Crush · pi.dev · Qwen). Two stores by what the datum is:
 *  - API keys → WRITE-ONLY in the secret broker (`providerKey:*` IPC). Keyed by the
 *    BACKEND model-provider (anthropic/openai/…). The field shows only set/not-set;
 *    the plaintext is never read back to the renderer (materialized MAIN-only at spawn).
 *  - Local base-URL + default model → HarnessConfig (`providerBaseUrls` /
 *    `providerDefaultModels`), keyed by CLI provider. Non-secret; normal config save.
 * See hive/shared/cli-agents/settings-ui-schema.md.
 */

/** Backend model-providers whose keys the CLIs read from standard env vars. Must
 *  match BACKEND_KEY_ENV in src/main/index.ts. */
const BACKENDS: Array<{ id: string; label: string; envVar: string }> = [
  { id: 'anthropic', label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY' },
  { id: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY' },
  { id: 'google', label: 'Google · Gemini', envVar: 'GEMINI_API_KEY' },
  { id: 'openrouter', label: 'OpenRouter', envVar: 'OPENROUTER_API_KEY' },
  { id: 'groq', label: 'Groq', envVar: 'GROQ_API_KEY' }
];

/** CLI engines that take a per-provider local base-URL + default model. */
const CLIS: Array<{ id: AgentProvider; label: string; hint: string }> = [
  { id: 'opencode', label: 'OpenCode', hint: 'http://localhost:11434/v1 (Ollama). Used as an AI service on this computer' },
  { id: 'crush', label: 'Crush', hint: 'the address of an AI service that works like OpenAI’s' },
  { id: 'pi', label: 'Pi', hint: 'local models are listed in a file called models.json, so no address is used yet' },
  { id: 'qwen', label: 'Qwen', hint: 'the address of an AI service that works like OpenAI’s' }
];

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 13,
  color: 'var(--cth-ink-900)',
  outline: 'none'
};
const labelStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-display)',
  fontSize: 8,
  lineHeight: '12px',
  color: 'var(--cth-ink-700)',
  textTransform: 'uppercase'
};
const headStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 2
};
const linkStyle: CSSProperties = { color: 'var(--cth-ink-900)', textDecoration: 'underline', cursor: 'pointer' };

export function AiEnginesSettings({ config }: { config: HarnessConfig }) {
  // Keep the global "OpenAI key present" signal (boolean only) live so the Talk
  // button's missing-key warning clears the instant the user saves their OpenAI key
  // here — without it the gate only refreshes on next app start. apikey:openai is
  // the same key the Realtime mint reads; saving/clearing it flips the gate.
  const setHasOpenAiKey = useStore((s) => s.setHasOpenAiKey);
  // Which backends already have a key stored (boolean only — never the value).
  const [hasKey, setHasKey] = useState<Record<string, boolean>>({});
  const [draftKey, setDraftKey] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  // Base-URL + default-model drafts, seeded from config.
  const [baseUrls, setBaseUrls] = useState<Partial<Record<AgentProvider, string>>>(
    config.providerBaseUrls ?? {}
  );
  const [models, setModels] = useState<Partial<Record<AgentProvider, string>>>(
    config.providerDefaultModels ?? {}
  );

  // Ollama health & model discovery state
  const [ollamaStatus, setOllamaStatus] = useState<{ running: boolean; version?: string; error?: string } | null>(null);
  const [ollamaModels, setOllamaModels] = useState<Array<{ name: string; model: string; size: number }>>([]);
  const [selectedOllamaModel, setSelectedOllamaModel] = useState<string>('qwen2.5-coder:7b');
  const [ollamaTesting, setOllamaTesting] = useState(false);
  const [ollamaTestNote, setOllamaTestNote] = useState<string | null>(null);

  // Reseed set/not-set flags + query Ollama on mount.
  useEffect(() => {
    let alive = true;
    (async () => {
      const out: Record<string, boolean> = {};
      for (const b of BACKENDS) {
        try { out[b.id] = await window.cth.providerKeyHas(b.id); } catch { out[b.id] = false; }
      }
      if (alive) setHasKey(out);

      // Check Ollama status
      try {
        const st = await window.cth.ollamaStatus();
        if (alive) setOllamaStatus(st);
        if (st.running) {
          const res = await window.cth.ollamaModels();
          if (alive && res.ok && Array.isArray(res.models)) {
            setOllamaModels(res.models);
            if (res.models.length > 0 && !res.models.some((m) => m.name === selectedOllamaModel)) {
              setSelectedOllamaModel(res.models[0].name);
            }
          }
        }
      } catch {
        if (alive) setOllamaStatus({ running: false, error: 'Nexus could not reach Ollama.' });
      }
    })();
    return () => { alive = false; };
  }, []);

  const runOllamaTest = async () => {
    setOllamaTesting(true);
    setOllamaTestNote(null);
    try {
      const r = await window.cth.ollamaTest({ model: selectedOllamaModel });
      if (r.ok) {
        const evalTokens = r.tokens?.eval_count ? ` · ${r.tokens.eval_count} tokens generated` : '';
        setOllamaTestNote(`✓ It works (${r.latencyMs}ms${evalTokens}). The AI said: "${r.response || 'Ready'}"`);
      } else {
        setOllamaTestNote(`✗ The test did not work: ${r.error || 'no reason was given'}`);
      }
    } catch (e) {
      setOllamaTestNote(`✗ The test did not work: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setOllamaTesting(false);
    }
  };

  const saveKey = async (backend: string) => {
    const key = (draftKey[backend] ?? '').trim();
    if (!key) return;
    try {
      const r = await window.cth.providerKeySet({ backend, key });
      if (r.ok) {
        setHasKey((s) => ({ ...s, [backend]: true }));
        setDraftKey((s) => ({ ...s, [backend]: '' }));
        setNote((s) => ({ ...s, [backend]: 'saved' }));
        // OpenAI key gates Talk — mirror presence to the store so the warning clears now.
        if (backend === 'openai') setHasOpenAiKey(true);
      } else setNote((s) => ({ ...s, [backend]: r.error ?? 'could not be saved' }));
    } catch (e) { setNote((s) => ({ ...s, [backend]: e instanceof Error ? e.message : String(e) })); }
  };
  const clearKey = async (backend: string) => {
    try {
      await window.cth.providerKeyClear(backend);
      setHasKey((s) => ({ ...s, [backend]: false }));
      setNote((s) => ({ ...s, [backend]: 'cleared' }));
      // OpenAI key gates Talk — clearing it disables Talk; reflect that immediately.
      if (backend === 'openai') setHasOpenAiKey(false);
    } catch { /* noop */ }
  };

  const saveBaseUrl = async (id: AgentProvider, value: string) => {
    const next = { ...baseUrls, [id]: value.trim() || undefined };
    setBaseUrls(next);
    // A new or changed host asks in main ("Send your … key to …?"); adopt what
    // main stored so a Cancel shows the previous URL again.
    try {
      const stored = await window.cth.updateConfig({ providerBaseUrls: next });
      setBaseUrls({ ...(stored.providerBaseUrls ?? {}) });
    } catch { /* noop */ }
  };
  const saveModel = async (id: AgentProvider, value: string) => {
    const next = { ...models, [id]: value.trim() || undefined };
    setModels(next);
    try { await window.cth.updateConfig({ providerDefaultModels: next }); } catch { /* noop */ }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={headStyle}>OTHER AI HELPER PROGRAMS</div>
        <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '18px' }}>
          Access keys and addresses for the helper programs OpenCode, Crush, pi.dev and Qwen.
          Each key is <strong>locked on this computer and never shown again</strong>, and it is
          used only when one of those programs starts. Claude Code and Codex use their own sign-in.
        </div>
      </div>

      {/* Backend access keys (write-only) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={headStyle}>ACCESS KEYS</div>
        {BACKENDS.map((b) => (
          <div key={b.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={labelStyle}>
              {b.label} {hasKey[b.id] ? '· set ✓' : ''} <span style={{ opacity: 0.6 }}>({b.envVar})</span>
            </label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="password"
                autoComplete="off"
                placeholder={hasKey[b.id] ? '•••••••• (saved. Type to replace it)' : `paste your ${b.label} access key`}
                value={draftKey[b.id] ?? ''}
                onChange={(e) => setDraftKey((s) => ({ ...s, [b.id]: e.target.value }))}
                style={inputStyle}
              />
              <PixelButton variant="secondary" size="sm" onClick={() => saveKey(b.id)}>Save</PixelButton>
              {hasKey[b.id] && (
                <PixelButton variant="secondary" size="sm" onClick={() => clearKey(b.id)}>Clear</PixelButton>
              )}
            </div>
            {note[b.id] && <div style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{note[b.id]}</div>}
          </div>
        ))}
      </div>

      {/* Ollama Local Model Provider */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 12,
        background: 'var(--cth-paper-100)',
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ProviderLogo provider="pi" size={16} />
            <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: 'var(--cth-ink-900)', textTransform: 'uppercase' }}>
              Ollama · AI on this computer
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: ollamaStatus?.running ? 'var(--cth-mint)' : 'var(--cth-rose)'
              }}
            />
            <span style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>
              {ollamaStatus?.running ? `Running (version ${ollamaStatus.version || 'unknown'})` : 'Not running'}
            </span>
          </div>
        </div>

        <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '18px' }}>
          Ollama is a free program that runs AI on this computer. Nexus looks for it at <code>http://localhost:11434</code>.
          The models it finds can be used by your local AI helpers.
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Models installed in Ollama</label>
            {ollamaModels.length > 0 ? (
              <select
                value={selectedOllamaModel}
                onChange={(e) => setSelectedOllamaModel(e.target.value)}
                style={{ ...inputStyle, cursor: 'pointer' }}
              >
                {ollamaModels.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name} ({(m.size / (1024 * 1024 * 1024)).toFixed(1)} GB)
                  </option>
                ))}
              </select>
            ) : (
              <div style={{ ...inputStyle, color: 'var(--cth-ink-500)', fontSize: 12 }}>
                {ollamaStatus?.running ? 'Ollama has no models yet. In a terminal, run: ollama pull qwen2.5-coder:7b' : 'Nexus cannot find Ollama. Install it and start it.'}
              </div>
            )}
          </div>

          <div style={{ paddingTop: 14 }}>
            <PixelButton
              variant="secondary"
              size="sm"
              disabled={!ollamaStatus?.running || ollamaTesting}
              onClick={() => void runOllamaTest()}
            >
              {ollamaTesting ? 'Testing...' : 'Test it'}
            </PixelButton>
          </div>
        </div>

        {ollamaTestNote && (
          <div style={{
            fontSize: 11,
            color: ollamaTestNote.startsWith('✓') ? 'var(--cth-mint)' : 'var(--cth-rose)',
            padding: '4px 6px',
            background: 'var(--cth-paper-50)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-200)'
          }}>
            {ollamaTestNote}
          </div>
        )}
      </div>

      {/* Per-CLI local endpoint + default model */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={headStyle}>ADDRESS AND DEFAULT MODEL FOR EACH PROGRAM</div>
        {CLIS.map((c) => (
          <div key={c.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
              <ProviderLogo provider={c.id} size={12} /> {c.label}
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                placeholder={`address: ${c.hint}`}
                defaultValue={baseUrls[c.id] ?? ''}
                onBlur={(e) => saveBaseUrl(c.id, e.target.value)}
                style={inputStyle}
              />
              <input
                placeholder="default model (service/model)"
                defaultValue={models[c.id] ?? ''}
                onBlur={(e) => saveModel(c.id, e.target.value)}
                style={{ ...inputStyle, maxWidth: 220 }}
              />
            </div>
          </div>
        ))}
        {/* Local-setup guides (ondev-c part-3) — link the two how-to blogs. */}
        {(OSS_BLOG_LINKS.openModels || OSS_BLOG_LINKS.macMini) && (
          <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '17px' }}>
            Running open models? Step-by-step guides:{' '}
            {OSS_BLOG_LINKS.openModels && (() => {
              const url = OSS_BLOG_LINKS.openModels;
              return (
                <a
                  href={url}
                  onClick={(e) => { e.preventDefault(); void window.cth.openExternal(url); }}
                  style={linkStyle}
                >running on open models (guide)</a>
              );
            })()}
            {OSS_BLOG_LINKS.openModels && OSS_BLOG_LINKS.macMini && <>{' '}·{' '}</>}
            {OSS_BLOG_LINKS.macMini && (() => {
              const url = OSS_BLOG_LINKS.macMini;
              return (
                <a
                  href={url}
                  onClick={(e) => { e.preventDefault(); void window.cth.openExternal(url); }}
                  style={linkStyle}
                >set it up on a Mac Mini</a>
              );
            })()}.
          </div>
        )}
      </div>

      {/* Unsandboxed-in-auto caveat (Pam guardrail #6) */}
      <div style={{
        fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '17px',
        padding: 8, boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', background: 'var(--cth-paper-100)'
      }}>
        ⚠ With <strong>auto mode</strong> on, these programs can change any file on this computer and
        run any command, and nothing limits them. Turn auto mode off (in General) to make them
        ask first. This has not yet been tested from start to finish with a real AI.
      </div>
    </div>
  );
}
