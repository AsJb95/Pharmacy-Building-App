'use strict';

const PRODUCTION_SUPABASE_URL = 'https://yrgtnhvnwkqudxdcrkhm.supabase.co';

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function resolveSupabaseConfig(env = process.env) {
  const environmentName = String(env.VHC_SUPABASE_ENVIRONMENT || env.VHC_SUPABASE_ENV || 'PRODUCTION').trim().toUpperCase();
  const isTest = environmentName === 'TEST';
  const isProduction = environmentName === 'PRODUCTION';
  const supabaseUrl = isTest ? String(env.VHC_TEST_SUPABASE_URL || '').trim() : (isProduction ? String(env.VHC_SUPABASE_URL || PRODUCTION_SUPABASE_URL).trim() : '');
  const supabaseAnonKey = isTest ? String(env.VHC_TEST_SUPABASE_ANON_KEY || '').trim() : (isProduction ? String(env.VHC_SUPABASE_ANON_KEY || '').trim() : '');
  const isProductionUrl = normalizeUrl(supabaseUrl) === normalizeUrl(PRODUCTION_SUPABASE_URL);
  let disabledReason = '';
  if (!isTest && !isProduction) disabledReason = `Unsupported VHC Supabase environment: ${environmentName}`;
  if (isTest && (!supabaseUrl || !supabaseAnonKey)) disabledReason = 'SAFE CLOUD TEST TARGET REQUIRED';
  if (isTest && isProductionUrl) disabledReason = 'PRODUCTION SUPABASE BLOCKED FOR DESTRUCTIVE TESTING';
  return { environmentName, supabaseUrl, supabaseAnonKey, isProductionUrl, cloudWritesAllowed: !disabledReason, disabledReason };
}

function assertSafeDestructiveTestTarget(config) {
  if (!config || config.environmentName !== 'TEST' || !config.supabaseUrl || !config.supabaseAnonKey) {
    throw new Error('SAFE CLOUD TEST TARGET REQUIRED');
  }
  if (config.isProductionUrl) throw new Error('PRODUCTION SUPABASE BLOCKED FOR DESTRUCTIVE TESTING');
  return true;
}

module.exports = { PRODUCTION_SUPABASE_URL, normalizeUrl, resolveSupabaseConfig, assertSafeDestructiveTestTarget };
