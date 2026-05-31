import path from 'path';
import os from 'os';
import type { Tier } from '../registry/types.js';

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'automategs');
export const SCRIPTS_DIR = path.join(CONFIG_DIR, 'scripts');
export const REGISTRY_PATH = path.join(CONFIG_DIR, 'projects.json');
export const TEMPLATE_CACHE_PATH = path.join(CONFIG_DIR, 'template-cache.json');
export const CLASPRC_PATH = path.join(os.homedir(), '.clasprc.json');

export const VALIDATION_URL =
  'https://script.google.com/macros/s/AKfycbxbkigI3_I3OWbqP9MyunTKGaF-cJtNirjm1F5xwlPjzC3lGzrzv9Ece731ajR7LLqPSg/exec';

export const PLAN_TIER_MAP: Record<string, Tier> = {
  'AutomateGS-Pro-USD-Monthly': 'pro',
  'AutomateGS-Agency-USD-Monthly': 'agency',
};

export const FREE_TIER_PROJECT_LIMIT = 1;
export const FREE_TIER_EXECUTION_LIMIT = 10;

export const PORT_RANGE_START = 9742;
export const PORT_RANGE_END = 9751;

export const APPS_SCRIPT_SETTINGS_URL =
  'https://script.google.com/home/usersettings';

export const GITHUB_CLIENT_ID =
  process.env.GITHUB_CLIENT_ID ?? 'Ov23liVJN6wyWPstvcGu';

export const TEMPLATE_REGISTRY_URL =
  'https://thedatastudents.github.io/automategs-templates/registry.json';
export const TEMPLATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const MAX_OUTPUT_LINES = 1000;
export const MAX_OUTPUT_BYTES = 50 * 1024;
export const EXECUTION_TIMEOUT_MS = 5 * 60 * 1000;

export const CLASP_CLIENT_ID =
  '1072944905499-vm2v2i5dvn0a0d2o4ca36i1vge8cvbn0.apps.googleusercontent.com';
export const CLASP_CLIENT_SECRET = 'v6V3fKV_zWU7iw1DrpO1rknX';

export const UPGRADE_URL = 'https://thedatastudents.com/automategs';
