import { z } from 'zod';

// Validates the `template` jsonb column on organization_invoice_settings —
// the per-section invoice template config. Mirror of the shapes in
// frontend/src/lib/invoiceTemplate.ts; keep the two in sync. version is a
// literal so a future shape change bumps to 2 with a widened union here.

const customFieldRow = z.object({
  id: z.string().min(1).max(40),
  label: z.string().trim().min(1).max(60),
  value: z.string().trim().min(1).max(200),
});

const paragraphRow = z.object({
  id: z.string().min(1).max(40),
  text: z.string().trim().min(1).max(1000),
});

export const invoiceTemplateSchema = z.object({
  version: z.literal(1),
  preset: z.enum(['classic', 'modern', 'minimal', 'custom']),
  sections: z.object({
    header: z.object({
      variant: z.enum(['classic', 'banner', 'centered', 'compact']),
    }),
    billDetails: z.object({
      variant: z.enum(['columns', 'stacked', 'boxed']),
      showDueDate: z.boolean(),
      showStatus: z.boolean(),
      customRows: z.array(customFieldRow).max(8),
    }),
    lineItems: z.object({
      variant: z.enum(['ruled', 'striped', 'minimal']),
    }),
    totals: z.object({
      variant: z.enum(['simple', 'panel', 'boldTotal']),
      rows: z.object({
        subtotal: z.boolean(),
        discount: z.boolean(),
        tax: z.boolean(),
        paid: z.boolean(),
        balance: z.boolean(),
      }),
      showPaymentHistory: z.boolean(),
    }),
    notes: z.object({
      variant: z.enum(['plain', 'boxed', 'divided']),
      paragraphs: z.array(paragraphRow).max(6),
    }),
    footer: z.object({
      variant: z.enum(['simple', 'centered', 'accentBar']),
      paragraphs: z.array(paragraphRow).max(6),
    }),
  }),
});
