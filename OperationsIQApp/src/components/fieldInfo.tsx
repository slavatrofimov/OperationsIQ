import { InfoLabel, type InfoLabelProps } from '@fluentui/react-components';
import type { ReactNode } from 'react';

/**
 * Build a Fluent `Field` `label` slot override that appends an info popover
 * button to the label text. Usage:
 *
 * ```tsx
 * <Field label={withInfo('Alphabet size', 'Plain-language explanation…')}>
 *   <Input … />
 * </Field>
 * ```
 *
 * The render-function form REPLACES the default `Label` root with an
 * `InfoLabel`, so the Field's `htmlFor`/id wiring is preserved and no invalid
 * nested `<label>` is produced.
 */
export function withInfo(label: ReactNode, info: InfoLabelProps['info']) {
  return {
    children: (_: unknown, slotProps: Record<string, unknown>) => (
      <InfoLabel {...slotProps} info={info}>
        {label}
      </InfoLabel>
    ),
  };
}
