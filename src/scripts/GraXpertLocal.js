#engine v8

// GraXpertLocal: run a locally installed GraXpert (CLI mode) on a PixInsight
// view. Written from scratch against GraXpert 4.0.0's documented CLI
// (`GraXpert -cli -cmd <cmd> -h`) and the public PJSR API.
//
// Install: Script > Feature Scripts... > Add > select this directory.
//
// Verified GraXpert 4.0.0 behaviour this script relies on:
//  - output is written to <output>.<input ext>, background to <output>_background.<ext>
//  - denoise result == original + strength * (AI - original), unclipped
//    (this makes the realtime preview and full-image re-apply exact: run AI once, blend locally)
//  - `-h` lists remote AI models as "available remotely: [...]"; a model is
//    downloaded before inference, so running on a blank image installs it.
//  - CoreML (GPU) denoising can crash; we retry once with -gpu false.
//  - 4.0.0 CLI has no deconvolution command; use Export/Import with the GUI.

#feature-id GraXpertLocal : Utilities > GraXpertLocal
#feature-info Background extraction (AI and sample-free) and AI denoising using a locally installed GraXpert.

#include <pjsr/ColorSpace.jsh>
#include <pjsr/DataType.jsh>
#include <pjsr/ImageOp.jsh>
#include <pjsr/SampleType.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/UndoFlag.jsh>

#define TITLE "GraXpertLocal"
#define VERSION "2.3"
#define SETTINGS_KEY "GraXpertLocal/"
#define DEFAULT_EXE "/Applications/GraXpert.app/Contents/MacOS/GraXpert"
#define PREVIEW_SIZE 512
#define MIN_GRAXPERT "4.0.0"

var CMD_AI_BGE = 0, CMD_SAMPLE_FREE = 1, CMD_DENOISE = 2, CMD_GRID = 3;
var GRID_METHODS = [ "RBF", "Kriging", "Splines" ];
// Minimum background points per method (GraXpert refuses fewer).
var GRID_MIN_POINTS = { RBF: 1, Kriging: 2, Splines: 16 };
var DOWNSAMPLE = [ 1, 2, 4, 8 ];
var MODEL_ROOT = File.homeDirectory + "/Library/Application Support/GraXpert/";
var EXPORT_DIR = File.homeDirectory + "/GraXpertLocal";
var GUI_PREFS = MODEL_ROOT + "preferences.json";
// Fallback remote model versions (GraXpert 4.0.0 `-h`), used when `-h` can't be parsed.
var REMOTE_MODELS = {
   "bge-ai-models": [ "1.0.1", "1.0.0" ],
   "denoise-ai-models": [ "3.0.2", "3.0.1", "3.0.0", "2.0.0", "1.1.0", "1.0.0" ]
};

// ---------------------------------------------------------------------------
// Parameters: defaults mirror GraXpert's own defaults (preferences.json / -h).

var FIELDS = {
   exe: DataType_String, command: DataType_Int32, gpu: DataType_Boolean,
   replaceImage: DataType_Boolean, showLogs: DataType_Boolean,
   correction: DataType_Int32, showBackground: DataType_Boolean,
   bgeAiVersion: DataType_String, smoothing: DataType_Double,
   sfScale: DataType_Double, sfSmoothness: DataType_Double, sfProtect: DataType_Boolean,
   sfThreshold: DataType_Double, sfAmount: DataType_Double, sfSimplified: DataType_Boolean,
   sfDegree: DataType_Int32, sfDownsample: DataType_Int32,
   denoiseAiVersion: DataType_String, strength: DataType_Double, batchSize: DataType_Int32,
   prefsFile: DataType_String, gridMethod: DataType_Int32
};

function Params()
{
   this.reset = function()
   {
      this.exe = DEFAULT_EXE;
      this.command = CMD_AI_BGE;
      this.gpu = true;
      this.replaceImage = true;
      this.showLogs = true;
      this.correction = 0;            // 0 = Subtraction, 1 = Division
      this.showBackground = false;
      this.bgeAiVersion = "latest";
      this.smoothing = 0.0;
      this.sfScale = 5.0;
      this.sfSmoothness = 1.0;
      this.sfProtect = true;
      this.sfThreshold = 0.05;
      this.sfAmount = 0.5;
      this.sfSimplified = true;
      this.sfDegree = 1;
      this.sfDownsample = 2;          // index into DOWNSAMPLE -> 4
      this.denoiseAiVersion = "latest";
      this.strength = 0.5;
      this.batchSize = 4;
      this.prefsFile = GUI_PREFS;
      this.gridMethod = 0;            // 0 = as set in GraXpert, else GRID_METHODS[i - 1]
   };
   this.reset();

   this.load = function()
   {
      for ( let k in FIELDS )
      {
         let v = Settings.read( SETTINGS_KEY + k, FIELDS[k] );
         if ( Settings.lastReadOK )
            this[k] = v;
      }
   };

   this.save = function()
   {
      for ( let k in FIELDS )
         Settings.write( SETTINGS_KEY + k, FIELDS[k], this[k] );
   };

   // Script instance (process icon / drag-and-drop) support.
   this.exportParameters = function()
   {
      for ( let k in FIELDS )
         Parameters.set( k, this[k] );
   };

   this.importParameters = function()
   {
      for ( let k in FIELDS )
         if ( Parameters.has( k ) )
            switch ( FIELDS[k] )
            {
            case DataType_String:  this[k] = Parameters.getString( k ); break;
            case DataType_Boolean: this[k] = Parameters.getBoolean( k ); break;
            case DataType_Int32:   this[k] = Parameters.getInteger( k ); break;
            default:               this[k] = Parameters.getReal( k ); break;
            }
   };
}

// ---------------------------------------------------------------------------
// File helpers

