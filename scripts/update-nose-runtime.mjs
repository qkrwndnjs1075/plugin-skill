import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export async function releaseManifest(current, release, download) {
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw new Error('Expected a stable release');
  const version=release.tag_name;
  if (version.localeCompare(current.version,'en',{numeric:true})<=0) throw new Error('Release must be newer than the current pin');
  const prefix=`https://github.com/${current.repository}/releases/download/${version}/`;
  const assets={};
  for (const [platform, old] of Object.entries(current.assets)) {
    const archive=release.assets.find(asset=>asset.name===old.name);
    const checksum=release.assets.find(asset=>asset.name===old.name+'.sha256');
    if (!archive || !checksum || archive.browser_download_url!==prefix+old.name || checksum.browser_download_url!==prefix+old.name+'.sha256') throw new Error('Missing or unexpected release asset: '+old.name);
    const sum=Buffer.from(await download(checksum.browser_download_url)).toString('utf8').trim();
    const match=sum.match(/^([a-fA-F0-9]{64})\s+\*?([^\r\n]+)$/);
    if (!match || match[2]!==old.name) throw new Error('Invalid checksum for '+old.name);
    const sha256=createHash('sha256').update(await download(archive.browser_download_url)).digest('hex');
    if (sha256!==match[1].toLowerCase()) throw new Error('Checksum mismatch for '+old.name);
    assets[platform]={name:old.name,sha256};
  }
  return {version,repository:current.repository,assets};
}

if (process.argv[1]===fileURLToPath(import.meta.url)) {
  const manifestPath=new URL('../plugins/nose-review/scripts/nose-runtime.json',import.meta.url);
  const current=JSON.parse(readFileSync(manifestPath,'utf8'));
  const release=JSON.parse(execFileSync('gh',['api',`repos/${current.repository}/releases/latest`],{encoding:'utf8',timeout:30000}));
  if (release.tag_name!==current.version) {
    const next=await releaseManifest(current,release,async url=>{
      const asset=release.assets.find(entry=>entry.browser_download_url===url);
      if (!asset || !Number.isSafeInteger(asset.id)) throw new Error('Missing release asset ID');
      return execFileSync('gh',['api',`repos/${current.repository}/releases/assets/${asset.id}`,'-H','Accept: application/octet-stream'],{timeout:120000,maxBuffer:256*1024*1024});
    });
    writeFileSync(manifestPath,JSON.stringify(next,null,2)+'\n');
    const pluginPath=new URL('../plugins/nose-review/.codex-plugin/plugin.json',import.meta.url);
    const plugin=JSON.parse(readFileSync(pluginPath,'utf8'));
    const parts=plugin.version.split('.').map(Number);
    if (parts.length!==3 || parts.some(n=>!Number.isInteger(n))) throw new Error('Invalid plugin version');
    parts[2]++;
    plugin.version=parts.join('.');
    writeFileSync(pluginPath,JSON.stringify(plugin,null,2)+'\n');
    console.log('Prepared Nose runtime '+next.version);
  } else console.log('Nose runtime is current');
}
