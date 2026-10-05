import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const publicNames = ['NEXT_PUBLIC_DATA_BACKEND', 'NEXT_PUBLIC_CLOUDBASE_ENV_ID',
  'NEXT_PUBLIC_CLOUDBASE_REGION', 'NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY'];

// CloudBase source deployment does not expose Docker build arguments. Its clean
// staging directory may include this public-only file; runtime secrets stay out.
export async function containerBuildEnvironment(filename, inherited = process.env) {
  let source;
  try { source = await readFile(filename, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { ...inherited }; throw error; }
  let config;
  try { config = JSON.parse(source); } catch { throw new Error('Public build configuration must be valid JSON.'); }
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.entries(config).some(([name, value]) => !publicNames.includes(name) || typeof value !== 'string')) {
    throw new Error('Public build configuration accepts only the four documented CloudBase public values.');
  }
  if (config.NEXT_PUBLIC_DATA_BACKEND !== 'cloudbase' ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(config.NEXT_PUBLIC_CLOUDBASE_ENV_ID || '') ||
      !/^[a-z]{2}-[a-z]+(?:-[a-z0-9]+)*$/.test(config.NEXT_PUBLIC_CLOUDBASE_REGION || '') ||
      !config.NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY?.trim()) {
    throw new Error('Public CloudBase build configuration is incomplete or invalid.');
  }
  return { ...inherited, ...config };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = await containerBuildEnvironment('cloudbase/public-build.json');
  const require = createRequire(import.meta.url);
  const build = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'build'], { stdio: 'inherit', env });
  build.on('error', () => { console.error('Cannot start Next.js build.'); process.exitCode = 1; });
  build.on('exit', code => { process.exitCode = code ?? 1; });
}