function writeXisf( image, path )
{
   let f = new FileFormatInstance( new FileFormat( ".xisf", false, true ) );
   if ( !f.create( path ) )
      throw new Error( "Cannot create " + path );
   let d = new ImageDescription;
   d.bitsPerSample = 32;
   d.ieeefpSampleFormat = true;
   f.setOptions( d );
   if ( !f.writeImage( image ) )
      throw new Error( "Cannot write " + path );
   f.close();
}

function readXisf( path )
{
   let f = new FileFormatInstance( new FileFormat( ".xisf", true, false ) );
   let d = f.open( path, "verbosity 0" );
   if ( !d || d.length < 1 )
      throw new Error( "GraXpert produced no readable output: " + path );
   let image = new Image( 1, 1, 1, ColorSpace_Gray, 32, SampleType_Real );
   if ( !f.readImage( image ) )
      throw new Error( "Cannot read " + path );
   f.close();
   return image;
}

function listSubdirs( dir )
{
   let out = [];
   let ff = new FileFind;
   if ( ff.begin( dir + "/*" ) )
      do
         if ( ff.isDirectory && ff.name != "." && ff.name != ".." )
            out.push( ff.name );
      while ( ff.next() );
   return out.sort().reverse();
}

// "latest", then local versions, then remote-only versions marked with " *".
function modelChoices( exe, kind )
{
   let local = listSubdirs( MODEL_ROOT + kind );
   let items = [ "latest" ].concat( local );
   for ( let v of remoteModels( exe, kind ) )
      if ( local.indexOf( v ) < 0 )
         items.push( v + " *" );
   return items;
}

function cleanVersion( v )
{
   v = String( v ).replace( "*", "" ).trim();
   return v.length > 0 ? v : "latest";
}

function appBundle( exe )
{
   return exe.replace( /\/Contents\/MacOS\/[^\/]+$/, "" );
}

// A picked .app bundle becomes the executable inside it.
function exeFromBundle( path )
{
   path = path.replace( /\/+$/, "" );
   return /\.app$/i.test( path ) ? path + "/Contents/MacOS/GraXpert" : path;
}

function safeId( view )
{
   return view.fullId.replace( /->/g, "_" ).replace( /[^A-Za-z0-9_]/g, "_" );
}

// ---------------------------------------------------------------------------
// GraXpert invocation

function buildArgs( p, input, output, overrides )
{
   let o = overrides || {};
   let gpu = "gpu" in o ? o.gpu : p.gpu;
   let args = [ "-cli", "-cmd", p.command == CMD_DENOISE ? "denoising" : "background-extraction",
                "-output", output, "-gpu", gpu ? "true" : "false" ];
   switch ( p.command )
   {
   case CMD_AI_BGE:
      args.push( "-interpolation", "AI", "-smoothing", p.smoothing.toFixed( 3 ) );
      if ( cleanVersion( p.bgeAiVersion ) != "latest" )
         args.push( "-ai_version", cleanVersion( p.bgeAiVersion ) );
      break;
   case CMD_SAMPLE_FREE:
      args.push( "-interpolation", "sample_free",
                 "-sample_free_scale", p.sfScale.toFixed( 2 ),
                 "-sample_free_smoothness", p.sfSmoothness.toFixed( 3 ),
                 "-sample_free_protect", p.sfProtect ? "true" : "false",
                 "-sample_free_protect_threshold", p.sfThreshold.toFixed( 3 ),
                 "-sample_free_protect_amount", p.sfAmount.toFixed( 3 ),
                 "-sample_free_simplified", p.sfSimplified ? "true" : "false",
                 "-sample_free_degree", String( p.sfDegree ),
                 "-sample_free_downsample", String( DOWNSAMPLE[p.sfDownsample] ) );
      break;
   case CMD_GRID:
      args.push( "-preferences_file", p.prefsFile, "-interpolation", gridMethod( p, readPrefs( p.prefsFile ) ),
                 "-smoothing", p.smoothing.toFixed( 3 ) );
      break;
   case CMD_DENOISE:
      args.push( "-strength", ( "strength" in o ? o.strength : p.strength ).toFixed( 3 ),
                 "-batch_size", String( p.batchSize ) );
      if ( cleanVersion( p.denoiseAiVersion ) != "latest" )
         args.push( "-ai_version", cleanVersion( p.denoiseAiVersion ) );
      break;
   }
   if ( p.command != CMD_DENOISE )
   {
      args.push( "-correction", p.correction == 0 ? "Subtraction" : "Division" );
      if ( p.showBackground )
         args.push( "-bg" );
   }
   args.push( input );
   return args;
}

// ---------------------------------------------------------------------------
// Grid extraction from points placed in the GraXpert GUI (-preferences_file).

function readPrefs( path )
{
   if ( !File.exists( path ) )
      throw new Error( "GraXpert preferences file not found: " + path );
   try
   {
      return JSON.parse( File.readTextFile( path ) );
   }
   catch ( e )
   {
      throw new Error( "Cannot parse " + path + ": " + e.message );
   }
}

function gridMethod( p, prefs )
{
   return p.gridMethod > 0 ? GRID_METHODS[p.gridMethod - 1] : prefs.interpol_type_option;
}

// GraXpert 4.0.0 does not check this itself: with a size mismatch it exits 0
// and extracts with misplaced points, so validate before running.
function checkGridPrefs( p, image )
{
   let prefs = readPrefs( p.prefsFile );
   let method = gridMethod( p, prefs );
   if ( GRID_METHODS.indexOf( method ) < 0 )
      throw new Error( "GraXpert is set to '" + method + "' interpolation; choose RBF, Kriging or Splines." );
   if ( prefs.width != image.width || prefs.height != image.height )
      throw new Error( "Background points were placed on a " + prefs.width + "x" + prefs.height +
                       " image, but the target is " + image.width + "x" + image.height +
                       ". Place the points on this image in GraXpert (Export to GraXpert), then close GraXpert." );
   let n = ( prefs.background_points || [] ).length;
   if ( n < GRID_MIN_POINTS[method] )
      throw new Error( method + " needs at least " + GRID_MIN_POINTS[method] + " background points; found " + n + "." );
   console.writeln( "Grid extraction: " + method + ", " + n + " background points from " + p.prefsFile );
}

