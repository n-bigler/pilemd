const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const _ = require('lodash');
const moment = require('moment');
const Datauri = require('datauri');

const arr = require('./utils/arr');
const uid = require('./utils/uid');

const electron = require('electron');


const BASE_LIB_PATH_KEY = 'libpath';


function setBaseLibraryPath(path) {
  return localStorage.setItem(BASE_LIB_PATH_KEY, path);
}


function getBaseLibraryPath() {
  return localStorage.getItem(BASE_LIB_PATH_KEY);
}

const DATA_REG = /\/(notes|folders|racks)\/([a-f0-9]{8}\-[a-f0-9]{4}\-[a-f0-9]{4}\-[a-f0-9]{4}\-[a-f0-9]{12})\.json$/;

function detectPath(path) {
  var m = DATA_REG.exec(path);
  if (!m) {
    return null
  }
  var dataType = m[1];
  var uid = m[2];
  return {
    dataType: dataType,
    uid: uid
  }
}

class Model {
  constructor(data) {
    this.uid = data.uid || uid.guid();
  }
  get data() { return { uid: this.uid } }

  update(data) {
    this.uid = data.uid;
  }

  static buildSaveDirPath() {
    return path.join(getBaseLibraryPath(), this.storagePrefix);
  }

  static buildSavePath(uid) {
    return path.join(this.buildSaveDirPath(), uid) + '.json';
  }

  static setModel(model) {
    if (!model) { return }
    var p = this.buildSavePath(model.uid);
    fs.mkdir(this.buildSaveDirPath(), (err) => {
      if (err) {}
      fs.writeFile(p, JSON.stringify(model.data));
    });
  }

  static removeModelFromStorage(model) {
    if (!model) { return }
    var p = this.buildSavePath(model.uid);
    fs.unlink(p);
  }

  static getModelsSync() {
    var dirPath = this.buildSaveDirPath();
    try {
      var files = fs.readdirSync(dirPath);
    } catch(e) {
      fs.mkdirSync(dirPath);
      files = [];
    }
    var valids = [];
    files.forEach((f) => {
      var p = path.join(dirPath, f);
      var d = detectPath(p);
      if (d && d.dataType == this.storagePrefix) {
        valids.push(new this(JSON.parse(fs.readFileSync(p))));
      }
    });
    return valids;
  }
}
Model.storagePrefix = 'models';


/**
 * [new Model(...)...].find(uidFinder("specify-your-uid")) => Model
 */
function uidFinder(uid){
  return (el) => {
    return el.uid == uid
  };
}


class Note extends Model {
  constructor(data) {
    super(data);

    this._body = data.body || '';
    this.folderUid = data.folderUid || null;
    this.doc = null;  // Codemirror.Doc object.
    this.qiitaURL = data.qiitaURL || null;

    if (data.updated_at) {
      this.updatedAt = moment(data.updated_at);
    } else {
      this.updatedAt = moment();
    }
    if (data.created_at) {
      this.createdAt = moment(data.created_at);
    } else {
      this.createdAt = moment();
    }
  }

  get data() {
    return _.assign(super.data, {
      body: this.body,
      folderUid: this.folderUid,
      updated_at: this.updatedAt,
      created_at: this.createdAt,
      qiitaURL: this.qiitaURL
    })
  }

  update(data) {
    super.update(data);
    this._body = data.body;
    this.folderUid = data.folderUid;
    this.updated_at = data.updated_at;
    this.created_at = data.created_at;
  }

  get body() {
    return this._body;
  }

  set body(newValue) {
    if (newValue != this._body) {
      this._body = newValue;
      this.updatedAt = moment();
    }
  }

  splitTitleFromBody() {
    var ret;
    var lines = this.body.split('\n');
    lines.forEach((row, index) => {
      if (ret) {return}
      if (row.length > 0) {
        ret = {
          title: _.trimLeft(row, '# '),
          body: lines.slice(0, index).concat(lines.splice(index+1)).join('\n')
        };
      }
    });
    if (ret) {return ret}
    return {
      title: '',
      body: this.body
    }
  }

