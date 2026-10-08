import { readFileSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';
import { MasterDataSchema } from './schema';
import type { MasterData, ApprovalBand, Employee } from './schema';

export interface Thresholds {
  autoConfidence: number;
  clarifyFloor: number;
  pdfPageLimit: number;
  defaultDeliveryLeadDays: number;
}

export interface CustomerConfig {
  customer: string;
  masterDataPath: string;
  poApiUrl: string;
  dbPath: string;
  thresholds: Thresholds;
  models: { extraction: string };
}

export interface AppConfig extends CustomerConfig {
  masterData: MasterData;
}

const CustomerConfigSchema = z.object({
  customer: z.string(),
  masterDataPath: z.string(),
  poApiUrl: z.string().url(),
  dbPath: z.string(),
  thresholds: z.object({
    autoConfidence: z.number().min(0).max(1),
    clarifyFloor: z.number().min(0).max(1),
    pdfPageLimit: z.number().int().positive(),
    defaultDeliveryLeadDays: z.number().int().nonnegative(),
  }),
  models: z.object({
    extraction: z.string(),
  }),
});

// Validates approval band integrity at startup so a misconfigured master data
// file fails loudly rather than silently routing totals to the wrong approver.
//
// Rules checked:
//   1. Must have at least one band.
//   2. Only the last band may have to: null (open-ended ceiling).
//   3. Bands must be ordered by ceiling (to) ascending.
//   4. Each band's from must be less than or equal to its to (where to is not null).
//   5. No two consecutive bands may overlap (band[N+1].from <= band[N].to).
export function validateBands(bands: ApprovalBand[]): void {
  if (bands.length === 0) throw new Error('approval_limits_chf must have at least one band');

  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    const isLast = i === bands.length - 1;

    if (!isLast && b.to === null) {
      throw new Error(
        `Band ${i + 1} (from ${b.from}) has to: null but is not the last band — only the final band may be open-ended`,
      );
    }
    if (b.to !== null && b.from > b.to) {
      throw new Error(`Band ${i + 1} has from (${b.from}) > to (${b.to})`);
    }
    if (i > 0) {
      const prev = bands[i - 1];
      if (prev.to !== null && b.to !== null && b.to <= prev.to) {
        throw new Error(
          `Bands are not ordered: band ${i + 1} (to ${b.to}) must be greater than band ${i} (to ${prev.to})`,
        );
      }
      if (prev.to !== null && b.from <= prev.to) {
        throw new Error(
          `Bands ${i} and ${i + 1} overlap: band ${i} ends at ${prev.to}, band ${i + 1} starts at ${b.from}`,
        );
      }
    }
  }
}

// Checks that exactly one primary employee exists for each singleton role
// (finance, cfo, ceo). Deputies (deputy_for is set) are excluded from the count.
// A missing primary means the approval chain fails at runtime for every
// requisition in that band; two primaries means the chain uses whichever
// employees.find() happens to return first — both silent correctness risks.
export function validateSingletonRoles(employees: Employee[]): void {
  for (const role of ['finance', 'cfo', 'ceo'] as const) {
    const primaries = employees.filter(e => e.role === role && !e.deputy_for);
    if (primaries.length !== 1) {
      throw new Error(
        `Expected exactly 1 primary ${role} in employees, found ${primaries.length}` +
        (primaries.length > 1 ? ` (${primaries.map(e => e.id).join(', ')})` : ''),
      );
    }
  }
}

export function loadConfig(configPath: string): AppConfig {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  const cfg = CustomerConfigSchema.parse(raw);

  // Resolve master data path relative to CWD (CLI runs from project root)
  const mdPath = resolve(process.cwd(), cfg.masterDataPath);
  const masterData = MasterDataSchema.parse(JSON.parse(readFileSync(mdPath, 'utf-8')));

  validateBands(masterData.approval_limits_chf);
  validateSingletonRoles(masterData.employees);

  return { ...cfg, masterData };
}