function AbortError()
{
   this.message = "Aborted by user.";
}

// GraXpert log lines bracketing an AI model download. Killing GraXpert between
// them leaves a corrupt model folder, so Abort is disabled meanwhile.
var DOWNLOAD_START = "not found locally, downloading", DOWNLOAD_END = "download successful";

// Blocks until the process exits; keeps the GUI alive and honours console Abort.
// Output is always buffered; it is echoed live only when showLogs is set.
function runProcess( exe, args, showLogs )
{
   let log = "", downloading = false;
   let P = new ExternalProcess;
   let sink = s => { log += s; if ( showLogs ) console.write( s ); };
   P.onStandardOutputDataAvailable = () => sink( String( P.stdout ) );
   P.onStandardErrorDataAvailable = () => sink( String( P.stderr ) );
   if ( showLogs )
      console.noteln( exe + " " + args.join( " " ) );
   P.start( exe, args );
   if ( !P.waitForStarted() )
      throw new Error( "Cannot start: " + exe );
   console.abortEnabled = true;
   try
   {
      while ( !P.waitForFinished( 250 ) )
      {
         CoreApplication.processEvents();
         let d = log.lastIndexOf( DOWNLOAD_START ) > log.lastIndexOf( DOWNLOAD_END );
         if ( d != downloading )
         {
            downloading = d;
            console.abortEnabled = !d;
            if ( d )
               console.warningln( "Downloading AI model, please wait. Abort is disabled until it completes." );
            else
               console.noteln( "AI model download completed." );
         }
         if ( !downloading && console.abortRequested )
         {
            P.kill();
            throw new AbortError;
         }
      }
   }
   finally
   {
      console.abortEnabled = false;
   }
   return { exitCode: P.exitCode, log: log };
}

// Runs GraXpert; on failure with GPU enabled retries once on CPU.
// Logs are always printed when the run fails, whatever showLogs says.
function runGraXpert( p, input, output, overrides )
{
   if ( !File.exists( p.exe ) )
      throw new Error( "GraXpert executable not found: " + p.exe );
   checkVersion( p.exe );
   confirmDownload( p );
   let o = overrides || {};
   let r = runProcess( p.exe, buildArgs( p, input, output, o ), p.showLogs );
   if ( r.exitCode != 0 && p.gpu && o.gpu !== false )
   {
      if ( !p.showLogs )
         console.write( r.log );
      console.warningln( "GraXpert failed with GPU acceleration; retrying on CPU." );
      o.gpu = false;
      r = runProcess( p.exe, buildArgs( p, input, output, o ), p.showLogs );
   }
   if ( r.exitCode != 0 )
   {
      if ( !p.showLogs )
         console.write( r.log );
      throw new Error( "GraXpert exited with code " + r.exitCode );
   }
}

// "GraXpert version: 4.0.0 release: Charon" -> "4.0.0"; null if unparseable.
// Cached per executable path: `-v` costs about a second.
var versionCache = {};
function graxpertVersion( exe )
{
   if ( !( exe in versionCache ) )
   {
      let m = runProcess( exe, [ "-v" ], false ).log.match( /GraXpert version:\s*(\d+(?:\.\d+)*)/ );
      versionCache[exe] = m ? m[1] : null;
   }
   return versionCache[exe];
}

// Versions from the `-ai_version` help text, which argparse wraps over several
// log lines: "... available remotely: [1.0.1, 1.0.0]". Null if absent.
function parseRemoteModels( log )
{
   let m = log.replace( /^.*root INFO/gm, "" ).replace( /\s+/g, " " )
              .match( /available remotely:\s*\[([^\]]*)\]/ );
   return m ? m[1].match( /\d+\.\d+\.\d+/g ) : null;
}

// Remote model versions as GraXpert itself reports them, newest first.
// Cached per executable and kind: each `-h` costs about a second.
var remoteCache = {};
function remoteModels( exe, kind )
{
   let key = exe + "|" + kind;
   if ( !( key in remoteCache ) )
   {
      if ( !File.exists( exe ) )
         return REMOTE_MODELS[kind];
      let list = null;
      try
      {
         list = parseRemoteModels( runProcess( exe, [ "-cli", "-cmd",
                   kind == "denoise-ai-models" ? "denoising" : "background-extraction", "-h" ], false ).log );
      }
      catch ( e ) {}
      if ( !list )
         console.warningln( "Cannot read remote " + kind + " from GraXpert; using the built-in list." );
      remoteCache[key] = list || REMOTE_MODELS[kind];
   }
   return remoteCache[key];
}

function versionLess( a, b )
{
   let x = a.split( "." ).map( Number ), y = b.split( "." ).map( Number );
   for ( let i = 0; i < Math.max( x.length, y.length ); ++i )
      if ( ( x[i] || 0 ) != ( y[i] || 0 ) )
         return ( x[i] || 0 ) < ( y[i] || 0 );
   return false;
}

function checkVersion( exe )
{
   let v = graxpertVersion( exe );
   if ( v === null )
      console.warningln( "Cannot determine GraXpert version; assuming " + MIN_GRAXPERT + " or later." );
   else if ( versionLess( v, MIN_GRAXPERT ) )
      throw new Error( "GraXpert " + v + " is not supported; version " + MIN_GRAXPERT + " or later is required." );
}

// Asks before GraXpert downloads a selected model that is not installed yet.
// Headless (view-target) runs proceed without asking.
function confirmDownload( p )
{
   let kind, v;
   if ( p.command == CMD_AI_BGE )
      kind = "bge-ai-models", v = cleanVersion( p.bgeAiVersion );
   else if ( p.command == CMD_DENOISE )
      kind = "denoise-ai-models", v = cleanVersion( p.denoiseAiVersion );
   else
      return;
   if ( v == "latest" || File.directoryExists( MODEL_ROOT + kind + "/" + v ) || Parameters.isViewTarget )
      return;
   if ( new MessageBox( "AI model " + v + " is not installed.\n\nShould GraXpert download it now? " +
                        "This may take a few minutes and cannot be aborted.",
                        TITLE, StdIcon_Question, StdButton_Yes, StdButton_No ).execute() != StdButton_Yes )
      throw new AbortError;
}

