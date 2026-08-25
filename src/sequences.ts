export type SequenceVariantInput = {
  subject: string;
  body: string;
  variant_label?: string;
};

export type SequenceStepInput = {
  delay: number;
  subject?: string;
  body?: string;
  variants?: SequenceVariantInput[];
};

function defaultVariantLabel(index: number): string {
  // A, B, ... Z, then AA, AB... if ever needed
  let n = index;
  let label = "";
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

/**
 * Build a Smartlead POST /campaigns/{id}/sequences step payload.
 * Multi-variant steps use native `sequence_variants` (matching live GET shape).
 * Single-variant steps keep subject/email_body on the step itself.
 */
export function buildSequencePayload(
  step: SequenceStepInput,
  seqNumber: number
): Record<string, unknown> {
  const base = {
    id: null,
    seq_number: seqNumber,
    seq_delay_details: { delay_in_days: step.delay },
  };

  if (step.variants && step.variants.length > 0) {
    return {
      ...base,
      // Live GET returns `sequence_variants`; POST accepts `seq_variants`.
      // Keep top-level subject/body empty for multi-variant steps.
      subject: "",
      email_body: "",
      seq_variants: step.variants.map((variant, index) => ({
        subject: variant.subject,
        email_body: variant.body,
        variant_label: variant.variant_label || defaultVariantLabel(index),
      })),
    };
  }

  return {
    ...base,
    subject: step.subject ?? "",
    email_body: step.body ?? "",
  };
}
