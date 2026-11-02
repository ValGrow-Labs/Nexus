export interface HairlineHost { stage: HTMLElement; svg: SVGSVGElement; read: { textContent: string | null } }
export interface AgentsHandle { set(value: number): void; destroy(): void }
export declare const agents: {
  name: string;
  means: string;
  rules: number[];
  range: [number, number, number];
  mount(host: HairlineHost, value: number): AgentsHandle;
};