// Installs the selected AI model ("latest" = newest remote) ahead of a real run
// by processing a blank image. CPU only: CoreML can crash on the blank image,
// and the download happens before inference anyway.
function downloadModel( p )
{
   let kind = p.command == CMD_DENOISE ? "denoise-ai-models" : "bge-ai-models";
   let field = p.command == CMD_DENOISE ? "denoiseAiVersion" : "bgeAiVersion";
   let v = cleanVersion( p[field] );
   if ( v == "latest" )
      v = remoteModels( p.exe, kind )[0];
   let dir = MODEL_ROOT + kind + "/" + v;
   if ( File.directoryExists( dir ) )
   {
      console.noteln( "AI model " + v + " is already installed." );
      return;
   }
   let q = Object.assign( new Params, p, { showBackground: false } );
   q[field] = v;
   let base = tempBase();
   let input = base + "_in.xisf", output = base + "_out";
   let blank = new Image( 256, 256, 1, ColorSpace_Gray, 32, SampleType_Real );
   try
   {
      blank.fill( 0 );
      writeXisf( blank, input );
      runGraXpert( q, input, output, { gpu: false } );
   }
   finally
   {
      blank.free();
      removeFiles( [ input, output + ".xisf" ] );
   }
   if ( !File.directoryExists( dir ) )
      throw new Error( "GraXpert finished but AI model " + v + " is not in " + MODEL_ROOT + kind );
   console.noteln( "AI model " + v + " installed." );
}

function tempBase()
{
   return File.systemTempDirectory + "/GraXpertLocal_" + Date.now();
}

function removeFiles( files )
{
   for ( let f of files )
      if ( File.exists( f ) )
         File.remove( f );
}

// ---------------------------------------------------------------------------
// Image windows

// Opens image in a new window; with a source view, copies its STF and, when the
// geometry still matches, its FITS keywords and astrometric solution.
function newWindow( image, id, source )
{
   let w = new ImageWindow( image.width, image.height, image.numberOfChannels, 32, true,
                            image.isColor, id );
   w.mainView.beginProcess( UndoFlag_NoSwapFile );
   w.mainView.image.assign( image );
   w.mainView.endProcess();
   if ( source )
      copyMetadata( source, w );
   w.show();
   return w;
}

function copyMetadata( source, w )
{
   let sw = source.window;
   w.mainView.stf = sw.mainView.stf;
   let si = sw.mainView.image, di = w.mainView.image;
   if ( si.width != di.width || si.height != di.height )
      return;   // preview crop or resized result: header and WCS would be wrong
   w.keywords = sw.keywords;
   if ( sw.hasAstrometricSolution )
      w.copyAstrometricSolution( sw );
}

function execute( p, view )
{
   let base = tempBase();
   let input = base + "_in.xisf", output = base + "_out";
   try
   {
      if ( p.command == CMD_GRID )
         checkGridPrefs( p, view.image );
      writeXisf( view.image, input );
      runGraXpert( p, input, output );

      let result = readXisf( output + ".xisf" );
      if ( p.replaceImage )
      {
         view.beginProcess();
         view.image.assign( result );
         view.endProcess();
      }
      else
         newWindow( result, safeId( view ) + "_GraXpert", view );
      result.free();

      if ( p.command != CMD_DENOISE && p.showBackground )
      {
         let bg = readXisf( output + "_background.xisf" );
         newWindow( bg, safeId( view ) + "_background", view );
         bg.free();
      }
   }
   finally
   {
      removeFiles( [ input, output + ".xisf", output + "_background.xisf" ] );
   }
}

// ---------------------------------------------------------------------------
// Tools

function copyRect( src, rect )
{
   let img = new Image( rect.width, rect.height, src.numberOfChannels,
                        src.isColor ? ColorSpace_RGB : ColorSpace_Gray, 32, SampleType_Real );
   let buf = [];
   for ( let c = 0; c < src.numberOfChannels; ++c )
   {
      src.getSamples( buf, rect, c );
      img.setSamples( buf, new Rect( 0, 0, rect.width, rect.height ), c );
   }
   return img;
}

// Scaled noise estimate per channel (MRS, falling back to k-sigma), as sigma/Sn.
function evaluateNoise( view )
{
   let image = view.image;
   console.noteln( "Noise evaluation: " + view.fullId );
   for ( let c = 0; c < image.numberOfChannels; ++c )
   {
      image.selectedChannel = c;
      let scale = image.Sn();
      if ( 1 + scale == 1 )
      {
         console.warningln( "  channel " + c + ": no significant data" );
         continue;
      }
      let a, n = 4, minCount = 0.01 * image.selectedRect.area;
      for ( ;; )
      {
         a = image.noiseMRS( n );
         if ( a[1] >= minCount )
            break;
         if ( --n == 1 )
         {
            a = image.noiseKSigma();
            break;
         }
      }
      console.writeln( format( "  channel %d: sigma = %.4e  (%.2f%% pixels, %d layers)",
                               c, a[0] / scale, 100 * a[1] / image.selectedRect.area, n ) );
   }
   image.resetSelections();
}

