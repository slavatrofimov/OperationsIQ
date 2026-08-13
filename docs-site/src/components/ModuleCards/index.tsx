import React from 'react';
import Link from '@docusaurus/Link';

export interface ModuleCard {
  title: string;
  to: string;
  desc?: string;
}

export interface ModuleCardsProps {
  items: ModuleCard[];
}

export default function ModuleCards({items}: ModuleCardsProps): React.ReactElement {
  return (
    <div className="oiq-card-grid">
      {items.map((item) => (
        <Link key={item.to} className="oiq-card" to={item.to}>
          <div className="oiq-card__title">{item.title}</div>
          {item.desc ? <p className="oiq-card__desc">{item.desc}</p> : null}
        </Link>
      ))}
    </div>
  );
}
