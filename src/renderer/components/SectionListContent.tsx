import type { ReactNode } from 'react';
import type { SectionFixture } from '../mocks/operationalList.fixtures';

type SectionListContentProps<T> = {
  section: SectionFixture<T>;
  itemLabel: string;
  itemKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
};

export function SectionListContent<T>({ section, itemLabel, itemKey, renderItem }: SectionListContentProps<T>) {
  switch (section.state) {
    case 'loading':
      return <StateMessage title="Carregando" message={section.message ?? `A leitura de ${itemLabel} está em andamento.`} tone="pending" />;
    case 'error':
      return <StateMessage title="Falha na leitura" message={section.message ?? `Não foi possível carregar ${itemLabel}.`} reasons={section.reasons} tone="error" />;
    case 'empty':
      return <StateMessage title={`Sem itens de ${itemLabel} nesta leitura`} message={section.message ?? 'A leitura foi concluída sem itens.'} reasons={section.reasons} tone="empty" />;
    case 'ready':
      return section.items.length > 0
        ? <ItemList items={section.items} itemKey={itemKey} renderItem={renderItem} metadata={section} />
        : <StateMessage title="Leitura concluída" message={section.message ?? `O snapshot atual não contém ${itemLabel}.`} metadata={section} tone="empty" />;
    case 'partial':
      return <>
        <StateMessage title="Dados parciais" message={section.message ?? 'Alguns itens ou campos não estão disponíveis.'} reasons={section.reasons} metadata={section} tone="partial" />
        {section.items.length > 0 && <ItemList items={section.items} itemKey={itemKey} renderItem={renderItem} />}
      </>;
    case 'stale':
      return <>
        <StateMessage title="Snapshot desatualizado" message={section.message ?? 'Mostrando o último snapshot identificado.'} reasons={section.reasons} metadata={section} tone="stale" />
        {section.items.length > 0 && <ItemList items={section.items} itemKey={itemKey} renderItem={renderItem} />}
      </>;
  }
}

function ItemList<T>({ items, itemKey, renderItem, metadata }: { items: T[]; itemKey: (item: T) => string; renderItem: (item: T) => ReactNode; metadata?: SectionFixture<T> }) {
  return <>
    <ul className="section-items">{items.map((item) => <li key={itemKey(item)}>{renderItem(item)}</li>)}</ul>
    {metadata && <SectionMetadata section={metadata} />}
  </>;
}

export function SectionMetadata<T>({ section }: { section: SectionFixture<T> }) {
  const parts = [
    section.updatedAt ? `Atualizado ${new Date(section.updatedAt).toLocaleString('pt-BR')}` : null,
    section.asOfSequence !== undefined ? `Até sequência ${section.asOfSequence}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? <p className="section-metadata">{parts.join(' · ')}</p> : null;
}

export function StateMessage<T>({ title, message, reasons, metadata, tone }: {
  title: string;
  message: string;
  reasons?: string[];
  metadata?: SectionFixture<T>;
  tone: 'pending' | 'error' | 'empty' | 'partial' | 'stale';
}) {
  return <div className={`section-state section-state-${tone}`}>
    <span className="section-state-mark" aria-hidden="true">{tone === 'error' ? '!' : tone === 'pending' ? '·' : '—'}</span>
    <div className="section-state-copy">
      <h3>{title}</h3>
      <p>{message}</p>
      {reasons?.map((reason, index) => <p className="section-state-reason" key={index}>{reason}</p>)}
      {metadata && <SectionMetadata section={metadata} />}
    </div>
  </div>;
}