  get bodyWithoutTitle() {
    return this.splitTitleFromBody().body;
  }

  get title() {
    return this.splitTitleFromBody().title;
  }

  get bodyWithDataURL() {
    return this.body.replace(
      /!\[(.*?)]\((pilemd:\/\/.*?)\)/mg,
      (match, p1, p2, offset, string) => {
        try {
          var dataURL = new Image(p2).convertDataURL();
        } catch (e) {
          console.log(e);
          return match
        }
        return '![' + p1 + ']' + '(' + dataURL + ')';
      }
    );
  }

  get img() {
    var matched = /(https?|pilemd):\/\/[-a-zA-Z0-9@:%_\+.~#?&//=]+?\.(png|jpeg|jpg|gif)/.exec(this.body);
    if (!matched) {
      return null
    } else {
      if (matched[1] == 'http' || matched[1] == 'https') {
        return matched[0]
      } else {
        try {
          var dataUrl = new Image(matched[0]).convertDataURL()
        } catch (e) {
          return null
        }
        return dataUrl
      }
    }
  }

  static latestUpdatedNote(notes) {
    return _.max(notes, function(n) { return n.updatedAt } );
  }

  static beforeNote(notes, note, property) {
    var sorted = arr.sortBy(notes, property);
    var before = sorted[sorted.indexOf(note)+1];
    if (!before) {
      // The note was latest one;
      return sorted.slice(-2)[0];
    } else {
      return before;
    }
  }

  static newEmptyNote(uid) {
    return new Note({body:"", folderUid: uid || null});
  }
}
Note.storagePrefix = 'notes';


class Folder extends Model {
  constructor(data) {
    super(data);

    this.name = data.name || '';
    this.rackUid = data.rackUid || null;
    this.ordering = data.ordering || 0;
    this.dragHover = false;
    this.sortUpper = false;
    this.sortLower = false;
  }

  remove(origNotes) {
    origNotes.forEach((note) => {
      if (note.folderUid == this.uid) {
        Note.removeModelFromStorage(note);
      }
    });
    Folder.removeModelFromStorage(this);
  }

  get data() {
    return _.assign(super.data, {
      name: this.name,
      rackUid: this.rackUid,
      ordering: this.ordering
    })
  }

  update(data) {
    super.update(data);
    this.name = data.name;
    this.rackUid = data.rackUid;
    this.ordering = data.ordering;
  }
}
Folder.storagePrefix = 'folders';


class Rack extends Model {
  constructor(data) {
    super(data);

    this.name = data.name || '';
    this.ordering = data.ordering || 0;
    this.dragHover = false;
    this.sortUpper = false;
    this.sortLower = false;

    this.folders = []
  }

  get data() {
    return _.assign(super.data, {
      name: this.name,
      ordering: this.ordering
    })
  }

  update(data) {
    super.update(data);
    this.name = data.name;
    this.ordering = data.ordering;
  }

