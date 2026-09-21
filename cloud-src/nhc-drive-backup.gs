/** Dedicated NHC deployment. See nhc-drive-backup-setup.md. No default folder or secret. */
function nhcName_(name) {
  return typeof name === 'string' && name.length <= 180 && /^NHC_POS_[A-Za-z0-9_-]+\.json$/.test(name);
}
function nhcContent_(content) {
  if (typeof content !== 'string' || content.length > 20000000) throw new Error('Invalid backup content or size.');
  var data = JSON.parse(content);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid NHC backup.');
  if (data.backupNamespace !== undefined ? data.backupNamespace !== 'NHC_PHARMACY_POS' : data.appName !== 'NHC Pharmacy POS') throw new Error('NHC backup identity required.');
  if (data.appName && data.appName !== 'NHC Pharmacy POS') throw new Error('Conflicting backup identity.');
  ['inventory','patients','salesHistory','cartDraft'].forEach(function(key) { if (data[key] !== undefined && !Array.isArray(data[key])) throw new Error('Invalid backup data.'); });
  if (data.settings !== undefined && (!data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings))) throw new Error('Invalid settings.');
  if (!['inventory','patients','salesHistory','settings'].some(function(key) { return data[key] !== undefined; })) throw new Error('No backup data.');
  return data;
}
function nhcJson_(result) { return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON); }
function doGet() { return nhcJson_({success:false,error:'Use authenticated POST for NHC backup actions.'}); }
function doPost(e) {
  var lock;
  try {
    var properties = PropertiesService.getScriptProperties();
    var folderId = properties.getProperty('NHC_DRIVE_FOLDER_ID');
    var secret = properties.getProperty('NHC_BACKUP_ACCESS_TOKEN');
    if (!folderId || !/^[A-Za-z0-9_-]+$/.test(folderId) || !secret || secret.length < 32) throw new Error('NHC backup service is not configured.');
    var body = e && e.postData && e.postData.contents;
    if (!body || body.length > 21000000) throw new Error('Invalid request.');
    var input = JSON.parse(body);
    if (!input || input.accessToken !== secret) throw new Error('Unauthorized.');
    if (input.folderId !== folderId) throw new Error('NHC folder mismatch.');
    if (['upload','list','get'].indexOf(input.action) < 0) throw new Error('Unsupported action.');
    var folder = DriveApp.getFolderById(folderId);
    if (folder.isTrashed()) throw new Error('NHC folder is unavailable.');
    function descriptor(file) { return {id:file.getId(),name:file.getName(),lastModified:file.getLastUpdated().toISOString()}; }
    function read(file) {
      if (file.isTrashed() || !nhcName_(file.getName()) || file.getMimeType() === 'application/vnd.google-apps.shortcut') throw new Error('Not an NHC backup.');
      var parents=file.getParents(), inside=false;
      while (parents.hasNext()) if (parents.next().getId() === folderId) inside=true;
      if (!inside) throw new Error('File is outside the NHC folder.');
      var content=file.getBlob().getDataAsString('UTF-8'); nhcContent_(content); return content;
    }
    if (input.action === 'get') {
      if (typeof input.fileId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(input.fileId)) throw new Error('Invalid file ID.');
      var file=DriveApp.getFileById(input.fileId), content=read(file);
      return nhcJson_({success:true,name:file.getName(),content:content});
    }
    if (input.action === 'list') {
      var files=[], iterator=folder.getFiles();
      while (iterator.hasNext()) {
        var candidate=iterator.next();
        try { read(candidate); files.push(descriptor(candidate)); } catch (_) { /* Keep incompatible files untouched. */ }
      }
      files.sort(function(a,b) { return b.lastModified.localeCompare(a.lastModified); });
      return nhcJson_({success:true,files:files});
    }
    if (!nhcName_(input.fileName)) throw new Error('Invalid NHC backup filename.');
    nhcContent_(input.fileContent);
    lock=LockService.getScriptLock(); lock.waitLock(30000);
    var matches=folder.getFilesByName(input.fileName), existing=[];
    while (matches.hasNext()) { var match=matches.next(); if (!match.isTrashed()) existing.push(match); }
    // Ambiguous or incompatible existing files are never overwritten or deleted.
    if (existing.length > 1) throw new Error('Duplicate NHC filenames require manual review.');
    var saved;
    if (existing.length) { saved=existing[0]; read(saved); saved.setContent(input.fileContent); }
    else saved=folder.createFile(input.fileName,input.fileContent,'application/json');
    return nhcJson_({success:true,file:descriptor(saved)});
  } catch (error) {
    // Avoid leaking Drive metadata, secrets, or request contents from platform errors.
    return nhcJson_({success:false,error:'NHC backup request rejected. Check configuration, identity, filename and folder access.'});
  } finally { if (lock) lock.releaseLock(); }
}
