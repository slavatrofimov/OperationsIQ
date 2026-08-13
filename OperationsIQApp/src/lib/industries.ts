/**
 * Industry taxonomy (functional spec §Playbooks / §Multi-industry).
 *
 * Industries group the domain playbooks in playbooks.ts so an operator can
 * quickly narrow the playbook catalog to their sector. Each industry has
 * a short description and an icon key resolved in the UI. Adding an industry
 * here plus one or more playbooks referencing it is all that is needed to extend
 * the catalog to a new sector.
 */

export type IndustryKey =
  | 'oil_gas'
  | 'power_renewables'
  | 'manufacturing'
  | 'chemicals'
  | 'water'
  | 'mining'
  | 'buildings'
  | 'datacenter'
  | 'pharma'
  | 'food_bev'
  | 'automotive'
  | 'aerospace'
  | 'transportation'
  | 'semiconductor'
  | 'marine'
  | 'agriculture'
  | 'cross_industry';

export interface IndustryInfo {
  key: IndustryKey;
  label: string;
  description: string;
}

export const INDUSTRIES: IndustryInfo[] = [
  { key: 'oil_gas', label: 'Oil & Gas', description: 'Upstream production, midstream pipelines, downstream refining.' },
  { key: 'power_renewables', label: 'Power & Renewables', description: 'Wind, solar, thermal generation, and grid assets.' },
  { key: 'manufacturing', label: 'Discrete Manufacturing', description: 'CNC machining, assembly lines, and robotics cells.' },
  { key: 'chemicals', label: 'Chemicals & Process', description: 'Reactors, distillation, and batch/continuous process units.' },
  { key: 'water', label: 'Water & Wastewater', description: 'Treatment plants, pumping, and distribution networks.' },
  { key: 'mining', label: 'Mining & Metals', description: 'Comminution, materials handling, and smelting.' },
  { key: 'buildings', label: 'Buildings & HVAC', description: 'Chillers, air handlers, and facility energy systems.' },
  { key: 'datacenter', label: 'Data Centers & IT', description: 'Cooling, power distribution, and thermal management.' },
  { key: 'pharma', label: 'Pharma & Life Sciences', description: 'Bioprocess, cold chain, and cleanroom environments.' },
  { key: 'food_bev', label: 'Food & Beverage', description: 'Processing, cold storage, and packaging lines.' },
  { key: 'automotive', label: 'Automotive', description: 'Powertrain test, EV battery, and paint shops.' },
  { key: 'aerospace', label: 'Aerospace & Defense', description: 'Propulsion health and airframe structural monitoring.' },
  { key: 'transportation', label: 'Transportation & Fleet', description: 'Rail, trucking, and vehicle fleet telematics.' },
  { key: 'semiconductor', label: 'Semiconductor', description: 'Fab process tools, chambers, and yield analytics.' },
  { key: 'marine', label: 'Marine & Shipping', description: 'Propulsion, fuel systems, and voyage efficiency.' },
  { key: 'agriculture', label: 'Agriculture & AgTech', description: 'Irrigation, greenhouse climate, and equipment.' },
  {
    key: 'cross_industry',
    label: 'Cross-Industry',
    description:
      'Common business functions — finance, sales, marketing, HR, and more — reframed as time-series playbooks.',
  },
];

export function getIndustry(key: IndustryKey): IndustryInfo | undefined {
  return INDUSTRIES.find((i) => i.key === key);
}

export function industryLabel(key: IndustryKey): string {
  return getIndustry(key)?.label ?? key;
}
