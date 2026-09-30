import {spawnSync} from 'node:child_process';
import {accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync} from 'node:fs';
import {delimiter, dirname, join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {hash} from './source-evidence.mjs';

export const isGit=root=>existsSync(join(root,'.git'));
export const shellQuote = text => "'" + text.replaceAll("'", "'\"'\"'") + "'";

function scannerEnvironment(root, env) {
  for (const key of ['NOSE_PLUGIN_ROOT','NOSE_PROJECT_ROOT','NOSE_REVIEW_STATE_ROOT',
    'GIT_DIR','GIT_COMMON_DIR','GIT_WORK_TREE','GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_QUARANTINE_PATH']) delete env[key];
  if (!isGit(root)) return env;
  const script='console.log(JSON.stringify(Object.fromEntries(["PATH","GIT_EXEC_PATH","GIT_PREFIX"].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]))))';
  const command='!'+shellQuote(process.execPath)+' -e '+shellQuote(script);
  const probe=spawnSync('git',['-c','alias.nose-review-env='+command,'nose-review-env'],{
    cwd:root,env,encoding:'utf8',timeout:5000,maxBuffer:1024*1024,
  });
  if(probe.status!==0) throw new Error('Git scanner environment unavailable');
  const effective=JSON.parse(probe.stdout);
  for(const key of ['PATH','GIT_EXEC_PATH','GIT_PREFIX']) {
    if(effective[key]!==undefined && typeof effective[key]!=='string') throw new Error('Invalid Git scanner environment');
  }
  return {...env,...Object.fromEntries(['PATH','GIT_EXEC_PATH','GIT_PREFIX'].filter(key=>effective[key]!==undefined).map(key=>[key,
    key==='PATH' ? [...new Set(effective[key].split(delimiter))].join(delimiter) : effective[key]]))};
}

function globalIgnoreInputs(root, env) {
  const ignores=spawnSync('git',['config','--path','--get-all','core.excludesFile'],{cwd:root,env,encoding:'utf8',timeout:5000});
  if (ignores.error || ![0,1].includes(ignores.status)) throw new Error('Global ignore configuration unavailable');
  const home=env.HOME || homedir();
  const xdg=env.XDG_CONFIG_HOME || join(home,'.config');
  const configs=[join(home,'.gitconfig'),join(xdg,'git','config')];
  const paths=[join(xdg,'git','ignore'),...ignores.stdout.trim().split('\n').filter(Boolean).map(path=>resolve(root,path))];
  // Nose's ignore dependency also reads these files directly, independently of
  // GIT_CONFIG_GLOBAL. Bind the files and its first excludesFile match as well.
  for (const config of configs) {
    if (!existsSync(config)) continue;
    const matches=readFileSync(config,'utf8').matchAll(/^[\t\n\v\f\r ]*excludesfile[\t\n\v\f\r ]*=[\t\n\v\f\r ]*"?[\t\n\v\f\r ]*([^\t\n\v\f\r ]+?)[\t\n\v\f\r ]*"?[\t\n\v\f\r ]*$/gim);
    for(const match of matches) paths.push(resolve(root,match[1].replaceAll('~',home)));
  }
  return [...new Set([...configs,...paths])].map(path=>[path,existsSync(path)?hash(readFileSync(path)):null]);
}

// The identity follows native inputs and source-proof semantics. Review policy,
// hook orchestration, and progress logging are applied after retrieving evidence.
export function scannerInputs(root, {cacheDirectory, cacheOwner, managed, exclusions=[]}) {
  const runtimeVariables=new Set(['PATH','HOME','USERPROFILE','HOMEDRIVE','HOMEPATH','LANG','LANGUAGE',
    'TMPDIR','TMP','TEMP','SystemRoot','SYSTEMROOT','WINDIR','PATHEXT']);
  const env=scannerEnvironment(cacheOwner,Object.fromEntries(Object.entries(process.env).filter(([key])=>
    runtimeVariables.has(key) || /^(NOSE_|RAYON_|GIT_|XDG_|LC_|DYLD_|LD_)/.test(key))));
  const threads=env.RAYON_NUM_THREADS ?? 'native default';
  const version=spawnSync('nose',['--version'],{cwd:root,env,encoding:'utf8',timeout:5000});
  if(version.status!==0) throw new Error('Nose executable unavailable');
  const cache=join(cacheDirectory,'analysis-cache');
  mkdirSync(cache,{recursive:true,mode:0o700});
  if(lstatSync(cache).isSymbolicLink()) throw new Error('Analysis cache must not be a symlink');
  const args=['query','.','all','top=0','sort=extractability','--mode','syntax,semantic,near','--min-size','24','--cache-dir',cache,'--format','json',
    ...(managed?[]:exclusions.flatMap(name=>['--exclude',name+'/']))];
  const noseVersion=version.stdout.trim();
  const identity=(inputIdentity,onSkip)=>{
    const skip=reason=>{onSkip?.(reason);return null;};
    if(!inputIdentity) return skip('no-content-identity');
    try {
      const executable=(env.PATH ?? '').split(delimiter).map(directory=>resolve(root,directory,'nose'))
        .find(path=>{try {accessSync(path,constants.X_OK);return lstatSync(realpathSync(path)).isFile();} catch {return false;}});
      if(!executable) return skip('executable-unresolved');
      const config=spawnSync(executable,[...args,'--show-config'],{cwd:root,env,encoding:'utf8',timeout:5000,maxBuffer:1024*1024});
      if(config.status!==0) return skip('effective-config-unavailable');
      const settings=JSON.parse(config.stdout);
      if(settings.schema!=='nose.query-config/v1' || !settings.query || !Array.isArray(settings.query['semantic-packs']))
        return skip('effective-config-unsupported');
      if(settings.config_file!==null) return skip('external-config');
      if(settings.query['ignore-file']!==null) return skip('external-ignore');
      if(settings.query['semantic-pack-lock']!==null || settings.query['semantic-packs'].length) return skip('external-semantic-pack');
      const scripts=dirname(fileURLToPath(import.meta.url));
      const proof=['source-evidence.mjs','scanner-inputs.mjs'].map(name=>[name,hash(readFileSync(join(scripts,name)))]);
      return {inputIdentity,root:isGit(root)?cacheDirectory:root,noseVersion,executable:realpathSync(executable),binary:hash(readFileSync(executable)),
        proof,args,settings,globalIgnores:globalIgnoreInputs(root,env),node:process.version,
        environment:hash(JSON.stringify(Object.entries(env).sort(([a],[b])=>a.localeCompare(b))))};
    } catch {return skip('identity-unavailable');}
  };
  return {env,args,cache,threads,noseVersion,identity};
}
