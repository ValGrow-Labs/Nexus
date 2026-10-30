import { useCallback, useRef, useState } from 'react';
import { nexusClient } from '../data/nexusClient';
import { errorCopy } from '../data/errorCopy';
import { usePlatform } from '../data/platformStore';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';
import { kindLabelIn } from './artifactModel';
import { derivedName, nextCriterionId, problemContent, requirementContent, type ProblemDraft, type RequirementDraft } from './actionModel';

/** Write a requirement (title, body, acceptance criteria with stable ids) or a problem statement (question, context,
 *  audience, success criteria, constraints). Saving makes a draft; main checks it, and Mark as ready in the item's
 *  details finishes it. */
export function RequirementSheet({ projectId, workspaceId, kind, onClose, onSaved }: {
  projectId: string; workspaceId: string; kind: 'requirement' | 'problem_statement';
  onClose: () => void; onSaved: (artifactId: string) => void;
}) {
  const bumpRev = usePlatform((s) => s.bumpRev);
  const word = kindLabelIn(kind, workspaceId);
  const [name, setName] = useState('');
  const [req, setReq] = useState<RequirementDraft>({ title: '', body: '', criteria: [{ id: 'C1', text: '' }] });
  const [prob, setProb] = useState<ProblemDraft>({ question: '', context: '', audience: '', successCriteria: [], constraints: [] });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  pendingRef.current = pending;
  const safeClose = useCallback(() => { if (!pendingRef.current) onClose(); }, [onClose]);
  const lines = (s: string) => s.split('\n');

  const save = async () => {
    if (pending) return;
    const built = kind === 'requirement' ? requirementContent(req) : problemContent(prob);
    if ('problem' in built) { setError(built.problem); return; }
    const title = derivedName(name, kind === 'requirement' ? req.title : prob.question);
    setPending(true); setError(null);
    const r = await nexusClient.artifactSaveInline({ projectId, workspaceId, kind, target: { name: title }, content: built.content });
    setPending(false);
    if (!r.ok) { setError(errorCopy(r.code, r.reason, r.subReason).text); return; }
    bumpRev();
    onSaved(r.data.artifact.id);
  };

  return (
    <Sheet open onClose={safeClose} labelledBy="nx-xw-title" focusHeading>
      <form className="nx-svx" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <header className="nx-svx__head">
          <p className="nx-svx__kind">New draft</p>
          <h2 id="nx-xw-title" className="nx-svx__title">Write a {word.toLowerCase()}</h2>
        </header>
        <label className="nx-svx__field"><span className="nx-svx__label">Name</span>
          <input className="nx-input nx-svx__control" value={name} maxLength={120} placeholder="Optional; the title is used otherwise" onChange={(e) => setName(e.target.value)} /></label>
        {kind === 'requirement' ? (
          <>
            <label className="nx-svx__field"><span className="nx-svx__label">Title</span>
              <input className="nx-input nx-svx__control" value={req.title} maxLength={200} onChange={(e) => setReq({ ...req, title: e.target.value })} /></label>
            <label className="nx-svx__field"><span className="nx-svx__label">Description</span>
              <textarea className="nx-input nx-svx__control" rows={4} value={req.body} onChange={(e) => setReq({ ...req, body: e.target.value })} /></label>
            <fieldset className="nx-svx__field"><legend className="nx-svx__label">How you will know it works</legend>
              {req.criteria.map((c, i) => (
                <label key={c.id} className="nx-xw__crit"><span className="nx-id">{c.id}</span>
                  <input className="nx-input nx-svx__control" value={c.text} maxLength={2000} aria-label={`Point ${c.id}`}
                    onChange={(e) => setReq({ ...req, criteria: req.criteria.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)) })} />
                </label>
              ))}
              {req.criteria.length < 100 && <Button variant="quiet" onClick={() => setReq({ ...req, criteria: [...req.criteria, { id: nextCriterionId(req.criteria), text: '' }] })}>Add another point</Button>}
            </fieldset>
          </>
        ) : (
          <>
            <label className="nx-svx__field"><span className="nx-svx__label">Question</span>
              <textarea className="nx-input nx-svx__control" rows={3} maxLength={2000} value={prob.question} onChange={(e) => setProb({ ...prob, question: e.target.value })} /></label>
            <label className="nx-svx__field"><span className="nx-svx__label">Background</span>
              <textarea className="nx-input nx-svx__control" rows={3} value={prob.context} onChange={(e) => setProb({ ...prob, context: e.target.value })} /></label>
            <label className="nx-svx__field"><span className="nx-svx__label">Who it is for</span>
              <input className="nx-input nx-svx__control" maxLength={200} value={prob.audience} onChange={(e) => setProb({ ...prob, audience: e.target.value })} /></label>
            <label className="nx-svx__field"><span className="nx-svx__label">What a good answer looks like, one per line</span>
              <textarea className="nx-input nx-svx__control" rows={3} value={prob.successCriteria.join('\n')} onChange={(e) => setProb({ ...prob, successCriteria: lines(e.target.value) })} /></label>
            <label className="nx-svx__field"><span className="nx-svx__label">Limits to keep in mind, one per line</span>
              <textarea className="nx-input nx-svx__control" rows={3} value={prob.constraints.join('\n')} onChange={(e) => setProb({ ...prob, constraints: lines(e.target.value) })} /></label>
          </>
        )}
        <p className="nx-muted">It is saved as a draft first. Nexus checks it, and then you can press "Mark as ready".</p>
        {error && <p className="nx-passport__note" role="alert">{error}</p>}
        <div className="nx-svx__actions">
          <Button type="submit" variant="primary" disabled={pending}>{pending ? 'Saving…' : 'Save draft'}</Button>
          <Button disabled={pending} onClick={safeClose}>Cancel</Button>
        </div>
      </form>
    </Sheet>
  );
}
