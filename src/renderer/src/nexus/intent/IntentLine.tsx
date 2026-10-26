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
import { nexusClient } from '../data/nexusClient';
import { usePlatform } from '../data/platformStore';
import { availabilityFrom } from '../data/executionModel';
import { useExecStore, withIntent } from '../data/useExecution';
import { agentFailText, agentPanelModel, intentRoute, startArgs } from '../agent/agentModel';

const TOOL_PAGE: Record<ProjectTool, string> = { bench: 'Bench', changes: 'Changes', completion: 'Completion', runs: 'Runs' };

let requestSeq = 0;
function newRequestId(): string { requestSeq += 1; return `r-${Date.now()}-${requestSeq}`; }

/** One line, bound to what the user is looking at, that sends a request to the
 *  lead agent. `summoned`: mounted on demand (Ctrl/Cmd+J or an "Ask" button)
 *  on a route that does not dock it, so it takes focus on mount and can close. */
export function IntentLine({ summoned = false, onClose }: { summoned?: boolean; onClose?: () => void }) {
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

  // B2b: on an SDE project route, with the agent ready to take a message, the line sends to the project's agent (#42). Every other
  // route, workspace and state keeps the legacy lead-agent behaviour. Reads only what the bench already loaded: no request of its own.
  const execHealth = useExecStore((st) => st.health);
  const platformOff = usePlatform((st) => st.unavailable);
  const canAsk = useMemo(() => agentPanelModel({ health: execHealth && execHealth.ok ? execHealth.data : null,
    availability: availabilityFrom({ unavailable: platformOff }, execHealth), sessions: [], sessionsFail: null }).canAsk, [execHealth, platformOff]);
  const mode = intentRoute({ routeName: route.name, primaryWorkspaceId: ctx.project ? ctx.ws?.id ?? null : null, canAsk });

  const chip = ctx.selection ?? ctx.project?.name ?? ctx.ws?.label ?? null;
  const header = buildContextHeader({
    workspace: ctx.ws?.label ?? null,
    project: ctx.project ? { name: ctx.project.name, rootPath: ctx.project.rootPath } : null,
    page: ctx.page,
    selection: ctx.selection
  });

  const s = port.status;
  const statusText = mode === 'agent' ? 'Sends to this project’s agent. It works in its own copy of the repository; your files change only when you accept and merge.'
    : s.state === 'unavailable' ? s.reason
    : s.state === 'starting' ? 'Lead agent starting. Requests are queued until it is ready.'
    : s.deliveryPaused ? 'Lead agent ready. Delivery is paused in Agents.'
    : 'Lead agent ready.';

  const sendToAgent = async (text: string, projectId: string) => {
    if (sending) return;
    const built = startArgs({ projectId, workspaceId: 'sde', sessionId: null, message: text, intentId: 'pending' });
    if ('problem' in built) { setError(built.problem); setSent(null); return; }
    setSending(true);
    const r = await withIntent(`intent:agent:${projectId}:${text.length}:${text.slice(0, 64)}`, (intentId) => nexusClient.agentStart({ ...built.args, intentId }));
    setSending(false);
    if (!r.ok) { setError(agentFailText(r)); setSent(null); return; }
    usePlatform.getState().bumpRev();
    setDraft(''); setError(null);
    setSent({ href: formatRoute({ name: 'project', id: projectId, tool: 'bench' }), label: 'Follow it in the agent panel', lead: 'Sent to the agent.' });
  };

  const send = () => {
    const text = draft.trim();
    if (!text) return;
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
      ? { href: formatRoute({ name: 'project', id: projectId, tool: 'runs' }), label: 'Follow it in Runs', lead: 'Queued.' }
      : { href: formatRoute({ name: 'agents' }), label: 'Open Agents', lead: 'Queued.' });
  };

  const prefill = (text: string) => {
    setDraft(text);
    setSuggestOpen(false);
    setError(null);
    ta.current?.focus();
  };

  return (
    <form className="nx-intent" aria-label={mode === 'agent' ? 'Ask the project’s agent' : 'Ask the lead agent'} onSubmit={(e) => { e.preventDefault(); send(); }}>
      <div className="nx-intent__row">
        {chip && (
          <span className="nx-intent__chip" title={`Sent with context: ${chip}`}>
            <span className="nx-visually-hidden">Context: </span>{chip}
          </span>
        )}
        <label className="nx-visually-hidden" htmlFor={ids.field}>{mode === 'agent' ? 'Ask the project’s agent' : 'Ask the lead agent'}</label>
        <textarea
          id={ids.field} ref={ta} className="nx-intent__field" rows={1}
          placeholder={mode === 'agent' ? 'Describe a change for the project’s agent' : 'Ask the lead agent to plan, build or fix something'}
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
          <button type="button" className="nx-btn nx-btn--quiet nx-iconbtn" aria-label="Suggestions" title="Suggestions"
            aria-expanded={suggestOpen} aria-controls={ids.pop} onClick={() => setSuggestOpen((v) => !v)}
            onKeyDown={(e) => { if (e.key === 'Escape' && suggestOpen) { e.preventDefault(); e.stopPropagation(); setSuggestOpen(false); } }}>
            <Icon name="sparkles" size={15} />
          </button>
          {suggestOpen && (
            <ul id={ids.pop} className="nx-intent__pop" aria-label="Suggestions"
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
        <button type="submit" className="nx-btn nx-btn--primary" aria-label="Send" disabled={!draft.trim() || sending}>
          <Icon name="send" size={15} /><span className="nx-intent__send-text">Send</span>
        </button>
        {summoned && onClose && (
          <button type="button" className="nx-btn nx-btn--quiet nx-iconbtn" aria-label="Close" title="Close" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        )}
      </div>
      {error && <p id={ids.error} className="nx-intent__error" role="alert">{error}</p>}
      <p id={ids.status} className="nx-intent__status">
        <span>{statusText}</span> <span>{mode === 'agent' ? 'Each message starts a new conversation; follow it in the agent panel on the bench.' : port.replyHint}</span>
        <span role="status">
          {sent && <> {sent.lead} <a href={sent.href}>{sent.label}</a></>}
        </span>
      </p>
    </form>
  );
}
