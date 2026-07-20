import { z } from 'zod';

// Validates the `template` jsonb column on organization_quotation_settings —
// the per-section quotation template config. Mirror of the shapes in
// frontend/src/lib/quotationTemplate.ts; keep the two in sync. Structurally
// parallel to backend/src/lib/invoiceTemplateSchema.ts, but independent (a
// quotation is not an invoice) and narrower: no payment-related fields exist
// anywhere in this shape, since a quotation never has payments.

const customFieldRow = z.object({
  id: z.string().min(1).max(40),
  label: z.string().trim().min(1).max(60),
  value: z.string().trim().min(1).max(200),
});

const paragraphRow = z.object({
  id: z.string().min(1).max(40),
  text: z.string().trim().min(1).max(1000),
});

const pageConfig = z.object({
  preset: z.enum(['A4', 'Letter', 'Legal', 'A5', 'custom']),
  widthMm: z.number().min(148).max(216),
  heightMm: z.number().min(210).max(356),
});

export const quotationTemplateSchema = z.object({
  version: z.literal(1),
  preset: z.enum(['classic', 'modern', 'minimal', 'custom']),
  page: pageConfig,
  sections: z.object({
    header: z.object({
      variant: z.enum(['classic', 'banner', 'centered', 'compact']),
    }),
    quoteDetails: z.object({
      variant: z.enum(['columns', 'stacked', 'boxed']),
      showExpiryDate: z.boolean(),
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
      }),
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
