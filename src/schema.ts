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
export type MasterData = z.infer<typeof MasterDataSchema>;