  remove(origNotes, origFolders) {
    origFolders.forEach((folder) => {
      if (folder.rackUid == this.uid) {
        folder.remove(origNotes);
      }
    });
    Rack.removeModelFromStorage(this);
  }
}
Rack.storagePrefix = 'racks';


const CLASS_MAPPER = {
  notes: Note,
  folders: Folder,
  racks: Rack
};


function readDataFile(path) {
  var d = detectPath(path);
  if (!d) {return null}
  var dataType = d.dataType;
  var uid = d.uid;
  try {
    var data = JSON.parse(fs.readFileSync(path));
  } catch(e) {
    return null
  }
  data['uid'] = uid;  // TODO: Is it correct way?
  return {
    dataType: dataType,
    data: data,
    uid: uid
  }
}


function makeWatcher(racks, folders, notes) {
  var arrayMapper = {
    racks: racks,
    folders: folders,
    notes: notes
  };
  var watcher = chokidar.watch([], {
    depth: 1,
    ignoreInitial: true
  });
  watcher.on('add', (path) => {
    var d = readDataFile(path);
    if (!d) {return}
    if (!arrayMapper[d.dataType].find(uidFinder(d.uid))) {
      arrayMapper[d.dataType].push(new CLASS_MAPPER[d.dataType](d.data));
    }
  });
  watcher.on('change', (path) => {
    var d = readDataFile(path);
    if (!d) {return}
    var target = arrayMapper[d.dataType].find(uidFinder(d.uid));
    if (target) {
      target.update(d.data);
    }
  });
  watcher.on('unlink', (path) => {
    var d = detectPath(path);
    if (!d) {return}
    arr.remove(arrayMapper[d.dataType], uidFinder(d.uid));
  });
  watcher.add(getBaseLibraryPath());
  return watcher;
}


function copyData(fromDir, toDir) {
  Object.keys(CLASS_MAPPER).forEach((name) => {
    var toModelsPath = path.join(toDir, name);
    fs.mkdirSync(toModelsPath);
    var fromModelsPath = path.join(fromDir, name);
    var models = fs.readdirSync(fromModelsPath);
    models.forEach((n) => {
      var fromPath = path.join(fromModelsPath, n);
      var toPath = path.join(toModelsPath, n);
      fs.writeFileSync(toPath, fs.readFileSync(fromPath));
    });
  });
}


class Image {
  constructor (pilemdURL, name) {
    if (!pilemdURL.startsWith('pilemd://images/')) {
      throw "Incorrect Image URL"
    }
    this.pilemdURL = pilemdURL
    this.name = name
  }

  makeFilePath() {
    var p = this.pilemdURL.slice(9);
    var basePath = getBaseLibraryPath();
    if (!basePath || basePath.length == 0) throw "Invalid Base Path";
    return path.join(getBaseLibraryPath(), p)
  }

  convertDataURL() {
    return Datauri.sync(this.makeFilePath());
  }

  static appendSuffix(filePath) {
    var c = 'abcdefghijklmnopqrstuvwxyz';
    var r = '';
    for (var i = 0; i < 8; i++) {
      r += c[Math.floor(Math.random() * c.length)];
    }
    var e = path.extname(filePath);
    if (e.length > 0) {
      return filePath.slice(0, -e.length) + '_' + r + e
    } else {
      return filePath + '_' + r
    }
  }

  static fromBinary(name, frompath) {
    // Try creating images dir.
    var dirPath = path.join(getBaseLibraryPath(), 'images');
    try {fs.mkdirSync(dirPath)} catch (e) {}

    var savePath = path.join(dirPath, name);
    // Check exists or not.
    try {
      var fd = fs.openSync(savePath, 'r');
      if (fd) {fs.close(fd)}
      name = this.appendSuffix(name);
      savePath = path.join(dirPath, name);
    } catch(e) {}  // If not exists
    fs.writeFileSync(savePath, fs.readFileSync(frompath));
    var relativePath = path.join('images', name);
    return new this('pilemd://' + relativePath, name);
  }

  static fromClipboard(im){
    //create a name based on current date and save it.
    var d = new Date();
    var name = d.getFullYear().toString() + (d.getMonth()+1).toString()
        + d.getDate().toString() + '_' + d.getHours().toString()
        +d.getMinutes().toString() + d.getSeconds().toString() + ".png";

    var dirPath = path.join(getBaseLibraryPath(), 'images');
    try {fs.mkdirSync(dirPath)} catch (e) {}

    var savePath = path.join(dirPath, name);
    // Check exists or not.
    try {
      var fd = fs.openSync(savePath, 'r');
      if (fd) {fs.close(fd)}
      name = this.appendSuffix(name);
      savePath = path.join(dirPath, name);
    } catch(e) {}  // If not exists
    fs.writeFileSync(savePath, im.toPNG());
    var relativePath = path.join('images', name);
    console.log(name);
    return new this('pilemd://' + relativePath, name);
  }
}


module.exports = {
  Note: Note,
  Folder: Folder,
  Rack: Rack,
  uidFinder: uidFinder,
  getBaseLibraryPath: getBaseLibraryPath,
  setBaseLibraryPath: setBaseLibraryPath,
  makeWatcher: makeWatcher,
  copyData: copyData,
  Image: Image
};
