import { useEffect, useMemo, useRef, useState } from 'react';
import { WORKSPACES } from '../workspaces/registry';
import { provenanceStyle } from '../ui/ProvenanceMark';
import { navigate } from '../router/useRoute';
import { useNexusUi, type Audience } from '../state/uiStore';
import { detectEnvironment, IDEAS, PLAIN_IDEAS } from '../start/startModel';
import { AgentsStage } from '../hairline/AgentsStage';

const CHOICES: { id: Audience; title: string; body: string }[] = [
  { id: 'technical', title: "I'm technical", body: "I'm comfortable with code, terminals and git, and I want to see every change." },
  { id: 'nontechnical', title: "I'm not technical", body: 'I describe what I want in plain words. Nexus and its agents take care of the code.' }
];

type Step = 'intro' | 'about' | 'work';

/** The first screen of every launch: the pitch, the agents at work, and one big
 *  Get started. App shows it before the config picker; Welcome shows it again
 *  when reopened from the menu. */
export function WelcomeIntro({ onStart }: { onStart: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return (
    <div className="nx-page nx-welcome nx-welcome--intro">
      <div className="nx-welcome__pitch">
        <span className="nx-welcome__eyebrow">Welcome to Nexus</span>
        <h1 ref={heading} tabIndex={-1}>Say what you want built.<br />A team of agents builds it.</h1>
        <p className="nx-welcome__lede">
          Describe your work in one sentence. Nexus picks the right workspace, a lead agent plans it, helpers do the work
          on this computer, and you approve every change before it is kept.
        </p>
        <button type="button" className="nx-welcome__go" onClick={onStart}>Get started</button>
      </div>
      <figure className="nx-welcome__figure">
        <AgentsStage />
      </figure>
    </div>
  );
}

/** Welcome: the intro, in three steps. A big Get started, then "Which sounds
 *  like you?", then "What are you working on?" with examples for that answer.
 *  Every launch opens on the intro (shown by App, before the config picker);
 *  Home then continues here from `startAt`. The menu reopens it from the intro.
 *  Once finished, Home is Start for that session.
 *  Nothing is sent from here: the sentence is carried over to Start. */
export function WelcomePage({ startAt = 'intro' }: { startAt?: Step }) {
  const [step, setStep] = useState<Step>(startAt);
  const [text, setText] = useState('');
  const audience = useNexusUi((s) => s.audience);
  const setAudience = useNexusUi((s) => s.setAudience);
  const setPrefill = useNexusUi((s) => s.setStartPrefill);
  const finishWelcome = useNexusUi((s) => s.finishWelcome);
  const heading = useRef<HTMLHeadingElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // each step takes focus on its heading, or on the request box on the last step
  useEffect(() => { (step === 'work' ? input.current : heading.current)?.focus(); }, [step]);

  const detection = useMemo(() => detectEnvironment(text), [text]);
  const ws = detection.id ? WORKSPACES.find((w) => w.id === detection.id) ?? null : null;
  const plain = audience !== 'technical';

  const finish = () => { setPrefill(text.trim() || null); finishWelcome(); navigate({ name: 'home' }); };
  const choose = (a: Audience) => { setAudience(a); setStep('work'); };

  // A person who already answered "Which sounds like you?" is not asked again: Get started goes straight on.
  if (step === 'intro') return <WelcomeIntro onStart={() => setStep(audience ? 'work' : 'about')} />;

  if (step === 'about') {
    return (
      <div className="nx-page nx-welcome nx-welcome--step">
        <div className="nx-welcome__card">
          <span className="nx-welcome__eyebrow">Step 1 of 2</span>
          <h1 ref={heading} tabIndex={-1}>Which sounds like you?</h1>
          <p className="nx-welcome__lede">This only changes the examples and wording you see. You can use every part of Nexus either way.</p>
          <div className="nx-welcome__choices" role="group" aria-label="Which sounds like you?">
            {CHOICES.map((c) => (
              <button key={c.id} type="button" className={`nx-welcome__choice${audience === c.id ? ' is-on' : ''}`} onClick={() => choose(c.id)}>
                <b>{c.title}</b>
                <span>{c.body}</span>
              </button>
            ))}
          </div>
          <div className="nx-welcome__nav">
            <button type="button" className="nx-btn nx-btn--quiet" onClick={() => setStep('intro')}>Back</button>
          </div>
        </div>
      </div>
    );
  }

  const ideas = plain ? PLAIN_IDEAS : IDEAS;
  return (
    <div className="nx-page nx-welcome nx-welcome--step">
      <form className="nx-welcome__card" onSubmit={(e) => { e.preventDefault(); if (text.trim()) finish(); }}>
        <span className="nx-welcome__eyebrow">Step 2 of 2</span>
        <h1 ref={heading} tabIndex={-1}>What are you working on?</h1>
        <p className="nx-welcome__lede">
          {plain ? 'Write it the way you would tell a colleague. One sentence is enough.' : 'One sentence. Clue words pick the workspace, and you can change it on the next screen.'}
        </p>
        <label className="nx-visually-hidden" htmlFor="nx-welcome-req">What are you working on?</label>
        <input id="nx-welcome-req" ref={input} className="nx-welcome__req" type="text" value={text} spellCheck={false} autoComplete="off"
          placeholder={plain ? 'For example: a website for my bakery' : 'For example: train a model to classify support emails'}
          onChange={(e) => setText(e.target.value)} />
        <p className="nx-welcome__verdict" aria-live="polite" style={ws ? provenanceStyle(ws.hueSlot) : undefined}>
          {!text.trim() ? (plain ? 'Not sure? Pick an example below.' : 'Describe what you want to work on.')
            : !ws ? (plain ? 'Add a few more words about what you want, or pick an example.' : 'No clue words yet, so no workspace is picked. You can choose one on the next screen.')
            : plain ? <><i aria-hidden="true" />This goes to the <b>{ws.name}</b> workspace.</>
            : <>
                <i aria-hidden="true" />
                <b>{ws.name}</b>
                <span className={`nx-welcome__conf nx-welcome__conf--${detection.confidence}`}>{detection.confidence === 'strong' ? 'strong match' : 'weak match, check it'}</span>
                {detection.matched.map((w, i) => <code key={`${w}-${i}`}>{w}</code>)}
              </>}
        </p>
        <div className="nx-welcome__ideas" aria-label="Examples">
          {ideas.map((idea) => (
            <button key={idea.label} type="button" className="nx-wb__idea" onClick={() => { setText(idea.prompt); input.current?.focus(); }}>{idea.label}</button>
          ))}
        </div>
        <div className="nx-welcome__nav">
          <button type="button" className="nx-btn nx-btn--quiet" onClick={() => setStep('about')}>Back</button>
          <span className="nx-welcome__spacer" />
          <button type="button" className="nx-btn nx-btn--quiet" onClick={() => { finishWelcome(); navigate({ name: 'home' }); }}>Skip for now</button>
          <button type="submit" className="nx-welcome__go nx-welcome__go--sm" disabled={!text.trim()}>Continue</button>
        </div>
      </form>
    </div>
  );
}
