/*global Uint8Array,toBuffer */
/**
 * broccoli-mincer
 * 
 * Mince broccoli with sprockets
 */
'use strict';

var fs = require('node-fs');
var path = require('path');
var pathCompleteExtname = require('path-complete-extname');
var BroccoliHelpers = require('broccoli-kitchen-sink-helpers');
var Writer = require('broccoli-writer');
var glob = require('glob');
var Mincer = require('mincer');
var merge = require('deepmerge');
var SourceMapConsumer = require('source-map').SourceMapConsumer;
var SourceNode = require('source-map').SourceNode;
var pako = require('pako');

function BroccoliMincer(inputTree, options) {
  
  if (!(this instanceof BroccoliMincer)) {
    return new BroccoliMincer(inputTree, options);
  }
  
  // Init properties
  this.inputTree = inputTree;
  this.options = merge({
    digest: true,
    originalPaths: false,
    manifest: 'manifest.json',
    sourceMaps: false, 
    embedMappingComments: false, 
    compress: false,
    enable: [], 
    engines: {},
    paths: [],
    helpers: []
  }, options, {
    manifest: options.manifest && typeof options.manifest !== 'string' ? 'manifest.json' : undefined
  });
  
  // Setup during build
  this._environment = null;
}
BroccoliMincer.prototype = Object.create(Writer.prototype);
BroccoliMincer.prototype.constructor = Writer;
BroccoliMincer.prototype.description = 'broccoli-mincer';
BroccoliMincer.prototype.environment = function () {
  return this._environment;
};

BroccoliMincer.prototype.write = function (readPath, destDir) {
  
  var
    self = this,
    options = this.options,
    inputFiles = [],
    resolvedAssets = [],
    environment,
    Impl = options.impl || (!options.digest || options.originalPaths || !options.manifest ? BroccoliMincer.Manifest : Mincer.Manifest);
    //Impl = BroccoliMincer.Manifest;
   
  return readPath(this.inputTree).then(function (srcDir) {
  
    // Filter input files on order to allow none
    if (options.allowNone) {
      options.inputFiles.forEach(function (file) {
        if (glob.sync(file, {cwd: srcDir}).length > 0) {
          inputFiles.push(file);
        }
      });
    } else {
      inputFiles = options.inputFiles;
    }

    // Collect glob files
    try {
      inputFiles = BroccoliHelpers.multiGlob(inputFiles, {cwd: srcDir, allowNone: options.allowNone, nodir: true});
    } catch (e) {
      if (!options.allowNone) {
        throw e;
      }
    }
    
    // Strip out invalid files
    inputFiles = inputFiles.filter(function(file) {
      // Remove files without extension, i.e. LICENSE
      if (path.extname(path.basename(file)) !== "") {
        return file;
      }
      return null;
    });
    
    //console.log("Source assets: ", JSON.stringify({files: inputFiles}, null, "  "));
    
    if (!inputFiles.length && !options.allowNone) {
      throw("No valid input files found");
    }
    
    // Resolve asset paths
    resolvedAssets = inputFiles.map(function (file) {
      return path.join(path.resolve(srcDir), file);
    });
    
    // Init environment
    environment = self._environment = new Mincer.Environment(srcDir);
    
    // Configure engines
    Object.keys(options.engines).forEach(function (name) {
      var engine = Mincer[name + 'Engine'] || Mincer[name];
      if (!engine || typeof engine.configure !== 'function') {
        throw 'Invalid mincer engine ' + name;
      }
      engine.configure(options.engines[name]);
    });
    
    // Enable environment features
    var features = options.enable || [];
    features.forEach(function (feature) {
      environment.enable(feature);
    });
    
    // Auto enable source_maps-feature
    if (options.sourceMaps) {
      environment.enable('source_maps');
    }
  
    // Setup environment compressors
    if (options.jsCompressor) {
      environment.jsCompressor = options.jsCompressor;
    }
    if (options.cssCompressor) {
      environment.cssCompressor = options.cssCompressor;
    }
    
    // Register environment helpers
    Object.keys(options.helpers || []).forEach(function (name) {
      var helper = options.helpers[name].bind(self);
      environment.registerHelper(name, helper);
    });
    
    // Setup environment paths
    (typeof options.paths === "string" ? [options.paths] : options.paths || []).forEach(function (dir) {
      if (path.resolve(dir) !== path.normalize(dir)) {
        dir = path.join(path.resolve(srcDir), dir);
      }
      environment.appendPath(dir);
    });
    
    // Compile
    (new Impl(environment, path.join(destDir, options.manifest || ""))).compile(resolvedAssets, options);
    
  });
};

function writeFile(file, buffer, mtime) {
  mtime = mtime || new Date().getTime();
  if (!fs.existsSync(path.dirname(file))) {
    fs.mkdirSync(path.dirname(file), '0777', true);
  }
  fs.writeFileSync(file, buffer);
  fs.utimesSync(file, mtime, mtime);
}

// Compress given String or Buffer
function gzip(data) {
  var unit8Array = new Uint8Array(toBuffer(data));
  return new Buffer(pako.gzip(unit8Array));
}

function findAssetPath(asset, options) {
  options = options || {};
  if (asset) {
    var 
      assetPath = options.digest === undefined || options.digest ? asset.digestPath : asset.relativePath.replace(/^(?:\/|\\)/g, ''),
      assetDir = path.dirname(assetPath),
      assetBase = path.basename(assetPath, pathCompleteExtname(assetPath)),
      assetExt = path.extname(asset.digestPath);
      
    if (options.originalPaths) {
      assetDir = path.join(path.dirname(asset.relativePath));
    }
    assetPath = path.join(assetDir, assetBase) + assetExt;
    return assetPath;
  }
  return "";
}

BroccoliMincer.Manifest = function (environment, pathname) {
  this.environment = environment;
  this.path = pathname;
};

BroccoliMincer.Manifest.prototype.compile = function (files, options) {
  
  var
    environment = this.environment,
    data = {
      assets: {},
      files: {}
    },
    pathIsDir = fs.existsSync(this.path) && fs.lstatSync(this.path).isDirectory(),
    destDir = this.path && !pathIsDir ? path.dirname(this.path) : this.path;

  files.forEach(function (file) {

    var
      asset = environment.findAsset(file),
      assetPath = findAssetPath(asset, options),
      assetFile = path.join(destDir, assetPath),
      assetBuffer = asset.buffer;
    
    // Setup manifest data for asset
    data.assets[asset.logicalPath] = assetPath;
    data.files[assetPath] = {
      logicalPath: asset.logicalPath, 
      size: fs.statSync(file).size,
      mtime: asset.mtime, 
      digest: asset.digest
    };
    
    // Embed mapping comments
    if (options.embedMappingComments && options.sourceMaps && asset.sourceMap) {
      assetBuffer = new Buffer(asset.source + asset.mappingUrlComment());
    }
    
    // Write asset
    writeFile(assetFile, assetBuffer, asset.mtime);
    
    // Compress
    if (asset.type === 'bundled' && options.compress) {
      writeFile(assetFile + '.gz', gzip(assetBuffer), asset.mtime);
    }
    
    if (asset.sourceMap) {
      // add XSSI protection header
      writeFile(assetFile + '.map', ')]}\'\n' + asset.sourceMap, asset.mtime);
      if (options.compress) {
        writeFile(assetFile + '.map.gz', gzip(')]}\'\n' + asset.sourceMap), asset.mtime);
      }
    }
    
  });
  
  // Write manifest.json
  if (!pathIsDir) {
    writeFile(this.path, JSON.stringify(data, null, "  "));
  }
};


module.exports = BroccoliMincer;