function showInfo( p )
{
   console.noteln( TITLE + " " + VERSION );
   console.writeln( "Executable:  " + p.exe + ( File.exists( p.exe ) ? "" : "  (NOT FOUND)" ) );
   if ( File.exists( p.exe ) )
   {
      let v = graxpertVersion( p.exe );
      console.writeln( "GraXpert version: " + ( v || "unknown" ) +
                       ( v && versionLess( v, MIN_GRAXPERT ) ? "  (UNSUPPORTED, need " + MIN_GRAXPERT + "+)" : "" ) );
   }
   for ( let kind of [ "bge-ai-models", "denoise-ai-models",
                       "deconvolution-object-ai-models", "deconvolution-stars-ai-models" ] )
      console.writeln( kind + ": local [" + listSubdirs( MODEL_ROOT + kind ).join( ", " ) + "]" +
                       ( REMOTE_MODELS[kind] ? ", remote [" + remoteModels( p.exe, kind ).join( ", " ) + "]" : "" ) );
   console.writeln( "Export folder: " + EXPORT_DIR );
}

function launchGui( p, file )
{
   let args = [ "-n", "-a", appBundle( p.exe ) ];
   if ( file )
      args.push( "--args", file );
   // `open` hands off to LaunchServices and returns at once, so a blocking run is fine.
   if ( runProcess( "/usr/bin/open", args, false ).exitCode != 0 )
      throw new Error( "Cannot launch " + appBundle( p.exe ) );
}

function exportToGui( p, view )
{
   if ( !File.directoryExists( EXPORT_DIR ) )
      File.createDirectory( EXPORT_DIR, true );
   let path = EXPORT_DIR + "/" + safeId( view ) + ".xisf";
   writeXisf( view.image, path );
   Settings.write( SETTINGS_KEY + "lastExport", DataType_String, path );
   console.noteln( "Exported " + path );
   launchGui( p, path );
}

// Opens every image GraXpert's GUI saved in the export folder after the last export.
function importFromGui( view )
{
   let exported = Settings.read( SETTINGS_KEY + "lastExport", DataType_String );
   if ( !Settings.lastReadOK || !File.exists( exported ) )
      throw new Error( "Nothing exported yet." );
   let since = new FileInfo( exported ).lastModified.getTime();
   let found = 0;
   let ff = new FileFind;
   if ( ff.begin( EXPORT_DIR + "/*" ) )
      do
      {
         let path = EXPORT_DIR + "/" + ff.name;
         if ( ff.isFile && path != exported && /\.(xisf|fits?|tiff?)$/i.test( ff.name ) &&
              ff.lastModified.getTime() > since )
         {
            for ( let w of ImageWindow.open( path ) )
            {
               copyMetadata( view, w );
               w.show();
            }
            ++found;
         }
      }
      while ( ff.next() );
   if ( found == 0 )
      throw new Error( "No new images in " + EXPORT_DIR + ". Save the result there from GraXpert first." );
}

// ---------------------------------------------------------------------------
// Denoise strength blending: the AI runs once at strength 1 and any strength is
// then orig + strength * diff, computed locally.

// AI result minus input, at strength 1.
function denoiseDiff( p, image )
{
   let base = tempBase();
   let input = base + "_in.xisf", output = base + "_out";
   let diff;
   try
   {
      writeXisf( image, input );
      runGraXpert( p, input, output, { strength: 1.0 } );
      diff = readXisf( output + ".xisf" );
   }
   finally
   {
      removeFiles( [ input, output + ".xisf" ] );
   }
   diff.apply( image, ImageOp_Sub );
   return diff;
}

function blend( orig, diff, strength )
{
   let t = new Image( diff );
   t.apply( strength, ImageOp_Mul );
   t.apply( orig, ImageOp_Add );
   return t;
}

// Realtime preview on a crop: moving the Strength slider re-blends instantly.
function DenoisePreview()
{
   this.orig = null;
   this.diff = null;
   this.window = null;

   this.open = function( p, view )
   {
      this.close();
      let src = view.image;
      let w = Math.min( PREVIEW_SIZE, src.width ), h = Math.min( PREVIEW_SIZE, src.height );
      let rect = view.isPreview ? new Rect( 0, 0, src.width, src.height )
                                : new Rect( ( src.width - w ) >> 1, ( src.height - h ) >> 1,
                                            ( ( src.width - w ) >> 1 ) + w, ( ( src.height - h ) >> 1 ) + h );
      let crop = copyRect( src, rect );
      this.diff = denoiseDiff( p, crop );
      this.orig = crop;
      this.window = newWindow( crop, "GraXpertLocal_preview", view );
      this.update( p.strength );
   };

   this.update = function( strength )
   {
      if ( !this.window || this.window.isNull )
         return;
      let t = blend( this.orig, this.diff, strength );
      try
      {
         let v = this.window.mainView;
         v.beginProcess( UndoFlag_NoSwapFile );
         v.image.assign( t );
         v.endProcess();
      }
      catch ( e )
      {
         this.window = null;   // user closed the preview window
      }
      t.free();
   };

   this.close = function()
   {
      try { if ( this.window && !this.window.isNull ) this.window.forceClose(); } catch ( e ) {}
      if ( this.orig ) this.orig.free();
      if ( this.diff ) this.diff.free();
      this.orig = this.diff = this.window = null;
   };
}

// Full-image denoise from the dialog: the AI runs once per (view, model); a
// later Apply with another strength only re-blends. The dialog is modal, so
// nothing else can change the view while this cache lives. The original is
// kept, so re-applying in Replace mode never denoises an already denoised image.
function DenoiseFull()
{
   this.viewId = null;
   this.model = null;
   this.orig = null;
   this.diff = null;
   this.window = null;   // result window in new-image mode, reused across Applies

   this.apply = function( p, view )
   {
      if ( this.viewId != view.fullId )
      {
         this.close();
         this.viewId = view.fullId;
         this.orig = new Image( view.image );
      }
      let model = cleanVersion( p.denoiseAiVersion );
      if ( !this.diff || this.model != model )
      {
         if ( this.diff ) this.diff.free();
         this.diff = null;
         this.diff = denoiseDiff( p, this.orig );
         this.model = model;
      }
      else
         console.noteln( "Reusing the AI result; blending strength " + p.strength.toFixed( 3 ) + "." );
      let t = blend( this.orig, this.diff, p.strength );
      try
      {
         let v = p.replaceImage ? view : this.window && !this.window.isNull ? this.window.mainView : null;
         if ( v )
         {
            v.beginProcess();
            v.image.assign( t );
            v.endProcess();
         }
         else
            this.window = newWindow( t, safeId( view ) + "_GraXpert", view );
      }
      finally
      {
         t.free();
      }
   };

   this.close = function()
   {
      if ( this.orig ) this.orig.free();
      if ( this.diff ) this.diff.free();
      this.orig = this.diff = this.viewId = this.model = this.window = null;
   };
}

