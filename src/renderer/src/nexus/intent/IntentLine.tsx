import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { Icon } from '../icons';
import { useRoute } from '../router/useRoute';
import { formatRoute, routeTitle, type ProjectTool } from '../router/routes';
import { getWorkspace } from '../workspaces/registry';
import { primaryViewOf } from '../workspaces/participation';
import { useParticipationIndex } from '../data/useParticipations';
import { useNexusUi } from '../state/uiStore';
import { buildContextHeader } from '../assistant/context';
import { SUGGESTIONS } from '../assistant/prompts';
import { useAssistant } from '../assistant/useAssistant';
import { selectionLabel } from './intentContext';
import { usePlatform } from '../data/platformStore';
import { availabilityFrom } from '../data/executionModel';
import { useExecStore } from '../data/useExecution';
import { agentPanelModel, intentRoute, intentWords } from '../agent/agentModel';
import { sendToProjectAgent } from '../agent/sendToAgent';
import { isRunRequest, useRunReply } from '../agent/runIntent';
import { useProjectData } from '../project/yourDataModel';

const TOOL_PAGE: Record<ProjectTool, string> = { bench: 'Work area', changes: 'Suggested changes', completion: 'Checklist', runs: 'Tasks', try: 'Try it' };

let requestSeq = 0;
function newRequestId(): string { requestSeq += 1; return `r-${Date.now()}-${requestSeq}`; }

/** The Home page's Start hands its words over: the request box that opens next takes focus once, even though it is drawn after the press. */
let handoffAt = 0;
export function markHandoff(): void { handoffAt = Date.now(); }
function takeHandoff(): boolean { const fresh = Date.now() - handoffAt < 10000; handoffAt = 0; return fresh; }

/** One line, bound to what the user is looking at, that sends a request to an AI helper: this project's AI helper on a software
 *  project that is ready, the lead AI helper everywhere else. A label and one plain line say which. `summoned`: mounted on demand
 *  (Ctrl/Cmd+J or an "Ask" button) on a route that does not dock it, so it takes focus on mount and can close. `inline`: drawn in the
 *  flow of the page (inside the project page's next-step box) instead of docked at the bottom. */
