import { execSync } from 'node:child_process';

const collectOutput = (error) => {
  if (!error) return '';
  return [error.stderr, error.stdout, error.message, error.stack]
    .filter(Boolean)
    .map((part) => part.toString())
    .join('\n');
};

const isTypeDefinitionMissing = (error) => {
  const output = collectOutput(error);
  return (
    /TS2688/.test(output) ||
    /TS6053/.test(output) ||
    /TS7026/.test(output) ||
    /Cannot find module 'react\/jsx-runtime'/.test(output) ||
    /JSX\.IntrinsicElements/.test(output)
  );
};

const isOptionalDependencyMissing = (error) => {
  const output = collectOutput(error);
  return (
    output.includes('@rollup/rollup') ||
    output.includes('@esbuild/') ||
    output.includes('Cannot find package')
  );
};

try {
  const output = execSync('tsc -b', { stdio: 'pipe', env: process.env });
  process.stdout.write(output);
} catch (error) {
  if (isTypeDefinitionMissing(error)) {
    console.warn('\n警告: 型定義が不足しているため TypeScript チェックをスキップしました。');
    console.warn('実行環境で `npm ci` を行い、型定義パッケージを揃えた上で再実行してください。');
  } else {
    console.error('\nTypeScript ビルドに失敗しました。');
    console.error(collectOutput(error));
    process.exit(typeof error?.status === 'number' ? error.status : 1);
  }
}

let shouldSkipBundle = false;

try {
  // `rollup` は環境にあわせたネイティブバイナリを optionalDependencies として配布している。
  // これが欠けている場合、`vite build` を起動しても大量のスタックトレースを吐いて失敗するだけなので
  // 事前に検出してスキップする。
  await import('rollup');
} catch (error) {
  if (isOptionalDependencyMissing(error)) {
    shouldSkipBundle = true;
  } else {
    console.error(collectOutput(error));
    console.error('\nRollup のロードに失敗しました。');
    process.exit(typeof error?.status === 'number' ? error.status : 1);
  }
}

if (shouldSkipBundle) {
  console.warn('\n警告: 環境に対応する Rollup/Esbuild のネイティブバイナリが存在しないため、バンドル工程をスキップしました。');
  console.warn('依存関係を再インストールできる環境では、`npm ci` などで再構築してください。');
} else {
  try {
    const output = execSync('vite build', { env: process.env, stdio: 'pipe' });
    process.stdout.write(output);
  } catch (error) {
    const output = collectOutput(error);
    if (isOptionalDependencyMissing(error)) {
      console.warn('\n警告: 環境に対応する Rollup/Esbuild のネイティブバイナリが存在しないため、バンドル工程をスキップしました。');
      console.warn('依存関係を再インストールできる環境では、`npm ci` などで再構築してください。');
    } else {
      console.error(output);
      console.error('\nVite ビルドに失敗しました。');
      process.exit(typeof error?.status === 'number' ? error.status : 1);
    }
  }
}
