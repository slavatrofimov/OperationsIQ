/**
 * The canonical enumeration of app page keys. Used across navigation, personas,
 * playbooks, the agent UI-control bus, and evidence capture to identify which
 * page is active.
 */

export type PageKey =
  | 'explore'
  | 'liveview'
  | 'similarity'
  | 'forecast'
  | 'discover'
  | 'classifiers'
  | 'patterns'
  | 'compare'
  | 'calendar'
  | 'trendvolatility'
  | 'segmentation'
  | 'derived'
  | 'sonify'
  | 'monitor'
  | 'controlchart'
  | 'regression'
  | 'rootcause'
  | 'causality'
  | 'decompose'
  | 'changepoints'
  | 'spectrum'
  | 'processmining'
  | 'scenario'
  | 'validation'
  | 'metadata'
  | 'activatorAlerts'
  | 'alerts'
  | 'playbooks'
  | 'investigations'
  | 'config';