export function IntentLine({ summoned = false, inline = false, compact = false, locked = false, dock = false, onClose }: { summoned?: boolean; inline?: boolean; compact?: boolean; locked?: boolean; dock?: boolean; onClose?: () => void }) {
  const port = useAssistant();
  const route = useRoute();
  const projects = useStore((s) => s.projects);
  const idx = useParticipationIndex();
  const draft = useNexusUi((s) => s.draft);
  const setDraft = useNexusUi((s) => s.setDraft);
  const selection = useNexusUi((s) => s.selection);
  const addRequest = useNexusUi((s) => s.addRequest);
  const focusTick = useNexusUi((s) => s.intentFocusTick);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ href: string; label: string; lead: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const ta = useRef<HTMLTextAreaElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const seenTick = useRef(summoned ? -1 : focusTick);
  const ids = { field: useId(), status: useId(), error: useId(), pop: useId() };

  useEffect(() => {
    if (!inline || summoned || !takeHandoff()) return undefined;
    const t = window.setTimeout(() => ta.current?.focus(), 300); // after the page has put its own focus on the title
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (focusTick !== seenTick.current) { seenTick.current = focusTick; ta.current?.focus(); }
  }, [focusTick]);

  // Grow with the text up to the CSS max-height; one line when empty.
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  useEffect(() => {
    if (!suggestOpen) return;
    const onDown = (e: MouseEvent) => { if (!popRef.current?.contains(e.target as Node)) setSuggestOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [suggestOpen]);

  // Real context only: the workspace/project on screen and, on a project, the
  // selected spine node.
  const ctx = useMemo(() => {
    if (route.name === 'project') {
      const p = projects.find((x) => x.id === route.id) ?? null;
      return {
        ws: p ? primaryViewOf(idx, p.id) : null,
        project: p,
        page: TOOL_PAGE[route.tool],
        selection: p ? selectionLabel(selection) : null
      };
    }
    return { ws: route.name === 'workspace' ? getWorkspace(route.id) : null, project: null, page: routeTitle(route), selection: null };
  }, [route, projects, selection, idx]);

  // B2b: on an SDE project route, with the AI helper ready to take a message, the line sends to the project's AI helper (#42). Every other
  // route, workspace and state keeps the lead AI helper behaviour. Reads only what the bench already loaded: no request of its own.
  const execHealth = useExecStore((st) => st.health);
  const platformOff = usePlatform((st) => st.unavailable);
  const askable = useMemo(() => {
    const p = agentPanelModel({ health: execHealth && execHealth.ok ? execHealth.data : null,
      availability: availabilityFrom({ unavailable: platformOff }, execHealth), sessions: [], sessionsFail: null });
    return { canAsk: p.canAsk, note: p.note };
  }, [execHealth, platformOff]);
  const canAsk = askable.canAsk;
  // The box inside the project's AI helper dock always belongs to the project's AI helper, whichever workspace the project is filed
  // under first (a project filed under Machine learning can still have the AI helper); it never falls back to the old lead agent.
  const mode = dock && ctx.project ? (canAsk ? 'agent' : 'legacy') : intentRoute({ routeName: route.name, primaryWorkspaceId: ctx.project ? ctx.ws?.id ?? null : null, canAsk });

  const chip = ctx.selection ?? ctx.project?.name ?? ctx.ws?.label ?? null;
  const header = buildContextHeader({
    workspace: ctx.ws?.label ?? null,
    project: ctx.project ? { name: ctx.project.name, rootPath: ctx.project.rootPath } : null,
    page: ctx.page,
    selection: ctx.selection
  });

  const s = port.status;
  // ONE plain line that says who gets the message and what happens next, and a short label for the same thing.
  // In the project dock the box never reaches the lead AI helper: while the project's own AI helper is not ready it is locked, text kept.
  const lockedBox = (locked || dock) && mode !== 'agent';
  // A Machine learning project (or a project with data: "Your data" records how many files it holds): the box asks about the data.
  const dataCount = useProjectData((st) => (ctx.project ? st.counts[ctx.project.id] ?? 0 : 0));
  const baseWords = intentWords({ mode: lockedBox ? 'agent' : mode, lead: s, onSoftwareProject: route.name === 'project' && ctx.ws?.id === 'sde' && !canAsk, note: askable.note, replyHint: port.replyHint,
    hasData: !lockedBox && (dataCount > 0 || (ctx.project !== null && ctx.ws?.id === 'ml')) });
  const words = lockedBox ? { ...baseWords, placeholder: 'Get this computer ready first', explain: 'The AI helper is not ready yet. What you typed is kept.' } : baseWords;

  const sendToAgent = async (text: string, projectId: string) => {
    if (sending) return;
    setSending(true);
    const r = await sendToProjectAgent(text, projectId);
    setSending(false);
    if (!r.ok) { setError(r.error); setSent(null); return; }
    setDraft(''); setError(null);
    useRunReply.getState().clear();
    // In the dock the box is already inside the AI helper panel: no link to it.
    setSent({ href: formatRoute({ name: 'project', id: projectId, tool: 'bench' }), label: dock ? '' : words.followLabel, lead: words.sentLead(r.continued) });
  };

  const send = () => {
    const text = draft.trim();
    if (!text || lockedBox) return;
    // A message that is only "run it" is not work for the AI helper: the dock answers it itself, with the one button that opens Try it. The words are cleared as after a send.
    if (mode === 'agent' && ctx.project && isRunRequest(text)) { useRunReply.getState().show(ctx.project.id); setDraft(''); setError(null); setSent(null); return; }
    if (mode === 'agent' && ctx.project) { void sendToAgent(text, ctx.project.id); return; }
    const res = port.send({ text: draft, contextHeader: header });
    if (!res.ok) { setError(res.error); setSent(null); return; }
    const projectId = ctx.project?.id ?? null;
    addRequest({
      id: newRequestId(), agentId: res.target.id, queuedMessageId: res.queuedMessageId, text,
      projectId, selectionLabel: ctx.selection, sentAt: Date.now()
    });
    setDraft('');
    setError(null);
    setSent(projectId
      ? { href: formatRoute({ name: 'project', id: projectId, tool: 'runs' }), label: words.followLabel, lead: words.sentLead(false) }
      : { href: formatRoute({ name: 'agents' }), label: 'Open Agents', lead: words.sentLead(false) });
  };

  const prefill = (text: string) => {
    setDraft(text);
    setSuggestOpen(false);
    setError(null);
    ta.current?.focus();
  };

  return (
    <form className={inline ? 'nx-intent nx-intent--inline' : 'nx-intent'} aria-label={words.ariaLabel} onSubmit={(e) => { e.preventDefault(); send(); }}>
      <div className="nx-intent__row">
        <span className="nx-intent__mode" data-mode={mode}>{words.label}</span>
        {chip && (
          <span className="nx-intent__chip" title={words.chipTitle(chip)}>
            <span className="nx-visually-hidden">Looking at: </span>{chip}
          </span>
        )}
        <label className="nx-visually-hidden" htmlFor={ids.field}>{words.ariaLabel}</label>
        <textarea
          id={ids.field} ref={ta} className="nx-intent__field" rows={1} disabled={lockedBox}
          placeholder={words.placeholder}
          value={draft}
          aria-describedby={error ? `${ids.error} ${ids.status}` : ids.status}
          aria-invalid={error ? true : undefined}
          onChange={(e) => { setDraft(e.target.value); setError(null); setSent(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
            else if (e.key === 'Escape' && summoned && onClose) { e.preventDefault(); onClose(); }
          }}
        />
        <div className="nx-intent__suggest" ref={popRef}>
          <button type="button" className="nx-btn nx-btn--quiet nx-iconbtn" aria-label="Ideas to start from" title="Ideas to start from"
            aria-expanded={suggestOpen} aria-controls={ids.pop} onClick={() => setSuggestOpen((v) => !v)}
            onKeyDown={(e) => { if (e.key === 'Escape' && suggestOpen) { e.preventDefault(); e.stopPropagation(); setSuggestOpen(false); } }}>
            <Icon name="sparkles" size={15} />
          </button>
          {suggestOpen && (
            <ul id={ids.pop} className="nx-intent__pop" aria-label="Ideas to start from"
              onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setSuggestOpen(false); ta.current?.focus(); } }}>
              {SUGGESTIONS.map((sg) => (
                <li key={sg.id}>
                  <button type="button" className="nx-intent__sugg" onClick={() => prefill(sg.prompt)}>
                    <Icon name={sg.icon} size={15} /><span>{sg.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button type="submit" className="nx-btn nx-btn--primary nx-intent__send" aria-label={words.button} title={words.button} disabled={!draft.trim() || sending || lockedBox}>
          <Icon name="send" size={15} /><span className="nx-intent__send-text">{words.button}</span>
        </button>
        {summoned && onClose && (
          <button type="button" className="nx-btn nx-btn--quiet nx-iconbtn" aria-label="Close" title="Close" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        )}
      </div>
      {error && <p id={ids.error} className="nx-intent__error" role="alert">{error}</p>}
      <p id={ids.status} className="nx-intent__status">
        {/* Compact (the dock): no caption under the box; only a locked box says why (what the AI helper can see and change is behind "i"). */}
        {compact
          ? (lockedBox && <span className="nx-intent__details">{words.explain}</span>)
          : <span>{words.explain}</span>}
        <span role="status">
          {sent && <> {sent.lead}{sent.label && <> <a href={sent.href}>{sent.label}</a></>}</>}
        </span>
      </p>
    </form>
  );
}
