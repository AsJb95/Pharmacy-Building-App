/* Shared NHC backup policy. Loaded before both renderer entry points. */
(function (root) {
  'use strict';
  const namespace = 'NHC_PHARMACY_POS';
  const filenamePattern = /^NHC_POS_[A-Za-z0-9_-]+\.json$/;
  function isFilename(name) { return typeof name === 'string' && name.length <= 180 && filenamePattern.test(name); }
  function validate(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Incompatible backup: expected an NHC backup object.');
    if (data.backupNamespace !== undefined ? data.backupNamespace !== namespace : data.appName !== 'NHC Pharmacy POS')
      throw new Error('Incompatible backup: NHC identity could not be verified. Nothing was restored.');
    if (data.appName && data.appName !== 'NHC Pharmacy POS') throw new Error('Incompatible backup: conflicting application identity.');
    for (const key of ['inventory', 'patients', 'salesHistory', 'cartDraft']) {
      if (data[key] !== undefined && !Array.isArray(data[key])) throw new Error('Invalid backup field: ' + key);
    }
    if (data.settings !== undefined && (!data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings))) throw new Error('Invalid backup settings.');
    if (!['inventory', 'patients', 'salesHistory', 'settings'].some(key => data[key] !== undefined)) throw new Error('Backup contains no supported data.');
    return data;
  }
  function candidates(files) { return (Array.isArray(files) ? files : []).filter(f => f && isFilename(f.name)); }
  function folderId(settings) {
    const match = String(settings.nhcGoogleDriveUrl || '').trim().match(/^https:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]+)(?:[/?#].*)?$/);
    return match ? match[1] : '';
  }
  function config(settings) {
    const scriptUrl = String(settings.nhcGDriveScriptUrl || '').trim();
    const id = folderId(settings), accessToken = String(settings.nhcGDriveAccessToken || '').trim();
    const validUrl = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(scriptUrl);
    return {scriptUrl: validUrl ? scriptUrl : '', folderId:id, accessToken,
      error: !id ? 'NHC Drive backup disabled: configure a dedicated NHC Drive folder.' : !validUrl ? 'NHC Drive backup disabled: configure the dedicated NHC Apps Script URL.' : accessToken.length < 32 ? 'NHC Drive backup disabled: configure the NHC backup access token (at least 32 characters).' : ''};
  }
  function exportSettings(settings) {
    const copy = {...settings};
    // Drive configuration is device-local. Never embed the bearer secret in backups.
    for (const key of ['nhcGoogleDriveUrl','nhcGDriveScriptUrl','nhcGDriveAccessToken','googleDriveUrl','oneDriveUrl','gDriveScriptUrl']) delete copy[key];
    return copy;
  }
  function restoreSettings(incoming, current) {
    const result = exportSettings(incoming);
    for (const key of ['nhcGoogleDriveUrl','nhcGDriveScriptUrl','nhcGDriveAccessToken']) if (current[key] !== undefined) result[key] = current[key];
    return result;
  }
  async function request(settings, action, fields = {}) {
    const cfg = config(settings);
    if (cfg.error) throw new Error(cfg.error);
    if (!['upload','list','get'].includes(action)) throw new Error('Unsupported NHC backup action.');
    if (action === 'upload') {
      if (!isFilename(fields.fileName)) throw new Error('Invalid NHC backup filename.');
      validate(JSON.parse(fields.fileContent));
    }
    const payload = {...fields, action, folderId:cfg.folderId, accessToken:cfg.accessToken};
    const response = root.electronAPI && root.electronAPI.gdriveUpload
      ? await root.electronAPI.gdriveUpload(cfg.scriptUrl, payload)
      : await (await fetch(cfg.scriptUrl, {method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify(payload)})).json();
    if (!response || !response.success) throw new Error(response && response.error || 'NHC Drive request failed.');
    return response;
  }
  async function scriptRead(settings, file) {
    if (!file || !isFilename(file.name)) throw new Error('Only NHC backup filenames are allowed.');
    const result = await request(settings, 'get', {fileId:file.id});
    if (result.name !== file.name) throw new Error('Backup name changed. Refresh the NHC backup list.');
    return validate(JSON.parse(result.content));
  }
  async function scriptList(settings) {
    const result = await request(settings, 'list');
    const verified = [];
    for (const file of candidates(result.files)) {
      try { await scriptRead(settings, file); verified.push(file); } catch (_) { /* Unverified files are never offered or deleted. */ }
    }
    return {...result, files:verified};
  }
  async function oauthRead(token, id, file) {
    if (!id || !file || !isFilename(file.name) || !/^[A-Za-z0-9_-]+$/.test(file.id)) throw new Error('Invalid NHC Drive backup selection.');
    const base = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(file.id);
    const options = {headers:{Authorization:'Bearer ' + token}};
    const metaResponse = await fetch(base + '?fields=id,name,parents,trashed', options);
    if (!metaResponse.ok) throw new Error('Cannot verify Drive backup metadata.');
    const meta = await metaResponse.json();
    if (meta.trashed || meta.name !== file.name || !isFilename(meta.name) || !Array.isArray(meta.parents) || !meta.parents.includes(id)) throw new Error('Backup is outside the configured NHC folder or has changed.');
    const response = await fetch(base + '?alt=media', options);
    if (!response.ok) throw new Error('Cannot read NHC backup.');
    return validate(JSON.parse(await response.text()));
  }
  async function oauthList(token, id, files) {
    const verified=[];
    for (const file of candidates(files)) { try { await oauthRead(token,id,file); verified.push(file); } catch (_) {} }
    return verified;
  }
  root.NHCBackup = {namespace,isFilename,validate,candidates,folderId,config,exportSettings,restoreSettings,request,scriptRead,scriptList,oauthRead,oauthList};
})(typeof window !== 'undefined' ? window : globalThis);
