/** The top of the project page: the project and what kind of work it is (the saved version is in the work area and Details). */
export function ProjectHeader({ name, kind }: { name: string; kind: string }) {
  return (
    <header className="nx-phead" aria-label="About this project">
      <p className="nx-phead__name">{name}</p>
      <p className="nx-phead__meta"><span>{kind}</span></p>
    </header>
  );
}
