import { readFileSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';
import { MasterDataSchema } from './schema';
import type { MasterData } from './schema';

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

export function loadConfig(configPath: string): AppConfig {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  const cfg = CustomerConfigSchema.parse(raw);

  // Resolve master data path relative to CWD (CLI runs from project root)
  const mdPath = resolve(process.cwd(), cfg.masterDataPath);
  const masterData = MasterDataSchema.parse(JSON.parse(readFileSync(mdPath, 'utf-8')));

  return { ...cfg, masterData };
}
