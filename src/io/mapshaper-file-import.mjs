import { importContent } from '../io/mapshaper-import';
import {
  isSupportedBinaryInputType,
  guessInputContentType,
  guessInputFileType,
  isZipFile,
  isKmzFile } from '../io/mapshaper-file-types';
import cmd from '../mapshaper-cmd';
import cli from '../cli/mapshaper-cli-utils';
import utils from '../utils/mapshaper-utils';
import { message, verbose, stop } from '../utils/mapshaper-logging';
import { parseLocalPath, getFileExtension, replaceFileExtension } from '../utils/mapshaper-filename-utils';
import { trimBOM, decodeString } from '../text/mapshaper-encodings';
import { extractFiles } from './mapshaper-zip';
import { buildTopology } from '../topology/mapshaper-topology';
import { cleanPathsAfterImport } from '../paths/mapshaper-path-import';
import { mergeDatasets } from '../dataset/mapshaper-merging';

cmd.importFiles = function(opts) {
  var files = opts.files || [];
  var dataset;

  cli.checkCommandEnv('i');
  if (opts.stdin) {
    return importFile('/dev/stdin', opts);
  }


  if (files.length > 0 === false) {
    stop('Missing input file(s)');
  }

  verbose("Importing: " + files.join(' '));

  // copy opts, so parameters can be modified within this command
  opts = Object.assign({}, opts);
  opts.input = Object.assign({}, opts.input); // make sure we have a cache

  files = expandFiles(files, opts.input);

  if (files.length === 0) {
    stop('Missing importable files');
  }

  if (files.length == 1) {
    dataset = importFile(files[0], opts);
  } else {
    dataset = importFilesTogether(files, opts);
  }

  if (opts.merge_files && files.length > 1) {
    // TODO: deprecate and remove this option (use -merge-layers cmd instead)
    dataset.layers = cmd.mergeLayers(dataset.layers);
  }
  return dataset;
};

function expandFiles(files, cache) {
  var files2 = [];
  files.forEach(function(file) {
    var expanded;
    if (isZipFile(file)) {
      expanded = expandZipFile(file, cache);
    } else if (isKmzFile(file)) {
      expanded = expandKmzFile(file, cache);
    } else {
      expanded = [file]; // ordinary file, no change
    }
    files2 = files2.concat(expanded);
  });
  return files2;
}

function expandKmzFile(file, cache) {
  var files = expandZipFile(file, cache);
  var name = replaceFileExtension(parseLocalPath(file).filename, 'kml');
  if (files[0] == 'doc.kml') {
    files[0] = name;
    cache[name] = cache['doc.kml'];
  }
  return files;
}

function expandZipFile(file, cache) {
  var input;
  if (file in cache) {
    input = cache[file];
  } else {
    input = file;
    cli.checkFileExists(file);
  }
  return extractFiles(input, cache);
}

// Let the web UI replace importFile() with a browser-friendly version
export function replaceImportFile(func) {
  _importFile = func;
}

export function importFile(path, opts) {
  return _importFile(path, opts);
}

