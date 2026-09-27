import type { ReactNode } from 'react';

type OperationalSectionProps = {
  title: string;
  description: string;
  marker: string;
  children: ReactNode;
  className?: string;
};

export function OperationalSection({ title, description, marker, children, className = '' }: OperationalSectionProps) {
  return (
    <section className={`operational-section ${className}`}>
      <header className="section-heading">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <span className="section-marker">{marker}</span>
      </header>
      {children}
    </section>
  );
}
