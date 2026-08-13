import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

type Audience = {
  title: string;
  to: string;
  cta: string;
  description: ReactNode;
};

const AudienceList: Audience[] = [
  {
    title: 'For users',
    to: '/user/',
    cta: 'Open the User Guide',
    description: (
      <>
        Explore signals, diagnose issues, forecast, discover patterns, set up
        alerts, and build investigations. Organized to mirror the app so you can
        find the module you are using.
      </>
    ),
  },
  {
    title: 'For administrators',
    to: '/admin/',
    cta: 'Open the Admin Guide',
    description: (
      <>
        Deploy and operate Operations IQ on Microsoft Fabric: Eventhouse schema,
        Entra app registration, Rayfin backend, Spark compute, configuration,
        permissions, and governance.
      </>
    ),
  },
  {
    title: 'For developers',
    to: '/dev/',
    cta: 'Open the Developer Guide',
    description: (
      <>
        Understand the architecture, data model, and KQL/SAX function library —
        and learn how to extend the app with new modules, Matrix Profile recipes,
        and agent tools.
      </>
    ),
  },
];

function AudienceCard({title, to, cta, description}: Audience) {
  return (
    <div className={clsx('col col--4')}>
      <div className={styles.card}>
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
        <Link className="button button--primary" to={to}>
          {cta}
        </Link>
      </div>
    </div>
  );
}

export default function HomepageFeatures(): ReactNode {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {AudienceList.map((props) => (
            <AudienceCard key={props.title} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