var _importFile = function(path, opts) {
  var fileType = guessInputFileType(path),
      input = {},
      encoding = opts && opts.encoding || null,
      cache = opts && opts.input || null,
      cached = cache && (path in cache),
      content;

  cli.checkFileExists(path, cache);

  if ((fileType == 'shp' || fileType == 'json' || fileType == 'text' || fileType == 'dbf') && !cached) {
    // these file types are read incrementally
    content = null;

  } else if (fileType && isSupportedBinaryInputType(path)) {
    content = cli.readFile(path, null, cache);
    if (utils.isString(content)) {
      // Fix for issue #264 (applyCommands() input is file path instead of binary content)
      stop('Expected binary content, received a string');
    }

  } else if (fileType) { // string type, e.g. kml, geojson
    content = cli.readFile(path, encoding || 'utf-8', cache);

  } else if (getFileExtension(path) == 'gz') {
    var pathgz = path;
    path = pathgz.replace(/\.gz$/, '');
    fileType = guessInputFileType(path);
    if (!fileType) {
      stop('Unrecognized file type:', path);
    }
    // TODO: consider using a temp file, to support incremental reading
    // read to buffer, even for string-based types (to support larger input files)
    content = require('zlib').gunzipSync(cli.readFile(pathgz));

  } else { // type can't be inferred from filename -- try reading as text
    content = cli.readFile(path, encoding || 'utf-8', cache);
    fileType = guessInputContentType(content);
    if (fileType == 'text' && content.indexOf('\ufffd') > -1) {
      // invalidate string data that contains the 'replacement character'
      fileType = null;
    }
  }

  if (!fileType) {
    stop(getUnsupportedFileMessage(path));
  }
  input[fileType] = {filename: path, content: content};
  content = null; // for g.c.
  if (fileType == 'shp' || fileType == 'dbf') {
    readShapefileAuxFiles(path, input, cache);
  }
  if (fileType == 'shp' && !input.dbf) {
    message(utils.format("[%s] .dbf file is missing - shapes imported without attribute data.", path));
  }
  return importContent(input, opts);
};


function importZipFile(path, opts) {
  var cache = {};
  var input;
  if (opts.input && (path in opts.input)) {
    // reading from a buffer
    input = opts.input[path];
  } else {
    // reading from a file
    cli.checkFileExists(path);
    input = path;
  }
  var files = extractFiles(input, cache);
  var zipOpts = Object.assign({}, opts, {input: cache, files: files});
  return cmd.importFiles(zipOpts);
}

// Import multiple files to a single dataset
export function importFilesTogether(files, opts) {
  var unbuiltTopology = false;
  var datasets = files.map(function(fname) {
    // import without topology or snapping
    var importOpts = utils.defaults({no_topology: true, snap: false, snap_interval: null, files: [fname]}, opts);
    var dataset = importFile(fname, importOpts);
    // check if dataset contains non-topological paths
    // TODO: may also need to rebuild topology if multiple topojson files are merged
    if (dataset.arcs && dataset.arcs.size() > 0 && dataset.info.input_formats[0] != 'topojson') {
      unbuiltTopology = true;
    }
    return dataset;
  });
  var combined = mergeDatasets(datasets);
  // Build topology, if needed
  // TODO: consider updating topology of TopoJSON files instead of concatenating arcs
  // (but problem of mismatched coordinates due to quantization in input files.)
  if (unbuiltTopology && !opts.no_topology) {
    cleanPathsAfterImport(combined, opts);
    buildTopology(combined);
  }
  return combined;
}


function getUnsupportedFileMessage(path) {
  var ext = getFileExtension(path);
  var msg = 'Unable to import ' + path;
  if (ext.toLowerCase() == 'zip') {
    msg += ' (ZIP files must be unpacked before running mapshaper)';
  } else {
    msg += ' (unknown file type)';
  }
  return msg;
}

function readShapefileAuxFiles(path, obj, cache) {
  var dbfPath = replaceFileExtension(path, 'dbf');
  var shxPath = replaceFileExtension(path, 'shx');
  var cpgPath = replaceFileExtension(path, 'cpg');
  var prjPath = replaceFileExtension(path, 'prj');
  if (cli.isFile(prjPath, cache)) {
    obj.prj = {filename: prjPath, content: cli.readFile(prjPath, 'utf-8', cache)};
  }
  if (cli.isFile(shxPath, cache)) {
    obj.shx = {filename: shxPath, content: cli.readFile(shxPath, null, cache)};
  }
  if (!obj.dbf && cli.isFile(dbfPath, cache)) {
    // obj.dbf = {filename: dbfPath, content: cli.readFile(dbfPath, null, cache)};
    obj.dbf = {
      filename: dbfPath,
      content: (cache && (dbfPath in cache)) ? cli.readFile(dbfPath, null, cache) : null
    };
  }
  if (obj.dbf && cli.isFile(cpgPath, cache)) {
    obj.cpg = {filename: cpgPath, content: cli.readFile(cpgPath, 'utf-8', cache).trim()};
  }
}
