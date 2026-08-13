import { Dropdown, Field, Input, Option, Slider } from '@fluentui/react-components';
import type { LabelCategory } from '../../lib/mp/types';

/**
 * The shared editable fields of a label — Name, Category, and Confidence. Reused by the
 * inline create form ({@link LabelLayer}) and the click-to-edit dialog
 * ({@link LabelEditDialog}) so the two stay visually and behaviorally identical.
 */
export function LabelFields({
  text,
  onText,
  categoryId,
  onCategoryId,
  confidence,
  onConfidence,
  categories,
  kind,
}: {
  text: string;
  onText: (v: string) => void;
  categoryId: string;
  onCategoryId: (v: string) => void;
  confidence: number;
  onConfidence: (v: number) => void;
  categories: LabelCategory[];
  kind: 'MOTIF' | 'DISCORD';
}) {
  const category = categories.find((c) => c.id === categoryId);
  return (
    <>
      <Field label="Name">
        <Input
          value={text}
          placeholder={kind === 'MOTIF' ? 'e.g. Healthy pump cycle' : 'e.g. Bearing spall'}
          onChange={(_, d) => onText(d.value)}
        />
      </Field>

      <Field label="Category">
        <Dropdown
          value={category?.name ?? 'Uncategorized'}
          selectedOptions={[categoryId]}
          onOptionSelect={(_, d) => onCategoryId(d.optionValue ?? '')}
        >
          <Option value="">Uncategorized</Option>
          {categories.map((c) => (
            <Option key={c.id} value={c.id}>
              {c.name}
            </Option>
          ))}
        </Dropdown>
      </Field>

      <Field label={`Confidence: ${Math.round(confidence * 100)}%`}>
        <Slider
          min={0}
          max={1}
          step={0.05}
          value={confidence}
          onChange={(_, d) => onConfidence(d.value)}
        />
      </Field>
    </>
  );
}