// ---------------------------------------------------------------------------
// Dialog

var GraXpertLocalDialog = class extends Dialog
{
   constructor( p )
   {
      super();
      this.windowTitle = TITLE + " " + VERSION;
      this.resetRequested = false;
      let dialog = this;
      let preview = new DenoisePreview;
      const labelWidth = this.font.width( "Threshold:MMMM" );

      function label( parent, text )
      {
         let l = new Label( parent );
         l.text = text;
         l.minWidth = labelWidth;
         l.textAlignment = TextAlign_Right | TextAlign_VertCenter;
         return l;
      }

      function row( parent, text, control )
      {
         let s = new HorizontalSizer;
         s.spacing = 6;
         s.add( label( parent, text ) );
         s.add( control, 100 );
         return s;
      }

      function numeric( parent, text, value, min, max, precision, onChange, tip )
      {
         let n = new NumericControl( parent );
         n.label.text = text;
         n.label.minWidth = labelWidth;
         n.setRange( min, max );
         n.setPrecision( precision );
         n.slider.setRange( 0, 1000 );
         n.setValue( value );
         n.onValueUpdated = onChange;
         if ( tip )
            n.toolTip = tip;
         return n;
      }

      function check( parent, text, value, onChange )
      {
         let c = new CheckBox( parent );
         c.text = text;
         c.checked = value;
         c.onCheck = onChange;
         return c;
      }

      function button( parent, text, tip, onClick )
      {
         let b = new PushButton( parent );
         b.text = text;
         b.toolTip = tip;
         b.onClick = () =>
         {
            try { onClick(); }
            catch ( e ) { if ( !( e instanceof AbortError ) ) new MessageBox( e.message, TITLE ).execute(); console.criticalln( e.message ); }
         };
         return b;
      }

      function group( title, items )
      {
         let g = new GroupBox( dialog );
         g.title = title;
         g.sizer = new VerticalSizer;
         g.sizer.margin = 6;
         g.sizer.spacing = 4;
         for ( let i of items( g ) )
            g.sizer.add( i );
         return g;
      }

      function target()
      {
         let v = dialog.viewList.currentView;
         if ( v.isNull )
            throw new Error( "Select a target view." );
         return v;
      }

      // --- general
      this.viewList = new ViewList( this );
      this.viewList.getAll();
      if ( !ImageWindow.activeWindow.isNull )
         this.viewList.currentView = ImageWindow.activeWindow.currentView;

      this.exeEdit = new Edit( this );
      this.exeEdit.text = p.exe;
      this.exeEdit.toolTip = "Path to the GraXpert executable inside the app bundle.";
      this.exeEdit.onEditCompleted = function() { p.exe = this.text.trim(); };

      this.exeButton = new ToolButton( this );
      this.exeButton.icon = this.scaledResource( ":/icons/select-file.png" );
      this.exeButton.setScaledFixedSize( 22, 22 );
      this.exeButton.toolTip = "Select GraXpert.app (or the executable itself).";
      this.exeButton.onClick = function()
      {
         let fd = new OpenFileDialog;
         fd.caption = "Select GraXpert.app";
         fd.initialPath = "/Applications";
         fd.filters = [ [ "Applications", "*.app" ], [ "All files", "*" ] ];
         if ( fd.execute() )
            dialog.exeEdit.text = p.exe = exeFromBundle( fd.fileName );
      };
      this.exeSizer = new HorizontalSizer;
      this.exeSizer.spacing = 4;
      this.exeSizer.add( this.exeEdit, 100 );
      this.exeSizer.add( this.exeButton );

      this.commandCombo = new ComboBox( this );
      this.commandCombo.addItem( "AI background extraction" );
      this.commandCombo.addItem( "Sample-free background extraction" );
      this.commandCombo.addItem( "AI denoising" );
      this.commandCombo.addItem( "Background extraction with GraXpert points (RBF/Kriging/Splines)" );
      this.commandCombo.currentItem = p.command;

      this.modelCombo = new ComboBox( this );
      this.modelCombo.editEnabled = true;
      this.modelCombo.toolTip = "AI model version. * = not stored locally, GraXpert downloads it first (do not abort the download).";
      let modelField = () => p.command == CMD_DENOISE ? "denoiseAiVersion" : "bgeAiVersion";
      let usesModel = () => p.command == CMD_AI_BGE || p.command == CMD_DENOISE;
      this.syncModel = function()
      {
         if ( usesModel() )
            p[modelField()] = cleanVersion( dialog.modelCombo.editText );
      };
      this.fillModels = function()
      {
         dialog.modelCombo.clear();
         if ( !usesModel() )
            return;
         let items = modelChoices( p.exe, p.command == CMD_DENOISE ? "denoise-ai-models" : "bge-ai-models" );
         for ( let i of items )
            dialog.modelCombo.addItem( i );
         let cur = cleanVersion( p[modelField()] );
         let idx = items.findIndex( i => cleanVersion( i ) == cur );
         if ( idx >= 0 )
            dialog.modelCombo.currentItem = idx;
         else
            dialog.modelCombo.editText = cur;
      };
      this.downloadButton = button( this, "Download", "Install the selected AI model now (\"latest\" = newest remote " +
                                    "version), so a later run does not stop to download it.",
                                    () => { dialog.syncModel(); downloadModel( p ); dialog.fillModels(); } );
      let modelSizer = new HorizontalSizer;
      modelSizer.spacing = 4;
      modelSizer.add( this.modelCombo, 100 );
      modelSizer.add( this.downloadButton );
      this.modelRow = row( this, "AI model:", modelSizer );

      // --- AI background extraction
      // Shared by AI and grid extraction (both map to -smoothing).
      this.aiBgeGroup = group( "Background model", g => [
         numeric( g, "Smoothing:", p.smoothing, 0, 1, 3, v => p.smoothing = v,
                  "Smoothing of the background model; 0 is usually best for AI." ) ] );

      // --- grid extraction from GraXpert GUI points
      this.prefsEdit = new Edit( this );
      this.prefsEdit.text = p.prefsFile;
      this.prefsEdit.toolTip = "GraXpert preferences file holding the background points. GraXpert writes it when its window is closed.";
      this.prefsEdit.onEditCompleted = function() { p.prefsFile = this.text.trim(); };
      this.gridCombo = new ComboBox( this );
      this.gridCombo.addItem( "As set in GraXpert" );
      for ( let m of GRID_METHODS )
         this.gridCombo.addItem( m );
      this.gridCombo.currentItem = p.gridMethod;
      this.gridCombo.onItemSelected = i => p.gridMethod = i;
      this.gridGroup = group( "GraXpert background points", g => [
         row( g, "Preferences:", this.prefsEdit ),
         row( g, "Method:", this.gridCombo ),
         button( g, "Check points", "Validate the preferences file against the target image.",
                 () => { p.prefsFile = dialog.prefsEdit.text.trim(); checkGridPrefs( p, target().image ); } ) ] );

      // --- Sample-free background extraction
      this.downsampleCombo = new ComboBox( this );
      for ( let d of DOWNSAMPLE )
         this.downsampleCombo.addItem( String( d ) );
      this.downsampleCombo.currentItem = p.sfDownsample;
      this.downsampleCombo.onItemSelected = i => p.sfDownsample = i;
      this.degreeSpin = new SpinBox( this );
      this.degreeSpin.setRange( 1, 6 );
      this.degreeSpin.value = p.sfDegree;
      this.degreeSpin.onValueUpdated = v => p.sfDegree = v;
      this.sfGroup = group( "Sample-free background extraction", g => [
         numeric( g, "Scale:", p.sfScale, 1, 10, 2, v => p.sfScale = v,
                  "Size of structures treated as background; higher = broader model." ),
         numeric( g, "Smoothing:", p.sfSmoothness, 0, 10, 3, v => p.sfSmoothness = v,
                  "Final smoothing of the background model." ),
         check( g, "Structure protection", p.sfProtect, on => p.sfProtect = on ),
         numeric( g, "Threshold:", p.sfThreshold, 0, 1, 3, v => p.sfThreshold = v,
                  "Brightness difference where protection starts; lower protects fainter structures." ),
         numeric( g, "Amount:", p.sfAmount, 0, 1, 3, v => p.sfAmount = v,
                  "How far protected regions extend around detected structures." ),
         check( g, "Simplified model (fit polynomial first)", p.sfSimplified, on => p.sfSimplified = on ),
         row( g, "Polynomial degree:", this.degreeSpin ),
         row( g, "Down sample:", this.downsampleCombo ) ] );

      // --- shared background options
      this.correctionCombo = new ComboBox( this );
      this.correctionCombo.addItem( "Subtraction" );
      this.correctionCombo.addItem( "Division" );
      this.correctionCombo.currentItem = p.correction;
      this.correctionCombo.toolTip = "Subtraction for most cases; Division for strong vignetting.";
      this.correctionCombo.onItemSelected = i => p.correction = i;
      this.bgOptGroup = group( "Background options", g => [
         row( g, "Correction:", this.correctionCombo ),
         check( g, "Show background model", p.showBackground, on => p.showBackground = on ) ] );

      // --- denoising
      this.batchSpin = new SpinBox( this );
      this.batchSpin.setRange( 1, 32 );
      this.batchSpin.value = p.batchSize;
      this.batchSpin.toolTip = "Tiles processed in parallel; high values may run out of memory.";
      this.batchSpin.onValueUpdated = v => p.batchSize = v;
      this.dnGroup = group( "AI denoising", g => [
         numeric( g, "Strength:", p.strength, 0, 2, 3, v => { p.strength = v; preview.update( v ); },
                  "0 = original, 1 = AI result; values above 1 strengthen further." ),
         row( g, "Batch size:", this.batchSpin ),
         button( g, "Realtime preview", "Denoise a " + PREVIEW_SIZE + " px centre crop (or the whole selected preview) once; " +
                 "moving Strength then updates the preview instantly.",
                 () => { dialog.syncModel(); preview.open( p, target() ); } ) ] );

      // --- global
      this.globalGroup = group( "Global", g => [
         check( g, "Replace image (otherwise create a new one)", p.replaceImage, on => p.replaceImage = on ),
         check( g, "Show GraXpert logs", p.showLogs, on => p.showLogs = on ),
         check( g, "GPU acceleration (falls back to CPU on failure)", p.gpu, on => p.gpu = on ) ] );

      // --- tools
      let tools1 = new HorizontalSizer;
      tools1.spacing = 6;
      tools1.add( button( this, "Noise evaluation", "Print scaled noise estimates of the target to the console.",
                          () => evaluateNoise( target() ) ) );
      tools1.add( button( this, "Info", "Print GraXpert version, paths and AI models to the console.",
                          () => showInfo( p ) ) );
      tools1.addStretch();
      let tools2 = new HorizontalSizer;
      tools2.spacing = 6;
      tools2.add( button( this, "Launch GraXpert", "Open the GraXpert application.", () => launchGui( p ) ) );
      tools2.add( button( this, "Export to GraXpert", "Save the target to " + EXPORT_DIR + " and open it in GraXpert " +
                          "(use this for deconvolution, which GraXpert 4.0.0 offers only in its GUI).",
                          () => exportToGui( p, target() ) ) );
      tools2.add( button( this, "Import result", "Open images saved by GraXpert into " + EXPORT_DIR + " since the last export.",
                          () => importFromGui( target() ) ) );
      tools2.addStretch();
      this.toolsGroup = group( "GraXpert UI and tools", g => [ tools1, tools2 ] );

      this.updateVisibility = function()
      {
         dialog.aiBgeGroup.visible = p.command == CMD_AI_BGE || p.command == CMD_GRID;
         dialog.gridGroup.visible = p.command == CMD_GRID;
         dialog.sfGroup.visible = p.command == CMD_SAMPLE_FREE;
         dialog.bgOptGroup.visible = p.command != CMD_DENOISE;
         dialog.dnGroup.visible = p.command == CMD_DENOISE;
         dialog.modelCombo.enabled = dialog.downloadButton.enabled = usesModel();
         dialog.fillModels();
         dialog.adjustToContents();
      };
      this.commandCombo.onItemSelected = function( i )
      {
         dialog.syncModel();
         p.command = i;
         if ( i != CMD_DENOISE )
            preview.close();
         dialog.updateVisibility();
      };

      // --- buttons
      this.newInstanceButton = new ToolButton( this );
      this.newInstanceButton.icon = this.scaledResource( ":/process-interface/new-instance.png" );
      this.newInstanceButton.setScaledFixedSize( 24, 24 );
      this.newInstanceButton.toolTip = "New instance: drag onto an image to run, or onto the workspace for a process icon.";
      this.newInstanceButton.onMousePress = function()
      {
         this.hasFocus = true;
         p.exe = dialog.exeEdit.text.trim();
         p.prefsFile = dialog.prefsEdit.text.trim();
         dialog.syncModel();
         p.exportParameters();
         this.pushed = false;
         this.dialog.newInstance();
      };

      let full = new DenoiseFull;
      let finish = ok =>
      {
         preview.close();
         full.close();
         if ( ok ) dialog.ok(); else dialog.cancel();
      };
      this.resetButton = button( this, "Reset", "Restore all parameters to defaults.",
                                 () => { dialog.resetRequested = true; finish( false ); } );
      this.okButton = button( this, "Apply", "Process the target view. For AI denoising the dialog stays open: " +
                              "change Strength and Apply again to re-blend without re-running the AI.", () =>
      {
         let v = target();
         p.exe = dialog.exeEdit.text.trim();
         p.prefsFile = dialog.prefsEdit.text.trim();
         dialog.syncModel();
         if ( p.command != CMD_DENOISE )
            return finish( true );
         full.apply( p, v );
         console.noteln( TITLE + ": done on " + v.fullId );
      } );
      this.cancelButton = button( this, "Close", "", () => finish( false ) );

      let buttons = new HorizontalSizer;
      buttons.spacing = 6;
      buttons.add( this.newInstanceButton );
      buttons.add( this.resetButton );
      buttons.addStretch();
      buttons.add( this.okButton );
      buttons.add( this.cancelButton );

      this.sizer = new VerticalSizer;
      this.sizer.margin = 8;
      this.sizer.spacing = 6;

      // GraXpert app icon (PNG next to this script, 2x for Retina; skipped if missing) plus a
      // bold name in the theme's text colour, so it reads on both light and dark themes.
      let logoRow = new HorizontalSizer;
      logoRow.spacing = 8;
      logoRow.addStretch();
      let logoFile = File.extractDirectory( #__FILE__ ) + "/GraXpertLocal-logo.png";
      if ( File.exists( logoFile ) )
      {
         let logo = new Bitmap( logoFile );
         let logoView = new Control( this );
         logoView.setScaledFixedSize( 40, 40 );
         logoView.onPaint = function()
         {
            let g = new Graphics( this );
            g.smoothInterpolation = true;
            g.drawScaledBitmap( this.boundsRect, logo );
            g.end();
         };
         logoRow.add( logoView );
      }
      let logoText = new Label( this );
      logoText.text = "GraXpert";
      let logoFont = logoText.font;
      logoFont.bold = true;
      logoFont.pointSize = 1.8*logoFont.pointSize;
      logoText.font = logoFont;
      logoRow.add( logoText );
      logoRow.addStretch();
      this.sizer.add( logoRow );

      this.sizer.add( row( this, "Target:", this.viewList ) );
      this.sizer.add( row( this, "GraXpert:", this.exeSizer ) );
      this.sizer.add( row( this, "Operation:", this.commandCombo ) );
      this.sizer.add( this.modelRow );
      this.sizer.add( this.gridGroup );
      this.sizer.add( this.aiBgeGroup );
      this.sizer.add( this.sfGroup );
      this.sizer.add( this.bgOptGroup );
      this.sizer.add( this.dnGroup );
      this.sizer.add( this.globalGroup );
      this.sizer.add( this.toolsGroup );
      this.sizer.add( buttons );

      this.onClose = () => { preview.close(); full.close(); };
      this.setMinWidth( 520 );
      this.updateVisibility();
   }
};

// ---------------------------------------------------------------------------

function run( p, view )
{
   try
   {
      execute( p, view );
      console.noteln( TITLE + ": done on " + view.fullId );
   }
   catch ( e )
   {
      console.criticalln( TITLE + ": " + e.message );
      if ( !( e instanceof AbortError ) && !Parameters.isViewTarget )
         new MessageBox( e.message, TITLE ).execute();
   }
}

function main()
{
   console.show();
   let p = new Params;

   // Instance dropped on an image: run headless with the stored parameters.
   if ( Parameters.isViewTarget )
   {
      p.load();
      p.importParameters();
      run( p, Parameters.targetView );
      return;
   }

   if ( Parameters.isGlobalTarget )
      p.importParameters();
   else
      p.load();

   for ( ;; )
   {
      let dialog = new GraXpertLocalDialog( p );
      let ok = dialog.execute();
      if ( dialog.resetRequested )
      {
         p.reset();
         continue;
      }
      p.save();
      if ( !ok )
         return;
      run( p, dialog.viewList.currentView );
      return;
   }
}

main();
