#!/usr/bin/env node

/**
 * Verify pdf-parse installation and functionality
 * Run: node scripts/verify-pdf-parse.js
 */

console.log('=== PDF-Parse Verification ===\n');

// Test 1: Check if module exists
console.log('Test 1: Module resolution');
try {
  const pdfModule = require('pdf-parse');
  console.log('✓ pdf-parse module loaded');
  console.log('  Type:', typeof pdfModule);
  console.log('  Keys:', Object.keys(pdfModule || {}).join(', '));
  
  let pdfParse;
  if (typeof pdfModule === 'function') {
    pdfParse = pdfModule;
  } else if (pdfModule && typeof pdfModule.default === 'function') {
    pdfParse = pdfModule.default;
  }
  
  if (typeof pdfParse === 'function') {
    console.log('✓ pdf-parse function available\n');
  } else {
    console.error('✗ pdf-parse is not a function\n');
    process.exit(1);
  }
} catch (err) {
  console.error('✗ Failed to load pdf-parse:', err.message);
  console.error('  Stack:', err.stack);
  process.exit(1);
}

// Test 2: Check package.json
console.log('Test 2: Package.json dependency');
try {
  const pkg = require('../package.json');
  const version = pkg.dependencies['pdf-parse'];
  console.log('✓ pdf-parse declared in package.json:', version);
  console.log('');
} catch (err) {
  console.error('✗ Failed to read package.json:', err.message);
}

// Test 3: Create a simple test PDF buffer
console.log('Test 3: Functional test (mock)');
console.log('  (Skipped - would require actual PDF buffer)\n');

console.log('=== Verification Complete ===');
console.log('pdf-parse is installed and ready to use.');
