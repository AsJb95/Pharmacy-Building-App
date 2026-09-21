/* No live network, Electron launch, credentials or production writes. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),os=require('node:os'),crypto=require('node:crypto');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8').replace(/\r\n/g,'\n');
const policySource=read('dist/assets/nhc-backup-policy.js');
const bundle=read('dist/assets/index-doBKNLAj.js');
const good={appName:'NHC Pharmacy POS',backupNamespace:'NHC_PHARMACY_POS',inventory:[{name:'synthetic',stock:7}],settings:{hospitalName:'NHC test'}};
const foreign={appName:'VHC Pharmacy POS',inventory:[]};
const cfg={nhcGoogleDriveUrl:'https://drive.google.com/drive/folders/NHC_TEST_FOLDER',nhcGDriveScriptUrl:'https://script.google.com/macros/s/NHC_TEST_DEPLOYMENT/exec',nhcGDriveAccessToken:'synthetic-test-token-not-a-secret-123456'};
const files=[{id:'auto',name:'NHC_POS_AutoBackup.json'},{id:'manual',name:'NHC_POS_Backup_001.json'},{id:'vhc',name:'VHC_POS_AutoBackup.json'},{id:'other',name:'unrelated.json'},{id:'spoof',name:'NHC_POS_Backup_spoof.json'}];
function context(extra={}) {
 const sandbox={console:{log(){},warn(){},error(){}},URL,Date,...extra};sandbox.window=sandbox.window||{};
 vm.createContext(sandbox);vm.runInContext(policySource,sandbox);return sandbox;
}
test('identity: namespace/legacy accepted; foreign/conflicting/unidentified/malformed rejected',()=>{
 const p=context().window.NHCBackup;
 for(const data of [good,{appName:'NHC Pharmacy POS',inventory:[]},{backupNamespace:'NHC_PHARMACY_POS',inventory:[]}]) assert.equal(p.validate(data),data);
 for(const data of [foreign,{...foreign,backupNamespace:'NHC_PHARMACY_POS'},{...good,backupNamespace:'VHC_PHARMACY_POS'},{inventory:[]},{...good,inventory:{}},[]]) assert.throws(()=>p.validate(data));
 assert.deepEqual(Array.from(p.candidates(files),f=>f.id),['auto','manual','spoof']);
 for(const name of ['VHC_POS_AutoBackup.json','../NHC_POS_Backup.json','NHC_POS_x/y.json','NHC_POS_.json','NHC_POS_a.json.exe']) assert.equal(p.isFilename(name),false);
});
test('legacy config cannot activate Drive; secret/config excluded from backups and not imported',async()=>{
 let calls=0;const p=context({window:{electronAPI:{gdriveUpload:()=>{calls++;throw Error('network forbidden')}}}}).window.NHCBackup;
 for(const config of [{gDriveScriptUrl:cfg.nhcGDriveScriptUrl,googleDriveUrl:cfg.nhcGoogleDriveUrl},{...cfg,nhcGDriveScriptUrl:''},{...cfg,nhcGoogleDriveUrl:''},{...cfg,nhcGDriveAccessToken:''}]) {
   assert.ok(p.config(config).error);await assert.rejects(()=>p.request(config,'list'));
 }
 assert.equal(calls,0);
 const sanitized=p.exportSettings({...cfg,googleDriveUrl:'old',gDriveScriptUrl:'old',hospitalName:'NHC'});
 assert.deepEqual(Object.keys(sanitized),['hospitalName']);
 const restored=p.restoreSettings({...good.settings,...cfg,nhcGDriveAccessToken:'hostile'},cfg);
 assert.equal(restored.nhcGDriveAccessToken,cfg.nhcGDriveAccessToken);
});
test('Apps Script client list verifies identity and read rejects spoofed NHC filename',async()=>{
 const calls=[];const p=context({window:{electronAPI:{gdriveUpload:async(url,payload)=>{
   calls.push(payload);if(payload.action==='list')return {success:true,files};
   const f=files.find(f=>f.id===payload.fileId);return {success:true,name:f.name,content:JSON.stringify(f.id==='spoof'?foreign:good)};
 }}}}).window.NHCBackup;
 assert.deepEqual(Array.from((await p.scriptList(cfg)).files,f=>f.id),['auto','manual']);
 await assert.rejects(()=>p.scriptRead(cfg,files[2]));await assert.rejects(()=>p.scriptRead(cfg,files[4]));
 assert.equal((await p.scriptRead(cfg,files[0])).appName,'NHC Pharmacy POS');
 assert.ok(calls.every(c=>c.accessToken===cfg.nhcGDriveAccessToken && c.folderId==='NHC_TEST_FOLDER'));
});
function oauthMock() {
 const deleted=[];return {deleted,fetch:async(url,options={})=>{
   const id=url.match(/\/files\/([^?]+)/)?.[1];const file=files.find(f=>f.id===id)||{id,name:'NHC_POS_Backup_outside.json'};
   if(options.method==='DELETE'){deleted.push(id);return {ok:true,status:204};}
   if(url.includes('?fields='))return {ok:true,json:async()=>({...file,parents:[id==='outside'?'OTHER_FOLDER':'NHC_TEST_FOLDER'],trashed:false})};
   if(url.includes('?alt=media'))return {ok:true,text:async()=>JSON.stringify(id==='spoof'?foreign:good)};
   return {ok:true,json:async()=>({files})};
 }};
}
test('OAuth listing and read enforce filename, content identity and parent folder',async()=>{
 const mock=oauthMock(),p=context({fetch:mock.fetch}).window.NHCBackup;
 assert.deepEqual(Array.from(await p.oauthList('synthetic','NHC_TEST_FOLDER',files),f=>f.id),['auto','manual']);
 await assert.rejects(()=>p.oauthRead('synthetic','NHC_TEST_FOLDER',files[2]));
 await assert.rejects(()=>p.oauthRead('synthetic','NHC_TEST_FOLDER',files[4]));
 await assert.rejects(()=>p.oauthRead('synthetic','NHC_TEST_FOLDER',{id:'outside',name:'NHC_POS_Backup_outside.json'}));
});
function loadSettings(options={}) {
 const settings=options.settings||cfg,uploaded=[],downloads=[],messages=[],writes=[],stateWrites=[];
 const store=new Map([['pos_inventory','[]'],['pos_settings',JSON.stringify(settings)]]);
 const element={click(){downloads.push(this.download)},remove(){}};
 const mock=oauthMock();
 const sandbox=context({fetch:options.fetch||mock.fetch,Blob,URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},setTimeout(){},CustomEvent:function(){},
  localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>{writes.push(k);store.set(k,v)},removeItem:k=>writes.push(k)},
  document:{createElement:()=>({...element}),body:{appendChild(){},removeChild(){}}},
  Ir:()=>({settings,updateSettings:()=>writes.push('settings')}),Vr:()=>({inventory:[],auditLogs:[],addLog(){}}),Th:()=>((...args)=>messages.push(args)),Eh:()=>async()=>true,vhcUseTheme:()=>['light',()=>{}],
  _:{useRef:()=>({current:false}),useState:value=>[Array.isArray(value)?options.list||[]:value===null?options.selected||null:value,v=>stateWrites.push(v)]},
  window:{dispatchEvent(){},electronAPI:{gdriveUpload:async(url,payload)=>{uploaded.push(payload);return options.script?options.script(payload):{success:true}},googleOAuthRefresh:async()=>({success:true,accessToken:'synthetic',expiresIn:3600})}}});
 const normalizeStart=bundle.indexOf('function vhcNormalizeBackup('),normalizeEnd=bundle.indexOf('\nfunction ',normalizeStart+1);
 vm.runInContext(bundle.slice(normalizeStart,normalizeEnd),sandbox);
 const start=bundle.indexOf('function Lh() {'),end=bundle.indexOf('  (0, _.useEffect)',start);
 const code=bundle.slice(start,end)+ '\n return {j,M,N,P,F,I,handleGdriveBackupNow,handleGdriveRestore,handleGdriveDelete,getGdriveDuplicateGroups,handleGdriveCleanupDuplicates};\n}';
 vm.runInContext(code,sandbox);
 return {handlers:vm.runInContext('Lh()',sandbox),sandbox,uploaded,downloads,messages,writes,stateWrites,deleted:mock.deleted};
}
test('actual Settings manual local/Apps Script/OAuth backup filenames and identities',async()=>{
 let uploadBody;const s=loadSettings({fetch:async(url,options)=>{if(url.includes('/upload/')){uploadBody=options.body;return {ok:true}}return {ok:true,json:async()=>({files:[]})}}});
 s.handlers.M();assert.match(s.downloads[0],/^NHC_POS_Local_Offline_Backup_\d+\.json$/);
 const data=s.handlers.j();assert.equal(data.backupNamespace,good.backupNamespace);assert.equal(data.settings.nhcGDriveAccessToken,undefined);
 await s.handlers.N();assert.match(s.uploaded[0].fileName,/^NHC_POS_GDrive_Backup_/);assert.equal(JSON.parse(s.uploaded[0].fileContent).appName,good.appName);
 await s.handlers.handleGdriveBackupNow();assert.match(uploadBody,/NHC_POS_Backup_/);assert.ok(!uploadBody.includes(cfg.nhcGDriveAccessToken));
});
test('actual Settings Drive restore rejects foreign, spoofed and out-of-folder backups before applying',async()=>{
 for(const file of [files[2],files[4],{id:'outside',name:'NHC_POS_Backup_outside.json'}]) {
   const s=loadSettings();await s.handlers.handleGdriveRestore(file);assert.deepEqual(s.writes,[]);assert.ok(s.messages.some(m=>String(m[0]).includes('Restore failed')));
 }
});
test('actual Settings duplicate cleanup deletes only eligible NHC files',async()=>{
 const list=[{...files[0],modifiedTime:'2020-01-01'},{...files[0],id:'new',modifiedTime:'2026-01-01'},
 {...files[2],modifiedTime:'2020-01-01'},{...files[2],id:'vhc2',modifiedTime:'2026-01-01'},
 {...files[3],modifiedTime:'2020-01-01'},{...files[3],id:'other2',modifiedTime:'2026-01-01'}];
 const s=loadSettings({list});assert.equal(s.handlers.getGdriveDuplicateGroups().length,1);
 await s.handlers.handleGdriveCleanupDuplicates();assert.deepEqual(s.deleted,['auto']);
 await s.handlers.handleGdriveDelete(files[2]);assert.deepEqual(s.deleted,['auto']);
});
test('actual local import normalizer rejects foreign and unidentified data',()=>{
 const s=loadSettings();for(const data of [foreign,{inventory:[]}])assert.throws(()=>s.sandbox.vhcNormalizeBackup(data,'local'));
 assert.ok(s.sandbox.vhcNormalizeBackup(good,'local'));
});
test('actual Apps Script Settings list filters mixed files and restore rejects identity spoofing',async()=>{
 const response=p=>p.action==='list'?{success:true,files}:{success:true,name:files.find(f=>f.id===p.fileId).name,content:JSON.stringify(p.fileId==='spoof'?foreign:good)};
 const s=loadSettings({script:response,selected:files[4]});await s.handlers.P();
 const listed=s.stateWrites.find(v=>Array.isArray(v)&&v.length>0);assert.deepEqual(Array.from(listed,f=>f.id),['auto','manual']);
 await s.handlers.F();assert.deepEqual(s.writes,[]);assert.ok(s.messages.some(m=>String(m[0]).includes('NHC identity')));
});
test('actual Apps Script and OAuth restore accept proven NHC settings and preserve device configuration',async()=>{
 const settingsOnly={appName:'NHC Pharmacy POS',settings:{hospitalName:'Restored NHC'}};
 const s=loadSettings({selected:files[0],script:()=>({success:true,name:files[0].name,content:JSON.stringify(settingsOnly)})});
 await s.handlers.F();assert.ok(s.writes.includes('settings'));assert.ok(s.writes.includes('pos_settings'));
 const restored=JSON.parse(s.sandbox.localStorage.getItem('pos_settings'));assert.equal(restored.hospitalName,'Restored NHC');assert.equal(restored.nhcGDriveAccessToken,cfg.nhcGDriveAccessToken);
 const mock=oauthMock();const o=loadSettings({fetch:(url,opts)=>url.includes('alt=media')?Promise.resolve({ok:true,text:async()=>JSON.stringify(settingsOnly)}):mock.fetch(url,opts)});
 await o.handlers.handleGdriveRestore(files[0]);assert.ok(o.writes.includes('settings'));
});
test('Settings manual backup and list with legacy configuration send no requests',async()=>{
 const s=loadSettings({settings:{gDriveScriptUrl:cfg.nhcGDriveScriptUrl,googleDriveUrl:cfg.nhcGoogleDriveUrl}});
 await s.handlers.N();await s.handlers.P();await s.handlers.handleGdriveBackupNow();assert.equal(s.uploaded.length,0);assert.equal(s.writes.length,0);
});
test('startup automatic restore offers only verified NHC auto file and revalidates before applying',async()=>{
 const store=new Map([['pos_settings',JSON.stringify(cfg)]]),buttons={},alerts=[];let changed=false;
 const dated=files.map(f=>({...f,lastModified:'2099-01-01'}));
 const sandbox=context({localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},navigator:{onLine:true},setTimeout(){},clearTimeout(){},alert:m=>alerts.push(m),
  document:{getElementById:id=>id==='vhc-cloud-prompt-modal'?null:{addEventListener:(event,fn)=>buttons[id]=fn},body:{insertAdjacentHTML(){}}},
  window:{addEventListener(){},location:{reload(){throw Error('unexpected restore')}},electronAPI:{gdriveUpload:async(url,p)=>p.action==='list'?{success:true,files:dated}:{success:true,name:dated.find(f=>f.id===p.fileId).name,content:JSON.stringify(changed||p.fileId==='spoof'?foreign:good)}}}});
 vm.runInContext(read('dist/assets/auto-sync-engine.js'),sandbox);await sandbox.window.VHCAutoSync.checkForNewerCloudBackup();
 assert.equal(sandbox.window.VHCAutoSync.getState().cloudBackupAvailable.file.id,'auto');
 changed=true;const before=JSON.stringify(Array.from(store));await buttons['vhc-restore-cloud-btn']();assert.equal(JSON.stringify(Array.from(store)),before);assert.match(alerts[0],/NHC identity/);
});
test('settings provider keeps NHC connection configuration local across API save/load',async()=>{
 const local={...cfg,hospitalName:'Local'},store=new Map([['pos_settings',JSON.stringify(local)]]),requests=[],effects=[];let state;
 const sandbox=context({fetch:async(url,options)=>{requests.push(options);return {json:async()=>({hospitalName:'Server',...cfg,nhcGDriveAccessToken:'remote-untrusted'})}},localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)},
  _:{createContext:()=>({Provider:'provider'}),useContext(){},useState:value=>{state=value;return [state,next=>{state=typeof next==='function'?next(state):next}]},useEffect:fn=>effects.push(fn)},J:{jsx:(name,props)=>props}});
 const a=bundle.indexOf('var Fr ='),b=bundle.indexOf('  Rr = [],',a);vm.runInContext(bundle.slice(a,b).replace(/,\s*$/,';'),sandbox);
 const provider=vm.runInContext('Lr({children:null})',sandbox);provider.value.updateSettings(local);
 assert.equal(JSON.parse(requests[0].body).nhcGDriveAccessToken,undefined);
 effects[0]();await new Promise(resolve=>setImmediate(resolve));assert.equal(state.nhcGDriveAccessToken,cfg.nhcGDriveAccessToken);assert.equal(state.hospitalName,'Server');
});
test('auto backup, repeated write, pending restart, local rotation and protected sentinel',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nhc-isolation-')),data=path.join(root,'nhc'),backupDir=path.join(data,'gdrive_backups');
 fs.mkdirSync(backupDir,{recursive:true});const sentinel=path.join(backupDir,'VHC_POS_AutoBackup.json');fs.writeFileSync(sentinel,JSON.stringify(foreign));
 const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(sentinel)).digest('hex'),before=hash();
 for(let i=0;i<7;i++)fs.writeFileSync(path.join(backupDir,`NHC_POS_Backup_${i}.json`),JSON.stringify(good));
 const main=read('electron/main.js'),constants=main.slice(main.indexOf('const NHC_DATA_DIR'),main.indexOf('function ensureDataDir')),
 handler=main.slice(main.indexOf("ipcMain.handle('save-gdrive-backup'"),main.indexOf('// ─── Google Drive IPC'));
 function load(env){let save;vm.runInNewContext(constants+'\n'+handler,{fs,path,process:{env},console,ipcMain:{handle:(n,f)=>save=f}});return save;}
 const store=new Map([['pos_inventory',JSON.stringify(good.inventory)],['pos_settings',JSON.stringify({gDriveScriptUrl:'https://old.invalid',googleDriveUrl:cfg.nhcGoogleDriveUrl})]]);
 let requests=0;
 function renderer(){const timers=[],save=load({VHC_TEST_DATA_DIR:data});const sandbox=context({localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},navigator:{onLine:true},setTimeout:(f,ms)=>{timers.push({f,ms});return timers.length},clearTimeout(){},window:{addEventListener(){},electronAPI:{saveGDriveBackup:(json,name)=>save(null,json,name),gdriveUpload:async()=>{requests++;return {success:true}}}}});vm.runInContext(read('dist/assets/auto-sync-engine.js'),sandbox);return {api:sandbox.window.VHCAutoSync,timers,save};}
 let r=renderer();await r.api.syncNow();assert.equal(requests,0);assert.match(r.api.getState().errorMessage,/NHC Drive backup disabled/);
 const target=path.join(backupDir,'NHC_POS_AutoBackup.json');assert.equal(JSON.parse(fs.readFileSync(target)).backupNamespace,good.backupNamespace);
 store.set('pos_inventory',JSON.stringify([{stock:8}]));await r.api.syncNow();assert.equal(JSON.parse(fs.readFileSync(target)).inventory[0].stock,8);
 store.set('vhc_pending_changes','true');store.set('pos_inventory',JSON.stringify([{stock:9}]));r=renderer();await r.timers.find(t=>t.ms===35000).f();await new Promise(resolve=>setImmediate(resolve));assert.equal(JSON.parse(fs.readFileSync(target)).inventory[0].stock,9);
 assert.equal(fs.readdirSync(backupDir).filter(f=>f.startsWith('NHC_POS_')).length,5);assert.equal(hash(),before);
 assert.equal((await r.save(null,'{}','VHC_POS_AutoBackup.json')).success,false);assert.equal((await r.save(null,'{}','../NHC_POS_escape.json')).success,false);
 if(process.platform==='win32')assert.equal((await load({VHC_TEST_BACKUP_DIR:'C:\\VHC_Pharmacy_Data\\gdrive_backups'})(null,JSON.stringify(good),'NHC_POS_AutoBackup.json')).success,false);
 store.set('pos_settings',JSON.stringify(cfg));r=renderer();await r.api.syncNow();assert.equal(requests,1);assert.equal(hash(),before);
 // Remove only this test's own unique temporary directory.
 const resolvedRoot=fs.realpathSync(root),resolvedTemp=fs.realpathSync(os.tmpdir());
 assert.equal(path.dirname(resolvedRoot),resolvedTemp);assert.ok(path.basename(resolvedRoot).startsWith('nhc-isolation-'));
 fs.rmSync(resolvedRoot,{recursive:true,force:true});
});
function server() {
 const records=[],properties={NHC_DRIVE_FOLDER_ID:'NHC_TEST_FOLDER',NHC_BACKUP_ACCESS_TOKEN:cfg.nhcGDriveAccessToken};let updates=0,locks=0;
 const iterator=items=>{let i=0;return {hasNext:()=>i<items.length,next:()=>items[i++]}};
 function file(name,data,parent='NHC_TEST_FOLDER'){const record={id:'id'+records.length,name,content:JSON.stringify(data),parent};record.getId=()=>record.id;record.getName=()=>record.name;record.getLastUpdated=()=>new Date('2026-01-01');record.getMimeType=()=> 'application/json';record.isTrashed=()=>false;record.getParents=()=>iterator([{getId:()=>record.parent}]);record.getBlob=()=>({getDataAsString:()=>record.content});record.setContent=c=>{updates++;record.content=c;};records.push(record);return record;}
 const folder={isTrashed:()=>false,getFiles:()=>iterator(records.filter(f=>f.parent==='NHC_TEST_FOLDER')),getFilesByName:name=>iterator(records.filter(f=>f.parent==='NHC_TEST_FOLDER'&&f.name===name)),createFile:(name,content)=>file(name,JSON.parse(content))};
 const sandbox={PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties[k]})},DriveApp:{getFolderById:id=>{assert.equal(id,'NHC_TEST_FOLDER');return folder},getFileById:id=>{const f=records.find(f=>f.id===id);if(!f)throw Error('missing');return f}},LockService:{getScriptLock:()=>({waitLock:()=>locks++,releaseLock:()=>locks--})},ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({setMimeType:()=>JSON.parse(text)})}};
 vm.createContext(sandbox);vm.runInContext(read('cloud-src/nhc-drive-backup.gs'),sandbox);
 return {file,records,properties,call:input=>sandbox.doPost({postData:{contents:JSON.stringify({folderId:'NHC_TEST_FOLDER',accessToken:cfg.nhcGDriveAccessToken,...input})}}),get:()=>sandbox.doGet(),updates:()=>updates,locks:()=>locks};
}
test('Apps Script upload A/repeat A/B, list/get, names, auth, folder boundaries and duplicate protection',()=>{
 const s=server(),vhc=s.file('VHC_POS_AutoBackup.json',foreign),outside=s.file('NHC_POS_Backup_outside.json',good,'OTHER_FOLDER'),spoof=s.file('NHC_POS_Backup_spoof.json',foreign),before=vhc.content;
 const upload=(name,data=good)=>s.call({action:'upload',fileName:name,fileContent:JSON.stringify(data)});
 assert.equal(upload('NHC_POS_AutoBackup.json').success,true);const first=s.records.find(f=>f.name==='NHC_POS_AutoBackup.json');
 assert.equal(upload('NHC_POS_AutoBackup.json',{...good,inventory:[{stock:99}]}).success,true);assert.equal(s.updates(),1);assert.equal(JSON.parse(first.content).inventory[0].stock,99);
 assert.equal(upload('NHC_POS_Backup_001.json').success,true);
 assert.deepEqual(Array.from(s.call({action:'list'}).files,f=>f.name).sort(),['NHC_POS_AutoBackup.json','NHC_POS_Backup_001.json']);
 assert.equal(s.call({action:'get',fileId:first.id}).success,true);
 for(const f of [vhc,outside,spoof])assert.equal(s.call({action:'get',fileId:f.id}).success,false);
 for(const name of ['VHC_POS_AutoBackup.json','../NHC_POS_a.json','NHC_POS_a/b.json','NHC_POS_a\\b.json','NHC_POS_a.json.exe','unrelated.json'])assert.equal(upload(name).success,false);
 assert.equal(upload('NHC_POS_Backup_spoof.json').success,false);assert.equal(upload('NHC_POS_foreign.json',foreign).success,false);
 assert.equal(s.call({action:'list',accessToken:'wrong'}).success,false);assert.equal(s.call({action:'list',folderId:'OTHER_FOLDER'}).success,false);assert.equal(s.call({action:'delete'}).success,false);assert.equal(s.get().success,false);
 s.file(first.name,good);assert.equal(upload(first.name).success,false);assert.equal(s.updates(),1);assert.equal(s.locks(),0);assert.equal(vhc.content,before);
 delete s.properties.NHC_DRIVE_FOLDER_ID;assert.equal(s.call({action:'list'}).success,false);
});
test('runtime wiring has no VHC backup filename/default script URL and all safety backups have namespace',()=>{
 assert.ok(!bundle.includes('VHC_POS_'));assert.ok(!bundle.includes('AKfycbyQNSa8FMSV4RXwegDKFrUO'));
 assert.equal((bundle.match(/backupNamespace: window.NHCBackup.namespace/g)||[]).length,4);
 assert.ok(read('dist/index.html').indexOf('nhc-backup-policy.js')<read('dist/index.html').indexOf('auto-sync-engine.js'));
 assert.equal(JSON.parse(read('package.json')).version,'3.18.1');
});
