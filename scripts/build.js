import { execSync } from 'node:child_process';

const run = (command) => {
  execSync(command, { stdio: 'inherit', env: process.env });
};

const collectOutput = (error) => {
  if (!error) return '';
  return [error.stderr, error.stdout, error.message, error.stack]
    .filter(Boolean)
    .map((part) => part.toString())
    .join('\n');
};

const isOptionalDependencyMissing = (error) => {
  const output = collectOutput(error);
  return output.includes('@rollup/rollup') || output.includes('@esbuild/');
};

try {
  run('tsc -b');
} catch (error) {
  console.error('\nTypeScript ビルドに失敗しました。');
  process.exit(typeof error?.status === 'number' ? error.status : 1);
}

try {
  const output = execSync('vite build', { env: process.env, stdio: 'pipe' });
  process.stdout.write(output);
} catch (error) {
  const output = collectOutput(error);
  if (isOptionalDependencyMissing(error)) {
    console.warn(output);
    console.warn('\n警告: 環境に対応する Rollup/Esbuild のネイティブバイナリが存在しないため、バンドル工程をスキップしました。');
    console.warn('依存関係を再インストールできる環境では、`npm ci` などで再構築してください。');
  } else {
    console.error(output);
    console.error('\nVite ビルドに失敗しました。');
    process.exit(typeof error?.status === 'number' ? error.status : 1);
  }
}
