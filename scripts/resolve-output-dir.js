#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'Package.swift',
  'project.yml',
  'Makefile',
];

function gitRoot(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function hasProjectMarker(directory) {
  return PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(directory, marker)));
}

function isGenericUserDirectory(directory) {
  const home = os.homedir();
  return new Set([
    home,
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
  ]).has(directory);
}

function resolveDefaultOutputDir(cwd = process.cwd()) {
  const resolvedCwd = path.resolve(cwd);
  const repositoryRoot = gitRoot(resolvedCwd);
  if (repositoryRoot) return repositoryRoot;

  let current = resolvedCwd;
  while (current !== path.dirname(current)) {
    if (hasProjectMarker(current)) return current;
    current = path.dirname(current);
  }

  return isGenericUserDirectory(resolvedCwd) ? path.join(os.homedir(), 'Desktop') : resolvedCwd;
}

if (require.main === module) {
  const cwdIndex = process.argv.indexOf('--cwd');
  const cwd = cwdIndex >= 0 ? process.argv[cwdIndex + 1] : process.cwd();
  process.stdout.write(`${resolveDefaultOutputDir(cwd || process.cwd())}\n`);
}

module.exports = { resolveDefaultOutputDir };
