import { useEffect, useRef, useState } from 'react';
import { HL } from './kernel';
import { agents } from './agents';

/** The Agents figure, hosted the way Hairline's bench hosts a figure: a stage,
 *  an svg, and a read-out under it naming the agent the pointer is on and what it is doing. */
export function AgentsStage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [read, setRead] = useState('rest');

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    HL.inject(document);
    stage.setAttribute('data-hairline', agents.name);
    const svg = HL.mk('svg', { viewBox: '0 0 400 320', 'aria-hidden': 'true' }, stage) as SVGSVGElement;
    let text: string | null = 'rest';
    const h = agents.mount({
      stage, svg,
      read: {
        get textContent() { return text; },
        set textContent(v: string | null) { text = v ?? ''; setRead(text); }
      }
    }, agents.range[1]);
    return () => { h.destroy(); svg.remove(); };
  }, []);

  return (
    <div className="nx-welcome__plate">
      <div ref={stageRef} className="nx-welcome__stage" role="img" aria-label={agents.means} />
      <span className="nx-welcome__tag" aria-hidden="true">{read === 'rest' ? 'a lead agent and three helpers, at work' : read}</span>
    </div>
  );
}
