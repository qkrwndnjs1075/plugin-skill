import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from './review-runtime.mjs';
import { scanSecrets } from './secret-scan.mjs';

// Inspect changed blobs in each outgoing commit, including changes later deleted.
export function scanCommitSecrets(root, sha) {
  const parents = git(root, ['rev-list', '--parents', '-n', '1', sha]).trim().split(' ').slice(1);
  const args = ['diff-tree', '--root', '--no-commit-id', '--no-renames', '-r', '--raw', '-z', '--no-abbrev'];
  args.push(...(parents.length ? [parents[0], sha] : [sha]));
  const fields = git(root, args).split('\0');
  const directory = mkdtempSync(join(tmpdir(), 'nose-commit-secrets-'));
  const paths = new Map();
  try {
    for (let index = 0; index < fields.length - 1; index += 2) {
      const header = fields[index].split(' ');
      const file = fields[index + 1];
      if (header.length !== 5 || !file) throw new Error('Invalid changed-blob inventory');
      const [, mode, , object, status] = header;
      if (status === 'D') continue;
      if (!['100644', '100755', '120000'].includes(mode)) throw new Error('Unsupported changed Git entry');
      const name = `${index}.blob`;
      paths.set(name, file);
      const descriptor = openSync(join(directory, name), 'wx', 0o600);
      try {
        const result = spawnSync('git', ['cat-file', 'blob', object], {
          cwd: root, stdio: ['ignore', descriptor, 'pipe'], timeout: 30000,
        });
        if (result.error || result.status !== 0) throw new Error('Changed blob could not be read');
      } finally { closeSync(descriptor); }
    }
    const result = scanSecrets(directory);
    return {...result, findings: result.findings.map(finding => {
      const file = paths.get(finding.file);
      if (!file) throw new Error('Secret finding outside changed blobs');
      return {...finding, file};
    })};
  } finally { rmSync(directory, {recursive: true, force: true}); }
}
