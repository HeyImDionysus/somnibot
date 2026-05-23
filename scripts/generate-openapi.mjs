#!/usr/bin/env node
/**
 * Generate OpenAPI 3.1 spec from Next.js API routes.
 *
 * Scans packages/dashboard/src/app/api/ for route.ts files,
 * extracts HTTP methods and JSDoc descriptions, and outputs
 * a YAML spec to docs/openapi.yaml.
 *
 * Usage: node scripts/generate-openapi.mjs
 *
 * Audit V2 Finding 12.1 — API Documentation
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';

const API_ROOT = 'packages/dashboard/src/app/api';
const OUTPUT = 'docs/openapi.yaml';

function findRouteFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findRouteFiles(full));
    } else if (entry === 'route.ts') {
      results.push(full);
    }
  }
  return results.sort();
}

function extractMethods(content) {
  const methods = [];
  const regex = /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    methods.push(match[1].toLowerCase());
  }
  return methods;
}

function extractDescription(content) {
  // Try JSDoc first line
  const jsdoc = content.match(/\/\*\*\s*\n?\s*\*\s*(.+?)(?:\n|\s*\*\/)/);
  if (jsdoc) return jsdoc[1].trim();
  // Try single-line comment
  const comment = content.match(/^\/\/\s*(.+)/m);
  if (comment) return comment[1].trim();
  return null;
}

function routePathFromFile(filePath) {
  const rel = relative(API_ROOT, filePath).replace(/\/route\.ts$/, '');
  // Convert Next.js [param] to OpenAPI {param}
  const apiPath = '/api/' + rel.replace(/\[([^\]]+)\]/g, '{$1}');
  return apiPath;
}

function escapeYaml(str) {
  if (!str) return '';
  return str.replace(/'/g, "''");
}

// ── Main ──

if (!existsSync(API_ROOT)) {
  console.error(`API root not found: ${API_ROOT}`);
  process.exit(1);
}

const routeFiles = findRouteFiles(API_ROOT);
console.log(`Found ${routeFiles.length} route files`);

let paths = '';
for (const file of routeFiles) {
  const content = readFileSync(file, 'utf-8');
  const methods = extractMethods(content);
  const desc = extractDescription(content);
  const route = routePathFromFile(file);

  if (methods.length === 0) continue;

  paths += `  ${route}:\n`;
  for (const method of methods) {
    paths += `    ${method}:\n`;
    paths += `      summary: '${method.toUpperCase()} ${escapeYaml(route)}'\n`;
    if (desc) {
      paths += `      description: '${escapeYaml(desc)}'\n`;
    }
    // Tag from first path segment
    const tag = route.split('/')[2] || 'general';
    paths += `      tags:\n        - ${tag}\n`;
    paths += `      responses:\n`;
    paths += `        '200':\n`;
    paths += `          description: Success\n`;
  }
}

const spec = `# SomniBot Dashboard API — OpenAPI 3.1.0 Specification
#
# Auto-generated from packages/dashboard/src/app/api/
# Regenerate: node scripts/generate-openapi.mjs
#
# Audit V2 Finding 12.1 — API Documentation

openapi: '3.1.0'
info:
  title: SomniBot Dashboard API
  version: '1.0.0'
  description: |
    Internal API for the SomniBot dashboard. All routes require guild-owner
    authentication via Discord OAuth session unless noted otherwise.
  contact:
    email: heyimdionysus@gmail.com

servers:
  - url: '{dashboardUrl}'
    description: Dashboard instance
    variables:
      dashboardUrl:
        default: 'http://localhost:3000'

security:
  - sessionCookie: []

components:
  securitySchemes:
    sessionCookie:
      type: apiKey
      in: cookie
      name: next-auth.session-token
      description: NextAuth session cookie from Discord OAuth

  schemas:
    Error:
      type: object
      properties:
        error:
          type: string
        details:
          type: array
          items:
            type: object

paths:
${paths}`;

writeFileSync(OUTPUT, spec);
console.log(`Written ${OUTPUT} (${routeFiles.length} routes)`);
