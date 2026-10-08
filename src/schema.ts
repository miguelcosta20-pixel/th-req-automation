import { z } from 'zod';

export const SupplierSchema = z.object({
  id: z.string(),
  name: z.string(),
  vat_id: z.string().nullable(),
  country: z.string(),
  default_currency: z.string(),
  payment_terms_days: z.number(),
  preferred: z.boolean(),
  status: z.enum(['active', 'blocked']),
});

export const CostCentreSchema = z.object({
  code: z.string(),
  name: z.string(),
  owner_employee_id: z.string(),
  department: z.string(),
});

export const DepartmentSchema = z.object({
  code: z.string(),
  name: z.string(),
  head_employee_id: z.string(),
});

export const EmployeeSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(['cost_center_owner', 'department_head', 'finance', 'cfo', 'ceo', 'requester_only']),
  deputy_for: z.string().optional(),
  default_cost_center: z.string().optional(),
});

export const ApprovalBandSchema = z.object({
  from: z.number(),
  to: z.number().nullable(),
  required_roles: z.array(z.string()),
});

export const GlAccountSchema = z.object({
  code: z.string(),
  name: z.string(),
});

const MetaSchema = z.object({
  description: z.string(),
  version: z.number(),
  base_currency: z.string(),
  fx_rates_to_chf: z.record(z.string(), z.number()),
});

const RulesSchema = z.object({
  self_approval_forbidden: z.boolean(),
  duplicate_role_collapses: z.boolean(),
  approvals_are_sequential: z.boolean(),
});

export const MasterDataSchema = z.object({
  _meta: MetaSchema,
  suppliers: z.array(SupplierSchema),
  cost_centers: z.array(CostCentreSchema),
  departments: z.array(DepartmentSchema),
  employees: z.array(EmployeeSchema),
  approval_limits_chf: z.array(ApprovalBandSchema),
  rules: RulesSchema,
  gl_accounts: z.array(GlAccountSchema),
});

export type Supplier = z.infer<typeof SupplierSchema>;
export type CostCentre = z.infer<typeof CostCentreSchema>;
export type Department = z.infer<typeof DepartmentSchema>;
export type Employee = z.infer<typeof EmployeeSchema>;
export type ApprovalBand = z.infer<typeof ApprovalBandSchema>;
export type GlAccount = z.infer<typeof GlAccountSchema>;
export type MasterData = z.infer<typeof MasterDataSchema>;

// ── LLM extraction output ─────────────────────────────────────────────────────

const SUPPORTED_CURRENCIES = ['CHF', 'EUR', 'USD', 'GBP'] as const;

const ExtractionLineItemSchema = z.object({
  description: z.string(),
  quantity:    z.number().nullable(),
  unit:        z.string().nullable(),
  unit_price:  z.number().nullable(),
  price_basis: z.enum(['per_unit', 'per_100']).nullable().optional(),
  currency:    z.enum(SUPPORTED_CURRENCIES).nullable().optional(),
  item_code:   z.string().nullable().optional(),   // supplier part/material number, when the line states one
});

// Delivery requirement as understood from natural language. The LLM only
// classifies and quotes; it never computes or invents a date. Deterministic code
// (src/delivery.ts) turns `explicit`/`relative` into a concrete date; `urgency`
// and `none` carry no date and route to clarification.
export const DeliverySchema = z.object({
  // explicit = a concrete calendar date is stated; relative = a timeframe like
  // "next week" / "6 weeks ex works"; urgency = ASAP/urgent with no timeframe;
  // none = nothing about delivery is said.
  kind:          z.enum(['explicit', 'relative', 'urgency', 'none']),
  explicit_date: z.string().nullable(),                      // ISO YYYY-MM-DD, only when kind=explicit
  timeframe:     z.string().nullable(),                      // raw phrase for relative/urgency
  urgency:       z.enum(['high', 'normal', 'low']).nullable(),
  evidence:      z.string().nullable(),                      // verbatim quote the classification rests on
  reasoning:     z.string().nullable(),                      // one sentence on how it was classified
});

export const ExtractionSchema = z.object({
  requester_name:        z.string().nullable(),
  requester_email:       z.string().nullable(),
  supplier_name:         z.string().nullable(),
  currency:              z.enum(SUPPORTED_CURRENCIES).nullable(),
  cost_centre_hint:      z.string().nullable().optional(),
  category_hint:         z.string().nullable().optional(),   // generic purchasing category of the goods, for GL determination
  delivery:              DeliverySchema.optional(),
  line_items:            z.array(ExtractionLineItemSchema),
  notes:                 z.string().nullable().optional(),
  // Populated by the LLM when it detects social-engineering / prompt-injection
  // attempts in the email. The value is copied verbatim; the pipeline routes it
  // to the security queue. The field must exist but is null in normal emails.
  instructions_to_reader: z.string().nullable().optional(),
  field_confidence:      z.record(z.string(), z.number().min(0).max(1)),
});

export type Extraction = z.infer<typeof ExtractionSchema>;
export type ExtractionLineItem = z.infer<typeof ExtractionLineItemSchema>;
export type Delivery = z.infer<typeof DeliverySchema>;

// ── PO API request / response ─────────────────────────────────────────────────

const PoLineItemSchema = z.object({
  item_name:  z.string(),
  quantity:   z.number(),
  unit_price: z.number(),
  unit:       z.string(),
  item_code:  z.string().optional(),
});

export const PoRequestSchema = z.object({
  supplier_id:             z.string(),
  currency:                z.enum(SUPPORTED_CURRENCIES),
  total:                   z.number(),
  requested_delivery_date: z.string(),
  line_items:              z.array(PoLineItemSchema),
  cost_centre:             z.string().optional(),
  gl_account:              z.string().optional(),
  tax_amount:              z.number().optional(),
  requisition_reference:   z.string().optional(),
});

export const PoResponseSchema = z
  .object({ po_number: z.string(), status: z.string() })
  .passthrough();

export type PoRequest  = z.infer<typeof PoRequestSchema>;
export type PoResponse = z.infer<typeof PoResponseSchema>;
